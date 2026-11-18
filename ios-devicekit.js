"use strict";

const { pipeline } = require("node:stream/promises");
const { openIosPort, iosRequest } = require("./ios-transport");

const DEVICEKIT_PACKAGE = "/ios-tools/devicekit-ios-runner-0.0.18-system-xctest-unsigned.ipa";

function createDeviceKitControl({ openPort = openIosPort } = {}) {
    const sessions = new Map(), pending = new Map(), streams = new Map();
    let requestId = 0;

    function state(id) {
        const session = sessions.get(id);
        return { connected: Boolean(session), width: session?.width || null, height: session?.height || null,
            locked: session?.locked ?? null, backend: "devicekit", streamFormats: ["h264", "mjpeg"], packageUrl: DEVICEKIT_PACKAGE };
    }

    async function request(id, route, options = {}) {
        return iosRequest(id, route, { ...options, port: 12004, openPort, serviceName: "DeviceKit" });
    }

    async function rpc(id, method, params = {}) {
        const sequence = ++requestId;
        const connection = await request(id, "/rpc", { method: "POST", body: { jsonrpc: "2.0", id: sequence, method, params } });
        try {
            const chunks = [];
            let size = 0;
            for await (const chunk of connection.response) {
                size += chunk.length;
                if (size > 24 * 1024 * 1024) { throw new Error("DeviceKit 响应超过大小限制"); }
                chunks.push(chunk);
            }
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch { throw new Error("DeviceKit 未返回有效的控制响应"); }
            if (connection.response.statusCode >= 400 || body.error) {
                const message = body.error?.message || `DeviceKit 请求失败 (${connection.response.statusCode})`;
                if (/\bDeviceLocked\b|BSErrorCodeDescription\s*=\s*Locked\b|reason:\s*Locked\b|device (?:is |was |remains )?(?:still )?locked\b|device was not, or could not be, unlocked/i.test(message)) {
                    const session = sessions.get(id);
                    if (session) { session.locked = true; }
                    throw Object.assign(new Error("iPhone 已锁定，请点击“唤醒”，并在手机上通过面容 ID 或密码解锁。"), {
                        statusCode: 423, code: "IOS_DEVICE_LOCKED", locked: true });
                }
                throw new Error(String(message).slice(0, 600));
            }
            if (body.jsonrpc !== "2.0" || body.id !== sequence || !Object.hasOwn(body, "result")) {
                throw new Error("DeviceKit 控制响应与当前请求不匹配");
            }
            return body.result;
        } finally { connection.close(); }
    }

    function requireSession(id) {
        const session = sessions.get(id);
        if (!session) { throw new Error("请先安装、启动 DeviceKit，然后点击“连接画面”"); }
        return session;
    }

    async function refreshSize(id, session) {
        const info = await rpc(id, "device.info");
        const size = info?.screenSize;
        if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) ||
            size.width < 1 || size.height < 1 || size.width > 10000 || size.height > 10000) {
            throw new Error("DeviceKit 未返回有效的屏幕尺寸");
        }
        session.width = size.width; session.height = size.height;
    }

    async function connect(id) {
        if (pending.has(id)) { return pending.get(id); }
        const work = (async () => {
            if (!sessions.has(id) && sessions.size + pending.size >= 16) { throw new Error("同时连接的 iPhone 控制会话已达到上限"); }
            const connection = await request(id, "/health");
            try {
                if (connection.response.statusCode !== 200) { throw new Error("DeviceKit 测试服务尚未就绪"); }
            } finally { connection.close(); }
            const session = {};
            await refreshSize(id, session);
            sessions.set(id, session);
            return state(id);
        })();
        pending.set(id, work);
        try { return await work; } finally { pending.delete(id); }
    }

    async function disconnect(id) {
        await pending.get(id)?.catch(() => {});
        sessions.delete(id);
        for (const response of streams.get(id) || []) { response.destroy(); }
        return state(id);
    }

    async function action(id, body) {
        const session = requireSession(id);
        function point(x, y) {
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= session.width || y >= session.height) {
                throw new Error("操作位置超出当前屏幕，请刷新画面尺寸");
            }
            return { x: Math.min(session.width - 1, Math.round(x)), y: Math.min(session.height - 1, Math.round(y)) };
        }
        if (body.action === "tap" || body.action === "hold") {
            const position = point(body.x, body.y);
            await rpc(id, body.action === "hold" ? "device.io.longpress" : "device.io.tap", {
                ...position, ...(body.action === "hold" ? { duration: 0.8 } : {}) });
        } else if (body.action === "swipe") {
            const start = point(body.fromX, body.fromY), end = point(body.toX, body.toY);
            // DeviceKit 0.0.18 takes x1/y1/x2/y2 and fixes duration to 0.1s.
            await rpc(id, "device.io.swipe", { x1: start.x, y1: start.y, x2: end.x, y2: end.y });
        } else if (body.action === "text") {
            if (typeof body.text !== "string" || !body.text || body.text.length > 2000 || body.text.includes("\0")) {
                throw new Error("请输入 1–2000 个字符");
            }
            await rpc(id, "device.io.text", { text: body.text });
        } else if (body.action === "home" || body.action === "wake") {
            await rpc(id, "device.io.button", { button: "home" });
            return { ok: true, ...state(id), message: "已发送 Home 按键；若仍显示锁屏，请在手机上通过面容 ID 或密码解锁。" };
        } else if (body.action === "resize") { await refreshSize(id, session); }
        else { throw new Error("未知 iPhone 画面操作"); }
        // DeviceKit 0.0.18 has no lock-state API. A successful input does not
        // prove that authentication completed, so leave the state unknown.
        if (["tap", "hold", "swipe", "text"].includes(body.action)) { session.locked = null; }
        return { ok: true, ...state(id) };
    }

    async function frame(id) {
        requireSession(id);
        const result = await rpc(id, "device.screenshot", { format: "jpeg" });
        const encoded = typeof result === "string" ? result : result?.data;
        if (typeof encoded !== "string" || encoded.length > 24 * 1024 * 1024) { throw new Error("DeviceKit 未返回有效截图"); }
        const data = Buffer.from(encoded.replace(/^data:image\/(?:jpeg|png);base64,/, ""), "base64");
        if (data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") { return { data, contentType: "image/png" }; }
        if (data.subarray(0, 3).toString("hex") === "ffd8ff") { return { data, contentType: "image/jpeg" }; }
        throw new Error("DeviceKit 截图格式不支持，请重新连接画面");
    }

    async function stream(id, response, { format = "mjpeg" } = {}) {
        requireSession(id);
        if (!["h264", "mjpeg"].includes(format)) { throw new Error("不支持的 DeviceKit 视频格式"); }
        const active = streams.get(id) || new Set();
        if (active.size >= 2) { throw new Error("此设备的画面连接已达到上限"); }
        active.add(response); streams.set(id, active);
        let connection;
        const close = () => connection?.close();
        response.once("close", close);
        try {
            const route = format === "h264" ? "/h264?fps=30&bitrate=2000000&quality=60&scale=50" : "/mjpeg?fps=30&quality=45&scale=50";
            connection = await request(id, route);
            if (response.destroyed) { return; }
            const type = connection.response.headers["content-type"] || "";
            if (connection.response.statusCode !== 200 || !(format === "h264" ? /^video\/h264\b/i : /^multipart\/x-mixed-replace\b/i).test(type)) {
                throw new Error("DeviceKit 视频通道不可用，将尝试其他显示方式");
            }
            response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
            await pipeline(connection.response, response);
        } finally {
            connection?.close(); response.removeListener("close", close);
            active.delete(response); if (!active.size) { streams.delete(id); }
        }
    }

    function closeAll() {
        for (const active of streams.values()) { for (const response of active) { response.destroy(); } }
        streams.clear(); sessions.clear();
    }
    return { state, status: async id => state(id), connect, disconnect, action, frame, stream, closeAll };
}

module.exports = { createDeviceKitControl, DEVICEKIT_PACKAGE };
