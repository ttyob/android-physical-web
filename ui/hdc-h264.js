(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) { module.exports = api; }
    else { root.createHdcH264Player = api.createHdcH264Player; }
})(globalThis, function () {
    "use strict";

    const PACKET = { heartbeat: 1, videoConfig: 2, videoFrame: 3, deviceStatus: 0x20 };
    const CODEC = { H264: 0, RAW_RGBA: 1, JPEG: 2 };

    class PacketParser {
        constructor(maxPacket = 12 * 1024 * 1024) { this.buffer = new Uint8Array(); this.maxPacket = maxPacket; }
        push(chunk) {
            const merged = new Uint8Array(this.buffer.length + chunk.length);
            merged.set(this.buffer); merged.set(chunk, this.buffer.length); this.buffer = merged;
            const packets = [];
            while (this.buffer.length >= 8) {
                const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
                const type = view.getUint32(0), length = view.getUint32(4);
                if (length > this.maxPacket) { throw new Error("HAP 数据包超过大小限制"); }
                if (this.buffer.length < 8 + length) { break; }
                packets.push({ type, payload: this.buffer.slice(8, 8 + length) });
                this.buffer = this.buffer.slice(8 + length);
            }
            return packets;
        }
    }

    function parseConfig(payload) {
        if (payload.length < 13) { throw new Error("HAP 视频配置不完整"); }
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const result = { codec: payload[0], width: view.getUint32(1), height: view.getUint32(5), fps: view.getUint32(9),
            sps: new Uint8Array(), pps: new Uint8Array() };
        if (result.codec !== 0) { return result; }
        let offset = 13;
        if (offset + 2 > payload.length) { throw new Error("HAP SPS 长度无效"); }
        const spsLength = view.getUint16(offset); offset += 2;
        if (offset + spsLength > payload.length) { throw new Error("HAP SPS 数据无效"); }
        result.sps = payload.slice(offset, offset + spsLength); offset += spsLength;
        if (offset + 2 > payload.length) { throw new Error("HAP PPS 长度无效"); }
        const ppsLength = view.getUint16(offset); offset += 2;
        if (offset + ppsLength > payload.length) { throw new Error("HAP PPS 数据无效"); }
        result.pps = payload.slice(offset, offset + ppsLength);
        return result;
    }

    function splitAnnexB(data) {
        const nals = []; let start = -1, prefix = 0;
        for (let i = 0; i + 2 < data.length; i++) {
            if (data[i] !== 0 || data[i + 1] !== 0) { continue; }
            const length = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
            if (!length) { continue; }
            if (start >= 0) { nals.push(data.slice(start + prefix, i)); }
            start = i; prefix = length; i += length - 1;
        }
        if (start >= 0 && data.length > start + prefix) { nals.push(data.slice(start + prefix)); }
        return nals;
    }

    function firstSlice(nal) {
        let bit = 8, zeros = 0;
        while (bit < nal.length * 8 && !(nal[bit >> 3] & (1 << (7 - (bit & 7))))) {
            zeros++; bit++; if (zeros > 24) { return false; }
        }
        return zeros === 0;
    }

    class AccessUnits {
        constructor(onUnit, config) { this.onUnit = onUnit; this.sps = config.sps; this.pps = config.pps;
            this.nals = []; this.vcl = false; this.key = false; }
        push(nal) {
            if (!nal.length) { return; }
            const type = nal[0] & 31;
            if (type === 1 || type === 5) {
                if (firstSlice(nal) && this.vcl) { this.finish(); }
                this.vcl = true; this.key ||= type === 5;
            } else if ([6, 7, 8, 9, 14, 15, 16, 17, 18].includes(type) && this.vcl) { this.finish(); }
            if (type === 7) { this.sps = nal; }
            if (type === 8) { this.pps = nal; }
            this.nals.push(nal);
        }
        finish() {
            if (this.vcl && this.sps.length && this.pps.length) {
                const filtered = this.nals.filter(nal => ![7, 8].includes(nal[0] & 31));
                const items = this.key ? [this.sps, this.pps, ...filtered] : filtered;
                const size = items.reduce((total, nal) => total + 4 + nal.length, 0);
                const data = new Uint8Array(size); let offset = 0;
                for (const nal of items) { data.set([0, 0, 0, 1], offset); data.set(nal, offset + 4); offset += 4 + nal.length; }
                this.onUnit({ data, key: this.key, sps: this.sps });
            }
            this.nals = []; this.vcl = false; this.key = false;
        }
    }

    function createHdcH264Player({ canvas, onFrame = () => {}, onConfig = () => {}, onError = () => {}, onDebug = () => {} }) {
        let socket = null, decoder = null, units = null, config = null, needKey = true, generation = 0;
        let handshakeResolve = null, handshakeReject = null, firstFrameResolve = null, firstFrameReject = null;
        let firstFrameSettled = false, configSettled = false, imagePending = false;

        function settleFirstFrame(error) {
            if (firstFrameSettled) { return; }
            firstFrameSettled = true;
            if (error) { firstFrameReject?.(error); } else { firstFrameResolve?.(); }
            firstFrameResolve = null; firstFrameReject = null;
        }

        function resizeCanvas(width, height) {
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width; canvas.height = height;
            }
        }

        async function drawJpeg(payload, token) {
            if (imagePending) { return; }
            imagePending = true;
            try {
                const bytes = payload.slice(9);
                if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
                    throw new Error("HAP 返回的 JPEG 帧无效");
                }
                const context = canvas.getContext("2d", { alpha: false });
                let bitmap;
                if (typeof createImageBitmap === "function") {
                    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
                } else {
                    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
                    try {
                        const image = new Image();
                        image.src = objectUrl;
                        await image.decode();
                        bitmap = image;
                    } finally { URL.revokeObjectURL(objectUrl); }
                }
                try {
                    if (token !== generation) { return; }
                    resizeCanvas(bitmap.width, bitmap.height);
                    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                    onDebug(`HAP JPEG 首帧 ${bitmap.width}×${bitmap.height}，${bytes.length} 字节`);
                    onFrame({ width: bitmap.width, height: bitmap.height });
                } finally { bitmap.close?.(); }
                settleFirstFrame();
            } catch (error) {
                settleFirstFrame(error);
                if (token === generation) { onError(error); }
            } finally { imagePending = false; }
        }

        async function start(url) {
            stop();
            const token = generation;
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) { throw new Error("浏览器无法绘制视频画面"); }
            let frameIndex = 0;
            socket = new WebSocket(url); socket.binaryType = "arraybuffer";
            const parser = new PacketParser(12 * 1024 * 1024 + 16 * 1024 * 1024 + 64 * 1024);
            const handshake = new Promise((resolve, reject) => {
                handshakeResolve = resolve; handshakeReject = reject;
            });
            firstFrameSettled = false;
            const firstFrame = new Promise((resolve, reject) => {
                firstFrameResolve = resolve; firstFrameReject = reject;
            });
            const connectionTimeout = setTimeout(() => {
                handshakeReject?.(new Error("HAP 视频连接超时"));
            }, 10000);
            const finishHandshake = error => {
                clearTimeout(connectionTimeout);
                if (error) { handshakeReject?.(error); } else { handshakeResolve?.(); }
                handshakeResolve = null; handshakeReject = null;
            };
            const finish = error => {
                finishHandshake(error);
                settleFirstFrame(error || new Error("HAP 视频连接已关闭"));
            };
            socket.onopen = () => {};
            socket.onerror = () => finish(new Error("HAP 视频连接失败"));
            socket.onclose = event => {
                if (token === generation) {
                    const reason = new Error(event.reason || "HAP 视频连接已关闭");
                    finish(reason);
                    if (configSettled) { onError(reason); }
                }
            };
            socket.onmessage = event => {
                if (token !== generation) { return; }
                try {
                    const data = new Uint8Array(event.data);
                    let packetData = data;
                    if (data.length >= 1 && data[0] === 1) {
                        finishHandshake();
                        if (data.length === 1) { return; }
                        packetData = data.subarray(1);
                    }
                    for (const packet of parser.push(packetData)) {
                        if (packet.type === PACKET.videoConfig) {
                            const next = parseConfig(packet.payload);
                            if (!next.width || !next.height) { throw new Error("HAP 视频尺寸无效"); }
                            onDebug(`HAP 视频配置：codec=${next.codec} ${next.width}×${next.height}@${next.fps}`);
                            if (next.codec === CODEC.H264) {
                                if (typeof VideoDecoder !== "function") { throw new Error("浏览器不支持 H.264 解码"); }
                                if (typeof EncodedVideoChunk !== "function") { throw new Error("浏览器不支持实时视频解码"); }
                                if (!next.sps.length || !next.pps.length) { throw new Error("HAP H.264 参数不完整"); }
                                if (decoder && decoder.state !== "closed") { decoder.close(); }
                                decoder = new VideoDecoder({
                                    output(frame) {
                                        try {
                                            if (token !== generation) { return; }
                                            resizeCanvas(frame.displayWidth, frame.displayHeight);
                                            context.drawImage(frame, 0, 0, canvas.width, canvas.height);
                                            onFrame({ width: frame.displayWidth, height: frame.displayHeight });
                                            settleFirstFrame();
                                        } finally { frame.close(); }
                                    },
                                    error(error) { if (token === generation) { settleFirstFrame(error); onError(error); } }
                                });
                                decoder.addEventListener?.("dequeue", () => {
                                    if (token !== generation) { return; }
                                    if (decoder?.decodeQueueSize > 5) {
                                        decoder.reset(); needKey = true;
                                        if (config) {
                                            const codec = "avc1." + Array.from(config.sps.slice(1, 4), byte => byte.toString(16).padStart(2, "0")).join("");
                                            decoder.configure({ codec, optimizeForLatency: true });
                                        }
                                    }
                                });
                                const codec = "avc1." + Array.from(next.sps.slice(1, 4), byte => byte.toString(16).padStart(2, "0")).join("");
                                decoder.configure({ codec, optimizeForLatency: true });
                                units = new AccessUnits(unit => {
                                    if (needKey && !unit.key) { return; }
                                    decoder.decode(new EncodedVideoChunk({ type: unit.key ? "key" : "delta", timestamp: frameIndex++ * 33333, data: unit.data }));
                                    needKey = false;
                                }, next); needKey = true;
                            } else if (next.codec === CODEC.JPEG) {
                                if (typeof createImageBitmap !== "function" && typeof Image !== "function") {
                                    throw new Error("浏览器不支持 JPEG 实时解码");
                                }
                                units = null;
                                if (decoder && decoder.state !== "closed") { decoder.close(); decoder = null; }
                            } else {
                                throw new Error("HAP 返回了浏览器无法承载的 RAW 视频");
                            }
                            config = next; configSettled = true; onConfig(next);
                        } else if (packet.type === PACKET.videoFrame && config) {
                            if (config.codec === CODEC.H264 && units) {
                                for (const nal of splitAnnexB(packet.payload.slice(9))) { units.push(nal); }
                            } else if (config.codec === CODEC.JPEG) {
                                drawJpeg(packet.payload, token);
                            }
                        }
                    }
                } catch (error) { finish(error); }
            };
            await handshake;
            if (token !== generation) { throw new Error("HAP 视频连接已取消"); }
            return { close: stop, firstFrame };
        }
        function stop() {
            generation++;
            handshakeReject?.(new Error("HAP 视频连接已取消"));
            settleFirstFrame(new Error("HAP 视频连接已取消"));
            handshakeResolve = handshakeReject = firstFrameResolve = firstFrameReject = null;
            if (socket) {
                socket.onopen = null; socket.onclose = null; socket.onerror = null; socket.onmessage = null;
                socket.close(); socket = null;
            }
            if (decoder && decoder.state !== "closed") { decoder.close(); decoder = null; }
            units = null; config = null; configSettled = false; imagePending = false;
        }
        function control(message) {
            if (socket?.readyState === WebSocket.OPEN) { socket.send(message); return true; }
            return false;
        }
        return { start, stop, control, get config() { return config; } };
    }

    return { PACKET, CODEC, PacketParser, parseConfig, splitAnnexB, AccessUnits, createHdcH264Player };
});
