"use strict";

const net = require("node:net");
const http = require("node:http");
const { parseIosDevice, parsePlist } = require("./ios");

const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function muxPacket(values, tag) {
    const entries = { ClientVersionString: "physical-web", ProgName: "physical-web", kLibUSBMuxVersion: 3, ...values };
    const body = Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(entries).map(([key, value]) =>
        `<key>${escapeXml(key)}</key>${typeof value === "number" ? `<integer>${value}</integer>` : `<string>${escapeXml(value)}</string>`}`).join("")}</dict></plist>`);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(body.length + 16, 0); header.writeUInt32LE(1, 4);
    header.writeUInt32LE(8, 8); header.writeUInt32LE(tag, 12);
    return Buffer.concat([header, body]);
}

function muxExchange(socket, values, tag) {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        function finish(error, result) {
            socket.removeListener("data", data); socket.removeListener("error", fail); socket.removeListener("close", closed);
            if (error) { reject(error); } else { resolve(result); }
        }
        const fail = error => finish(error);
        const closed = () => fail(new Error("usbmuxd 连接已关闭"));
        function data(chunk) {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 16) { return; }
            const length = buffer.readUInt32LE(0);
            if (length < 16 || length > 2 * 1024 * 1024 || buffer.readUInt32LE(8) !== 8 || buffer.readUInt32LE(12) !== tag) {
                fail(new Error("usbmuxd 返回了无效的数据包")); return;
            }
            if (buffer.length < length) { return; }
            try { finish(null, parsePlist(buffer.subarray(16, length).toString("utf8"))); }
            catch (error) { finish(error); }
        }
        socket.on("data", data); socket.once("error", fail); socket.once("close", closed);
        socket.write(muxPacket(values, tag));
    });
}

// Connect directly through usbmuxd. Each socket selects its service AND UDID;
// no global iproxy port can accidentally refer to a different phone.
async function openIosPort(id, port, { connect = net.createConnection } = {}) {
    const { server, udid } = parseIosDevice(id);
    let address = { path: "/run/usbmuxd" };
    if (server) {
        const url = new URL(`tcp://${server}`);
        address = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) };
    }
    const socket = connect(address);
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(new Error("iPhone USB 通道连接超时")), 5000);
    try {
        if (socket.connecting) {
            await new Promise((resolve, reject) => {
                const done = () => { socket.removeListener("error", failed); resolve(); };
                const failed = error => { socket.removeListener("connect", done); reject(error); };
                socket.once("connect", done); socket.once("error", failed);
            });
        }
        const list = await muxExchange(socket, { MessageType: "ListDevices" }, 1);
        const normalized = value => String(value || "").replace(/-/g, "").toLowerCase();
        const device = (list.DeviceList || []).find(item => normalized(item.Properties?.SerialNumber) === normalized(udid) &&
            item.Properties?.ConnectionType === "USB");
        if (!device || !Number.isInteger(device.DeviceID) || device.DeviceID < 1) { throw new Error("所选 iPhone 的 USB 通道不可用"); }
        const result = await muxExchange(socket, { MessageType: "Connect", DeviceID: device.DeviceID,
            PortNumber: ((port & 255) << 8) | (port >> 8) }, 2);
        if (result.Number !== 0) { throw new Error(`手机上的 DeviceKit 服务未启动（端口 ${port}）`); }
        socket.setNoDelay(true);
        return socket;
    } catch (error) { socket.destroy(); throw error; }
    finally { clearTimeout(timer); }
}

async function iosRequest(id, route, { method = "GET", body, port = 12004, openPort = openIosPort, serviceName = "DeviceKit" } = {}) {
    const socket = await openPort(id, port);
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({ host: "localhost", port, path: route, method, agent,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} });
    request.setTimeout(20000, () => request.destroy(new Error(`${serviceName} 响应超时，请检查手机上的控制服务`)));
    request.on("error", () => {});
    const response = new Promise((resolve, reject) => {
        request.once("response", resolve); request.once("error", reject);
    });
    if (data) { request.write(data); }
    request.end();
    try { return { response: await response, close: () => { request.destroy(); agent.destroy(); socket.destroy(); } }; }
    catch (error) { request.destroy(); agent.destroy(); socket.destroy(); throw error; }
}

module.exports = { openIosPort, iosRequest };
