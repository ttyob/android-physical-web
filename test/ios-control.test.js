"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const { once } = require("node:events");
const { parsePlist } = require("../ios");
const { openIosPort } = require("../ios-transport");
const { createIosApi } = require("../ios-api");
const { createDeviceKitControl } = require("../ios-devicekit");

const phones = ["00008110-000A001122334455", "00008120-000B001122334455"];
const ids = phones.map(udid => `ios://local/${udid}`);
const calls = [], addresses = [], sockets = new Set();
const png = Buffer.from("89504e470d0a1a0a", "hex");
let mux, port, control;
let refusePort = false;
let rpcFailure;

function testOpenPort(id, targetPort) {
    return openIosPort(id, targetPort, {
        connect(address) { addresses.push(address); return net.createConnection({ host: "127.0.0.1", port }); }
    });
}

function xml(value) {
    if (Array.isArray(value)) { return `<array>${value.map(xml).join("")}</array>`; }
    if (typeof value === "object") { return `<dict>${Object.entries(value).map(([key, value]) => `<key>${key}</key>${xml(value)}`).join("")}</dict>`; }
    return typeof value === "number" ? `<integer>${value}</integer>` : `<string>${value}</string>`;
}

function reply(socket, tag, value) {
    const payload = Buffer.from(`<?xml version="1.0"?><plist version="1.0">${xml(value)}</plist>`);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(payload.length + 16); header.writeUInt32LE(1, 4); header.writeUInt32LE(8, 8); header.writeUInt32LE(tag, 12);
    // Deliberately split a frame: real USB/TCP packets do not preserve message boundaries.
    socket.write(header.subarray(0, 7)); socket.write(Buffer.concat([header.subarray(7), payload]));
}

before(async () => {
    const backend = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) { chunks.push(chunk); }
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const device = request.socket.phone;
        calls.push({ device, port: request.socket.devicePort, path: request.url, method: request.method, body });
        if (request.url === "/health") { response.end("OK"); return; }
        if (request.url.startsWith("/h264?")) {
            response.writeHead(200, { "Content-Type": "video/h264" });
            response.write(Buffer.from([0, 0, 0, 1, 0x67, device])); return;
        }
        if (request.url.startsWith("/mjpeg?")) {
            response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
            response.write("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n"); return;
        }
        let result = { success: true };
        if (body.method === "device.info") { result = { screenSize: { width: device === 1 ? 390 : 320, height: device === 1 ? 844 : 568 }, scale: 3 }; }
        if (body.method === "device.screenshot") { result = { format: "png", data: "data:image/png;base64," + png.toString("base64") }; }
        const reply = { jsonrpc: "2.0", id: body.id, result };
        if (body.method === "device.io.swipe" && !["x1", "y1", "x2", "y2"].every(key => Number.isInteger(body.params?.[key]))) {
            delete reply.result; reply.error = { code: -32602, message: "Invalid parameters: x1/y1/x2/y2 required by DeviceKit 0.0.18" };
        }
        if (rpcFailure) {
            const error = rpcFailure; rpcFailure = null;
            if (error.wrongId) { reply.id++; }
            if (error.message) { delete reply.result; reply.error = { code: -32603, message: error.message }; }
        }
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(reply)); return;
    });
    mux = net.createServer(socket => {
        sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
        let buffer = Buffer.alloc(0);
        function data(chunk) {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 16 || buffer.length < buffer.readUInt32LE(0)) { return; }
            const length = buffer.readUInt32LE(0), tag = buffer.readUInt32LE(12);
            const request = parsePlist(buffer.subarray(16, length).toString());
            buffer = buffer.subarray(length);
            if (request.MessageType === "ListDevices") {
                reply(socket, tag, { DeviceList: phones.map((udid, index) => ({ DeviceID: index + 1,
                    Properties: { SerialNumber: udid, ConnectionType: "USB" } })) });
            } else if (request.MessageType === "Connect") {
                assert.ok([1, 2].includes(request.DeviceID));
                const devicePort = ((request.PortNumber & 255) << 8) | (request.PortNumber >> 8);
                assert.equal(devicePort, 12004);
                reply(socket, tag, { MessageType: "Result", Number: refusePort ? 3 : 0 });
                if (refusePort) { return; }
                socket.removeListener("data", data);
                socket.phone = request.DeviceID; socket.devicePort = devicePort;
                backend.emit("connection", socket);
            } else { throw new Error("unexpected usbmuxd message"); }
        }
        socket.on("data", data);
    });
    mux.listen(0, "127.0.0.1"); await once(mux, "listening"); port = mux.address().port;
    control = createDeviceKitControl({ openPort: testOpenPort });
});

after(async () => { control.closeAll(); for (const socket of sockets) { socket.destroy(); } await new Promise(resolve => mux.close(resolve)); });

test("control is opt-in and input cannot be sent until connected", async () => {
    assert.equal((await control.status(ids[0])).connected, false);
    assert.ok(control.state(ids[0]).packageUrl.endsWith("-unsigned.ipa"));
    await assert.rejects(control.action(ids[0], { action: "tap", x: 1, y: 2 }), /先安装/);
    await assert.rejects(control.frame(ids[0]), /先安装/);
    assert.equal(calls.length, 0);
});

test("fragmented USB replies and remote servers keep each phone isolated", async () => {
    const states = await Promise.all(ids.map(id => control.connect(id)));
    assert.deepEqual(states.map(state => [state.width, state.height]), [[390, 844], [320, 568]]);
    assert.ok(addresses.every(address => address.path === "/run/usbmuxd"));
    const remoteId = `ios://[::1]:27015/${phones[0]}`;
    const start = addresses.length;
    await control.connect(remoteId);
    assert.ok(addresses.slice(start).every(address => address.host === "::1" && address.port === 27015));
    await control.disconnect(remoteId);
    assert.equal(control.state(ids[0]).connected, true);
    assert.equal((await control.frame(ids[0])).contentType, "image/png");
    await control.disconnect(ids[0]);
    assert.equal(control.state(ids[1]).connected, true);
    await assert.rejects(control.action(ids[0], { action: "home" }), /先安装/);
});

test("disconnecting during connection leaves that phone disconnected", async () => {
    const id = `ios://pending.test:27015/${phones[0]}`;
    await Promise.all([control.connect(id), control.disconnect(id)]);
    assert.equal(control.state(id).connected, false);
    assert.equal(control.state(ids[1]).connected, true);
});

test("an unavailable phone service returns an actionable error without a partial session", async () => {
    refusePort = true;
    try { await assert.rejects(control.connect(ids[0]), /DeviceKit 服务未启动/); }
    finally { refusePort = false; }
    assert.equal(control.state(ids[0]).connected, false);
    assert.equal(control.state(ids[1]).connected, true);
});

test("DeviceKit connects through each selected UDID and validates input before sending JSON-RPC", async () => {
    const devicekit = createDeviceKitControl({ openPort: testOpenPort });
    try {
        const before = calls.length;
        assert.equal((await devicekit.status(ids[0])).connected, false);
        await assert.rejects(devicekit.action(ids[0], { action: "home" }), /先安装/);
        assert.equal(calls.length, before);
        const states = await Promise.all(ids.map(id => devicekit.connect(id)));
        assert.deepEqual(states.map(s => [s.backend, s.width, s.height]), [["devicekit", 390, 844], ["devicekit", 320, 568]]);
        await devicekit.action(ids[0], { action: "tap", x: 10.2, y: 20.8 });
        await devicekit.action(ids[1], { action: "swipe", fromX: 20, fromY: 400, toX: 20, toY: 40 });
        await devicekit.action(ids[0], { action: "hold", x: 12, y: 24 });
        await devicekit.action(ids[1], { action: "text", text: "中文🙂" });
        const operations = calls.slice(before).filter(c => c.body?.method?.startsWith("device.io."));
        assert.deepEqual(operations.map(c => [c.device, c.body.method]), [[1, "device.io.tap"], [2, "device.io.swipe"], [1, "device.io.longpress"], [2, "device.io.text"]]);
        assert.deepEqual(operations[0].body.params, { x: 10, y: 21 });
        assert.deepEqual(operations[1].body.params, { x1: 20, y1: 400, x2: 20, y2: 40 });
        assert.equal(operations[3].body.params.text, "中文🙂");
        assert.ok(calls.slice(before).every(c => c.port === 12004));
        const sent = calls.length;
        for (const body of [{ action: "tap", x: 390, y: 0 }, { action: "swipe", fromX: 2, fromY: 3, toX: -1, toY: 4 },
            { action: "tap", x: NaN, y: 10 }, { action: "text", text: "\0" }, { action: "shell" }]) {
            await assert.rejects(devicekit.action(ids[0], body));
        }
        assert.equal(calls.length, sent);
    } finally { devicekit.closeAll(); }
});

test("DeviceKit keeps a locked session and rejects mismatched RPC replies without reporting a successful unlock", async () => {
    const devicekit = createDeviceKitControl({ openPort: testOpenPort });
    try {
        await devicekit.connect(ids[0]);
        rpcFailure = { message: "Error Domain=FBSOpenApplicationErrorDomain UserInfo={BSErrorCodeDescription=Locked}" };
        await assert.rejects(devicekit.action(ids[0], { action: "tap", x: 5, y: 5 }), error => error.code === "IOS_DEVICE_LOCKED" && error.statusCode === 423);
        const wake = await devicekit.action(ids[0], { action: "wake" });
        assert.equal(wake.connected, true); assert.equal(wake.locked, true); assert.match(wake.message, /手机上.*解锁/);
        assert.deepEqual(calls.at(-1).body.params, { button: "home" });
        rpcFailure = { wrongId: true };
        await assert.rejects(devicekit.action(ids[0], { action: "home" }), /不匹配/);
        assert.equal(devicekit.state(ids[0]).connected, true);
        assert.equal((await devicekit.frame(ids[0])).contentType, "image/png");
        await devicekit.disconnect(ids[0]);
        await assert.rejects(devicekit.frame(ids[0]), /先安装/);
    } finally { rpcFailure = null; devicekit.closeAll(); }
});

test("DeviceKit H.264 and MJPEG viewers release their USB sockets when the browser leaves", async () => {
    const devicekit = createDeviceKitControl({ openPort: testOpenPort });
    await devicekit.connect(ids[1]);
    const relay = http.createServer((request, response) => {
        devicekit.stream(ids[1], response, { format: request.url.slice(1) }).catch(() => response.destroy());
    });
    relay.listen(0, "127.0.0.1"); await once(relay, "listening");
    try {
        for (const format of ["h264", "mjpeg"]) {
            const abort = new AbortController();
            const response = await fetch(`http://127.0.0.1:${relay.address().port}/${format}`, { signal: abort.signal });
            assert.match(response.headers.get("content-type"), format === "h264" ? /video\/h264/ : /multipart/);
            const first = await response.body.getReader().read();
            assert.ok(first.value.length > 0);
            if (format === "h264") { assert.equal(first.value.at(-1), 2); }
            abort.abort();
            for (let attempt = 0; attempt < 40 && [...sockets].some(socket => socket.devicePort === 12004); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.ok(![...sockets].some(socket => socket.devicePort === 12004));
        }
    } finally { devicekit.closeAll(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
});

test("locked errors cross the HTTP API without losing the wake command or session", async () => {
    await control.connect(ids[0]);
    const api = createIosApi({}, { control, errorMessage: error => error.message,
        json(response, status, value) { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); },
        async readJson(request) { const chunks = []; for await (const chunk of request) { chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks)); }
    });
    const relay = http.createServer((request, response) => api(request, response, new URL(request.url, "http://localhost"), ids[0]));
    relay.listen(0, "127.0.0.1"); await once(relay, "listening");
    const url = `http://127.0.0.1:${relay.address().port}/local-api/device/control`;
    rpcFailure = { message: "Error Domain=FBSOpenApplicationErrorDomain UserInfo={BSErrorCodeDescription=Locked}" };
    try {
        const response = await fetch(url, { method: "POST", body: JSON.stringify({ action: "text", text: "test" }) });
        assert.equal(response.status, 423);
        const body = await response.json();
        assert.equal(body.code, "IOS_DEVICE_LOCKED"); assert.equal(body.locked, true);
        assert.match(body.error, /iPhone 已锁定/); assert.doesNotMatch(body.error, /Error Domain/);
        const home = await fetch(url, { method: "POST", body: JSON.stringify({ action: "wake" }) });
        assert.equal(home.status, 200); assert.equal((await home.json()).connected, true);
    } finally { rpcFailure = null; relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
});
