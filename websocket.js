"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class WebSocketConnection extends EventEmitter {
    constructor(socket, head = Buffer.alloc(0)) {
        super();
        this.socket = socket;
        this.readyState = OPEN;
        this.buffer = Buffer.alloc(0);
        this.fragments = null;
        this.fragmentOpcode = 0;
        socket.setNoDelay(true);
        socket.on("data", chunk => this.receive(chunk));
        socket.on("close", () => this.finish(1006, ""));
        socket.on("error", error => this.emit("error", error));
        socket.on("end", () => this.close(1000));
        if (head.length) { this.receive(head); }
    }

    receive(chunk) {
        if (this.readyState === CLOSED) { return; }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        try {
            while (this.buffer.length >= 2) {
                const first = this.buffer[0];
                const second = this.buffer[1];
                const masked = Boolean(second & 0x80);
                let length = second & 0x7f;
                let offset = 2;
                if (!masked) { throw new Error("WebSocket 客户端帧必须编码"); }
                if (length === 126) {
                    if (this.buffer.length < 4) { return; }
                    length = this.buffer.readUInt16BE(2); offset = 4;
                } else if (length === 127) {
                    if (this.buffer.length < 10) { return; }
                    const value = this.buffer.readBigUInt64BE(2);
                    if (value > 12n * 1024n * 1024n) { throw new Error("WebSocket 数据包过大"); }
                    length = Number(value); offset = 10;
                }
                if (length > 12 * 1024 * 1024) { throw new Error("WebSocket 数据包过大"); }
                if (this.buffer.length < offset + 4 + length) { return; }
                const mask = this.buffer.subarray(offset, offset + 4); offset += 4;
                const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
                for (let index = 0; index < payload.length; index += 1) { payload[index] ^= mask[index & 3]; }
                this.buffer = this.buffer.subarray(offset + length);
                this.frame(first, payload);
            }
        } catch (error) {
            this.close(1002, error.message);
        }
    }

    frame(first, payload) {
        const fin = Boolean(first & 0x80);
        const opcode = first & 0x0f;
        if (opcode === 8) { this.close(1000); return; }
        if (opcode === 9) { this.sendFrame(10, payload); return; }
        if (opcode === 10) { return; }
        if (opcode === 0) {
            if (!this.fragments) { throw new Error("WebSocket 分片顺序无效"); }
            this.fragments.push(payload);
            if (fin) {
                const data = Buffer.concat(this.fragments);
                const type = this.fragmentOpcode;
                this.fragments = null; this.fragmentOpcode = 0;
                this.deliver(type, data);
            }
            return;
        }
        if (opcode !== 1 && opcode !== 2) { throw new Error("WebSocket 帧类型无效"); }
        if (fin) { this.deliver(opcode, payload); return; }
        this.fragments = [payload]; this.fragmentOpcode = opcode;
    }

    deliver(opcode, data) {
        let binary = opcode === 2;
        if (!binary) {
            if (!isValidUtf8(data)) { throw new Error("WebSocket 文本编码无效"); }
            data = data.toString("utf8");
            binary = false;
        }
        this.emit("message", data, binary);
    }

    send(data, options = {}) {
        const binary = options.binary ?? (typeof data !== "string");
        return this.sendFrame(binary ? 2 : 1, binary ? Buffer.from(data) : Buffer.from(String(data)));
    }

    sendFrame(opcode, data) {
        if (this.readyState !== OPEN) { return false; }
        if (data.length > 12 * 1024 * 1024) { throw new Error("WebSocket 数据包过大"); }
        let header;
        if (data.length < 126) {
            header = Buffer.from([0x80 | opcode, data.length]);
        } else if (data.length < 65536) {
            header = Buffer.allocUnsafe(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2);
        } else {
            header = Buffer.allocUnsafe(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
        }
        this.socket.write(Buffer.concat([header, data]));
        return true;
    }

    close(code = 1000, reason = "") {
        if (this.readyState === CLOSED || this.readyState === CLOSING) { return; }
        this.readyState = CLOSING;
        if (code !== 1000 || reason) {
            const message = Buffer.from(String(reason).slice(0, 120));
            const payload = Buffer.allocUnsafe(2 + message.length);
            payload.writeUInt16BE(code, 0); message.copy(payload, 2);
            this.sendFrame(8, payload);
        }
        this.socket.end();
        this.finish(code, String(reason));
    }

    finish(code, reason) {
        if (this.readyState === CLOSED) { return; }
        this.readyState = CLOSED;
        this.emit("close", { code, reason });
    }
}

class WebSocketServer extends EventEmitter {
    constructor() { super(); }

    handleUpgrade(request, socket, head, callback) {
        const key = request.headers["sec-websocket-key"];
        const version = request.headers["sec-websocket-version"];
        const upgrade = String(request.headers.upgrade || "").toLowerCase();
        if (String(request.headers.connection || "").toLowerCase().split(/\s*,\s*/).includes("upgrade") === false ||
            upgrade !== "websocket" || !key || version !== "13") {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        callback(new WebSocketConnection(socket, head));
    }

    close() {}
}

function isValidUtf8(buffer) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(buffer); return true; } catch { return false; }
}

WebSocketServer.OPEN = OPEN;
WebSocketServer.CONNECTING = 0;
module.exports = WebSocketServer;
