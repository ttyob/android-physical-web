(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) { module.exports = api; }
    else { root.createIosH264Player = api.createIosH264Player; }
})(globalThis, function () {
    "use strict";

    // HTTP chunks can split a start code or contain several NAL units.
    class AnnexBParser {
        constructor(onNal) { this.onNal = onNal; this.buffer = new Uint8Array(); }
        push(chunk) {
            const bytes = new Uint8Array(this.buffer.length + chunk.length);
            bytes.set(this.buffer); bytes.set(chunk, this.buffer.length);
            let start = -1, prefix = 0;
            for (let i = 0; i + 2 < bytes.length; i++) {
                if (bytes[i] !== 0 || bytes[i + 1] !== 0) { continue; }
                const length = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
                if (!length) { continue; }
                if (start >= 0 && i > start + prefix) { this.onNal(bytes.slice(start + prefix, i)); }
                start = i; prefix = length; i += length - 1;
            }
            this.buffer = start >= 0 ? bytes.slice(start) : bytes;
            if (this.buffer.length > 4 * 1024 * 1024) { throw new Error("H.264 视频数据无效"); }
        }
        finish() {
            const bytes = this.buffer;
            const prefix = bytes[2] === 1 ? 3 : bytes[3] === 1 ? 4 : 0;
            if (prefix && bytes.length > prefix) { this.onNal(bytes.slice(prefix)); }
            this.buffer = new Uint8Array();
        }
    }

    function firstSlice(nal) {
        let bit = 8, zeros = 0;
        while (bit < nal.length * 8 && !(nal[bit >> 3] & (1 << (7 - (bit & 7))))) {
            zeros++; bit++;
            if (zeros > 24) { throw new Error("H.264 帧头无效"); }
        }
        if (bit >= nal.length * 8) { throw new Error("H.264 帧头不完整"); }
        // first_mb_in_slice == 0 is encoded as the single bit 1. No other
        // Exp-Golomb values need to be decoded to recognize a frame boundary.
        return zeros === 0;
    }

    class H264AccessUnits {
        constructor(onUnit) { this.onUnit = onUnit; this.items = []; this.sps = null; this.pps = null; this.vcl = false; this.key = false; this.bytes = 0; }
        push(nal) {
            if (!nal.length) { return; }
            const type = nal[0] & 31;
            if (type === 1 || type === 5) {
                if (firstSlice(nal) && this.vcl) { this.finish(); }
                this.vcl = true; this.key ||= type === 5;
            } else if ([6, 7, 8, 9, 14, 15, 16, 17, 18].includes(type)) {
                if (this.vcl) { this.finish(); }
            } else if (type === 10 || type === 11) { this.finish(); return; }
            if (type === 7) { this.sps = nal; }
            if (type === 8) { this.pps = nal; }
            this.items.push(nal); this.bytes += nal.length;
            if (this.bytes > 8 * 1024 * 1024) { throw new Error("H.264 视频帧超过大小限制"); }
        }
        finish() {
            if (this.vcl && this.sps && this.pps) {
                const items = this.key ? [this.sps, this.pps, ...this.items.filter(nal => ![7, 8].includes(nal[0] & 31))] : this.items;
                const data = new Uint8Array(items.reduce((size, nal) => size + 4 + nal.length, 0));
                let offset = 0;
                for (const nal of items) { data.set([0, 0, 0, 1], offset); data.set(nal, offset + 4); offset += 4 + nal.length; }
                this.onUnit({ data, key: this.key, sps: this.sps });
            }
            this.items = []; this.vcl = false; this.key = false; this.bytes = 0;
        }
    }

    function createIosH264Player({ canvas, onFrame = () => {} }) {
        let generation = 0, activeAbort, activeDecoder;

        function stop() {
            generation++;
            activeAbort?.abort(); activeAbort = null;
            if (activeDecoder && activeDecoder.state !== "closed") { activeDecoder.close(); }
            activeDecoder = null;
        }

        async function start(url) {
            stop();
            const token = generation;
            const abort = new AbortController(); activeAbort = abort;
            let decoder, reader, failure, config, spsSignature, needKey = true, frameIndex = 0;
            let frameCount = 0, lastReport = performance.now(), reported = false;
            try {
                if (typeof VideoDecoder !== "function") { throw new Error("浏览器不支持 H.264 解码"); }
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) { throw new Error("浏览器无法绘制视频画面"); }
                decoder = new VideoDecoder({
                    output(frame) {
                        try {
                            if (token !== generation) { return; }
                            const resized = canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight;
                            if (resized) {
                                canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
                            }
                            context.drawImage(frame, 0, 0, canvas.width, canvas.height);
                            frameCount++;
                            const now = performance.now();
                            if (!reported || resized || now - lastReport >= 1000) {
                                onFrame({ width: frame.displayWidth, height: frame.displayHeight,
                                    fps: reported ? Math.round(frameCount * 1000 / (now - lastReport)) : null });
                                reported = true; lastReport = now; frameCount = 0;
                            }
                        } finally { frame.close(); }
                    },
                    error(error) { failure = error; abort.abort(); }
                });
                activeDecoder = decoder;
                const units = new H264AccessUnits(unit => {
                    if (token !== generation || failure) { return; }
                    const signature = Array.from(unit.sps).join(",");
                    if (signature !== spsSignature) {
                        if (unit.sps.length < 4) { throw new Error("H.264 编码参数无效"); }
                        const codec = "avc1." + Array.from(unit.sps.subarray(1, 4), byte => byte.toString(16).padStart(2, "0")).join("");
                        config = { codec, optimizeForLatency: true };
                        if (decoder.state === "configured") { decoder.reset(); }
                        decoder.configure(config); spsSignature = signature; needKey = true;
                    }
                    // Resume at a keyframe when decoding falls behind; feeding
                    // dependent frames after dropping data corrupts the picture.
                    if (decoder.decodeQueueSize > 5) { decoder.reset(); decoder.configure(config); needKey = true; }
                    if (needKey && !unit.key) { return; }
                    decoder.decode(new EncodedVideoChunk({ type: unit.key ? "key" : "delta", timestamp: frameIndex++ * 33333, data: unit.data }));
                    needKey = false;
                });
                const parser = new AnnexBParser(nal => units.push(nal));
                const response = await fetch(url, { cache: "no-store", signal: abort.signal });
                if (!response.ok || !/^video\/h264\b/i.test(response.headers.get("Content-Type") || "")) {
                    throw new Error("H.264 视频通道不可用");
                }
                reader = response.body.getReader();
                while (token === generation) {
                    const { value, done } = await reader.read();
                    if (done) { break; }
                    parser.push(value);
                }
                if (token === generation) {
                    parser.finish(); units.finish();
                    throw new Error("H.264 视频连接已结束");
                }
            } catch (error) {
                if (failure) { throw failure; }
                if (token === generation && !abort.signal.aborted) { throw error; }
            } finally {
                await reader?.cancel().catch(() => {});
                if (decoder && decoder.state !== "closed") { decoder.close(); }
                if (token === generation) { activeAbort = null; activeDecoder = null; }
            }
        }
        return { start, stop };
    }

    return { AnnexBParser, H264AccessUnits, createIosH264Player };
});
