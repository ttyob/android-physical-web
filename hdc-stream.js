"use strict";

const PACKET = Object.freeze({ heartbeat: 0x01, videoConfig: 0x02, videoFrame: 0x03, control: 0x10, deviceStatus: 0x20 });
const CONTROL = Object.freeze({ touchDown: 0x01, touchMove: 0x02, touchUp: 0x03, key: 0x10,
    power: 0x11, home: 0x12, back: 0x13, keyEvent: 0x14, text: 0x15 });
const DEVICE_STATUS = Object.freeze({ displayInfo: 0x01 });
const MAX_PACKET = 12 * 1024 * 1024;

function encodePacket(type, payload = Buffer.alloc(0)) {
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(type, 0);
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

function encodeControl(type, body = Buffer.alloc(0)) {
    return encodePacket(PACKET.control, Buffer.concat([Buffer.from([type]), body]));
}

function touchBody(x, y, pointerId = 0) {
    const body = Buffer.allocUnsafe(10);
    body.writeUInt32BE(x, 0);
    body.writeUInt32BE(y, 4);
    body.writeUInt16BE(pointerId, 8);
    return body;
}

function parseVideoConfig(payload) {
    if (payload.length < 13) { throw new Error("HAP 视频配置不完整"); }
    const codec = payload[0];
    const result = { codec, width: payload.readUInt32BE(1), height: payload.readUInt32BE(5), fps: payload.readUInt32BE(9),
        sps: Buffer.alloc(0), pps: Buffer.alloc(0) };
    if (codec !== 0) {
        if (!result.width || !result.height) { throw new Error("HAP 视频尺寸无效"); }
        return result;
    }
    let offset = 13;
    const spsLength = payload.readUInt16BE(offset);
    offset += 2;
    if (offset + spsLength > payload.length) { throw new Error("HAP SPS 数据无效"); }
    result.sps = payload.subarray(offset, offset + spsLength);
    offset += spsLength;
    if (offset + 2 > payload.length) { throw new Error("HAP PPS 长度无效"); }
    const ppsLength = payload.readUInt16BE(offset);
    offset += 2;
    if (offset + ppsLength > payload.length) { throw new Error("HAP PPS 数据无效"); }
    result.pps = payload.subarray(offset, offset + ppsLength);
    return result;
}

function bridgeWebSocket(webSocket, tcpSocket, { onControl, handshake = true } = {}) {
    let open = true;
    let verified = false;
    const challenge = Buffer.allocUnsafe(8);
    challenge.writeBigUInt64BE(BigInt(Date.now()) * 1000n, 0);
    const sendTcp = data => {
        if (!open || !tcpSocket || typeof tcpSocket.write !== "function") { return; }
        tcpSocket.write(data);
    };
    if (handshake) { sendTcp(encodePacket(PACKET.heartbeat, challenge)); }
    const heartbeat = setInterval(() => {
        const payload = Buffer.allocUnsafe(8);
        payload.writeBigUInt64BE(BigInt(Date.now()), 0);
        sendTcp(encodePacket(PACKET.heartbeat, payload));
    }, 10000);
    heartbeat.unref();

    tcpSocket.on("data", data => {
        if (!open) { return; }
        if (!handshake) {
            if (webSocket.readyState === WebSocket.OPEN) { webSocket.send(data, { binary: true }); }
            return;
        }
        // The challenge echo proves the stream is the HAP service. Keep the
        // browser from drawing bytes from an unrelated listener on the port.
        if (!verified) {
            if (data.length >= 16 && data.readUInt32BE(0) === PACKET.heartbeat &&
                data.readUInt32BE(4) === 8 && data.subarray(8, 16).equals(challenge)) {
                verified = true;
                if (webSocket.readyState === WebSocket.OPEN) { webSocket.send(Buffer.from([1])); }
                if (data.length > 16 && webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(data.subarray(16), { binary: true });
                }
            }
            return;
        }
        if (webSocket.readyState === WebSocket.OPEN) { webSocket.send(data, { binary: true }); }
    });
    webSocket.on("message", (data, binary) => {
        if (!binary || !sendTcp) { return; }
        if (typeof tcpSocket.write === "function") { sendTcp(data); }
        try { onControl?.(data); } catch { /* Invalid client input must not terminate video. */ }
    });
    const close = () => {
        if (!open) { return; }
        open = false;
        clearInterval(heartbeat);
        if (tcpSocket && typeof tcpSocket.destroy === "function" && tcpSocket !== webSocket) { tcpSocket.destroy(); }
        if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) { webSocket.close(); }
    };
    tcpSocket.once?.("close", close);
    tcpSocket.once?.("error", close);
    webSocket.once("close", close);
    webSocket.once("error", close);
}

module.exports = { PACKET, CONTROL, DEVICE_STATUS, MAX_PACKET, encodePacket, encodeControl, touchBody,
    parseVideoConfig, bridgeWebSocket };
