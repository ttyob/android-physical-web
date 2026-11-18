"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { spawn, execFile } = require("node:child_process");
const { parseAdbDevices, deviceTransport, normalizeAdbAddress, createEmulatorDiscovery } = require("./adb-devices");
const { createHdcAdapter, isHdcDevice, parseHdcDevice, normalizeHdcAddress } = require("./hdc");
const { createHdcApi } = require("./hdc-api");
const WebSocketServer = require("./websocket");
const WebSocket = { OPEN: 1, CONNECTING: 0 };
const { bridgeWebSocket } = require("./hdc-stream");
const { createIosAdapter, isIosDevice, parseIosDevice, normalizeIosServer } = require("./ios");
const { createIosApi } = require("./ios-api");
const { createDeviceKitControl: createIosControl } = require("./ios-devicekit");

const LISTEN_PORT = Number(process.env.GATEWAY_PORT || 8000);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 8001);
const HAP_BRIDGE_PORT = Number(process.env.HAP_BRIDGE_PORT || 8090);
const ADB = process.env.ADB_PATH || "/usr/bin/adb";
const ADB_SERVER_PORT = Number(process.env.ANDROID_ADB_SERVER_PORT || 5037);
const EMULATOR_ADB_SERVER_PORT = Number(process.env.EMULATOR_ADB_SERVER_PORT ?? 5037);
const WIFI_SSID = process.env.ANDROID_WIFI_SSID || "";
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const apiTokens = new Set();
const deviceContext = new AsyncLocalStorage();
const deviceStates = new Map();
let selectedDevice = process.env.ADB_ENDPOINT || null;
let usbRecoveryPromise = null;
let lastUsbRecoveryAt = 0;
let adbDiscoveryError = null;
const hdcOptions = {
    executable: process.env.HDC_PATH || path.join(__dirname, "vendor/hdc/linux-x64/hdc"),
    enabled: !["false", "0"].includes(process.env.HDC_ENABLED)
};
const hdc = createHdcAdapter(hdcOptions);
const hdcConnections = new Map();
const hapBridgeRequests = new Map();
const hapBridgeListeners = new Map();

function hdcConnection(server = "") {
    if (!server) {
        const handleApi = createHdcApi(hdc, { json, readJson, receiveFile, safeName, downloadHeader, errorMessage,
            });
        return { adapter: hdc, handleApi };
    }
    const address = normalizeHdcAddress(server);
    if (!hdcConnections.has(address)) {
        const adapter = createHdcAdapter({ ...hdcOptions, server: address });
        const handleApi = createHdcApi(adapter, { json, readJson, receiveFile, safeName, downloadHeader, errorMessage,
            });
        if (hdcConnections.size >= 32) { hdcConnections.delete(hdcConnections.keys().next().value); }
        hdcConnections.set(address, { adapter, handleApi });
    }
    return hdcConnections.get(address);
}

function hdcDeviceConnection(id) {
    return hdcConnection(parseHdcDevice(id).server);
}

async function prepareHapBridge(serial, adapter, connection) {
    const token = crypto.randomBytes(24).toString("base64url");
    const bridgeHost = String(process.env.HAP_BRIDGE_HOST || bridgeLanAddress());
    const bridgePort = HAP_BRIDGE_PORT;
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(bridgeHost) || !Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
        throw new Error("HAP 反向桥接地址无效");
    }
    const existing = hapBridgeRequests.get(serial);
    if (existing) { return existing; }
    const pending = (async () => {
        const deviceSocketPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                hapBridgeListeners.delete(token);
                reject(new Error("HAP 尚未连回网页网关"));
            }, 15000);
            timeout.unref();
            hapBridgeListeners.set(token, { serial, expiresAt: Date.now() + 20000, resolve, reject, timeout });
        });
        try {
            // Register first so a fast device cannot complete the TCP bridge
            // before the gateway is ready to hand its socket to the browser.
            const result = await adapter.startHapBridge(serial, { host: bridgeHost, port: bridgePort, token });
            const socket = await deviceSocketPromise;
            return { ...result, deviceSocket: socket, token };
        } catch (error) {
            const listener = hapBridgeListeners.get(token);
            if (listener) { clearTimeout(listener.timeout); hapBridgeListeners.delete(token); }
            throw error;
        }
    })().finally(() => { hapBridgeRequests.delete(serial); });
    hapBridgeRequests.set(serial, pending);
    return pending;
}

function bridgeLanAddress() {
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family === "IPv4" && !entry.internal) { return entry.address; }
        }
    }
    throw new Error("无法确定设备可访问的网页网关地址，请设置 HAP_BRIDGE_HOST");
}

async function bridgeHapStream(webSocket, serial, adapter, connection) {
    try {
        const bridge = await prepareHapBridge(serial, adapter, connection);
        bridgeWebSocket(webSocket, bridge.deviceSocket, { handshake: true });
    } catch (error) {
        if (webSocket.readyState === WebSocket.OPEN) { webSocket.close(1011, errorMessage(error).slice(0, 120)); }
    }
}
const iosOptions = { toolsDir: process.env.IOS_TOOLS_DIR || "/usr/bin", enabled: !["false", "0"].includes(process.env.IOS_ENABLED) };
const ios = createIosAdapter(iosOptions);
const iosControl = createIosControl();
const iosLocalApi = createIosApi(ios, { json, readJson, receiveFile, safeName, downloadHeader, errorMessage, control: iosControl });
const iosConnections = new Map();

function iosConnection(server = "") {
    if (!server) { return { adapter: ios, handleApi: iosLocalApi }; }
    const address = normalizeIosServer(server);
    if (!iosConnections.has(address)) {
        const adapter = createIosAdapter({ ...iosOptions, server: address });
        const handleApi = createIosApi(adapter, { json, readJson, receiveFile, safeName, downloadHeader, errorMessage, control: iosControl });
        if (iosConnections.size >= 32) { iosConnections.delete(iosConnections.keys().next().value); }
        iosConnections.set(address, { adapter, handleApi });
    }
    return iosConnections.get(address);
}

function iosDeviceConnection(id) { return iosConnection(parseIosDevice(id).server); }

const emulatorDiscovery = createEmulatorDiscovery({
    execAdb, execAdbAtPort, isTcpPortOpen,
    adbServerPort: ADB_SERVER_PORT,
    emulatorServerPort: EMULATOR_ADB_SERVER_PORT
});

const upstream = spawn(process.execPath, ["/app/dist/index.js"], {
    env: { ...process.env, WS_SCRCPY_WEB_PORT: String(UPSTREAM_PORT) },
    stdio: "inherit"
});

upstream.on("exit", code => {
    if (!shuttingDown) {
        console.error(`ws-scrcpy exited unexpectedly with code ${code}`);
        process.exit(code || 1);
    }
});

function json(response, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        "Cache-Control": "no-store"
    });
    response.end(payload);
}

function errorMessage(error) {
    const stderr = error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = error && typeof error.stdout === "string" ? error.stdout.trim() : "";
    return stderr || stdout || error.message || String(error);
}

function rememberApiToken(setCookieHeader) {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
    for (const header of headers) {
        const match = header.match(/(?:^|;\s*)ws_scrcpy_token=([^;]+)/);
        if (!match) {
            continue;
        }
        apiTokens.add(match[1]);
        while (apiTokens.size > 100) {
            apiTokens.delete(apiTokens.values().next().value);
        }
    }
}

function hasApiAccess(request) {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") {
        return false;
    }
    const cookie = request.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)ws_scrcpy_token=([^;]+)/);
    return Boolean(match && apiTokens.has(match[1]));
}

function execAdb(args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(ADB, args, {
            maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
            timeout: options.timeout || 120000,
            encoding: "utf8",
            env: options.env || process.env
        }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                error.stdout = stdout;
                reject(error);
                return;
            }
            resolve(options.includeStderr ? `${stdout}${stderr}` : stdout);
        });
    });
}

function requireDevice() {
    const device = deviceContext.getStore() || selectedDevice;
    if (!device) {
        throw new Error("请先选择设备");
    }
    return device;
}

function currentDeviceState() {
    const serial = requireDevice();
    if (!deviceStates.has(serial)) {
        deviceStates.set(serial, {
            recording: null,
            lastRecordingPath: null,
            mockLocation: null,
            previousCpuSample: null,
            gpuDescription: null
        });
    }
    return deviceStates.get(serial);
}

function runAdb(args, options = {}) {
    return execAdb(["-s", requireDevice(), ...args], options);
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runShell(command, options) {
    return runAdb(["exec-out", command], options);
}

function isTcpPortOpen(port) {
    return new Promise(resolve => {
        const socket = net.connect({ host: "127.0.0.1", port });
        const finish = open => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(500);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

function execAdbAtPort(port, args, options = {}) {
    return execAdb(args, {
        ...options,
        env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) }
    });
}

async function recoverUsbFromCompetingAdb() {
    if (ADB_SERVER_PORT === 5037 || Date.now() - lastUsbRecoveryAt < 2000) {
        return false;
    }
    if (usbRecoveryPromise) {
        return usbRecoveryPromise;
    }
    usbRecoveryPromise = (async () => {
        lastUsbRecoveryAt = Date.now();
        if (!await isTcpPortOpen(5037)) {
            return false;
        }
        const competingOutput = await execAdbAtPort(5037, ["devices", "-l"], { timeout: 3000 }).catch(() => "");
        const competingDevices = parseAdbDevices(competingOutput);
        const competingUsb = competingDevices.filter(device => deviceTransport(device) === "usb");
        // Preserve the host ADB server while it is serving emulators or network devices.
        if (!competingUsb.length || competingDevices.some(device => deviceTransport(device) !== "usb")) {
            return false;
        }

        console.warn(`reclaiming USB from ADB 5037: ${competingUsb.map(device => device.serial).join(", ")}`);
        await execAdbAtPort(5037, ["kill-server"], { timeout: 5000 }).catch(() => {});
        await execAdb(["kill-server"], { timeout: 5000 }).catch(() => {});
        await delay(250);
        await execAdb(["start-server"], { timeout: 10000 });

        for (let attempt = 0; attempt < 12; attempt += 1) {
            const devices = parseAdbDevices(await execAdb(["devices", "-l"], { timeout: 5000 }).catch(() => ""));
            if (devices.some(device => deviceTransport(device) === "usb")) {
                return true;
            }
            await delay(250);
        }
        return false;
    })().finally(() => {
        usbRecoveryPromise = null;
    });
    return usbRecoveryPromise;
}

function parseMdnsServices(output) {
    return output.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
        const fields = line.split(/\s+/);
        if (fields.length < 3 || !fields[1].startsWith("_adb")) {
            return null;
        }
        return {
            name: fields[0],
            service: fields[1].replace(/\.$/, ""),
            address: fields[2]
        };
    }).filter(Boolean);
}

async function connectedAdbDevices() {
    let devices = parseAdbDevices(await execAdb(["devices", "-l"], { timeout: 10000 }));
    const physicalUsb = devices.some(device => deviceTransport(device) === "usb");
    if (!physicalUsb && await recoverUsbFromCompetingAdb()) {
        devices = parseAdbDevices(await execAdb(["devices", "-l"], { timeout: 10000 }));
    }
    return devices;
}

async function mdnsAdbServices() {
    const output = await execAdb(["mdns", "services"], { timeout: 10000 }).catch(() => "");
    return parseMdnsServices(output);
}

function deviceLabel(device) {
    return device.properties.model || device.properties.product || device.serial;
}

async function discoverDevices(hdcAdapter = hdc, iosAdapter = ios) {
    adbDiscoveryError = null;
    await emulatorDiscovery.connectLocalEmulators().catch(error => { adbDiscoveryError = errorMessage(error); });
    const [connected, services, harmonyDevices, appleDevices] = await Promise.all([
        connectedAdbDevices().catch(error => { adbDiscoveryError = errorMessage(error); return []; }),
        mdnsAdbServices(),
        hdcAdapter.listDevices(),
        iosAdapter.listDevices()
    ]);
    const devices = await Promise.all(connected.map(async device => {
        const type = await emulatorDiscovery.deviceType(device);
        const transport = deviceTransport(device);
        return {
            id: `${type}:${device.serial}`,
            protocol: "adb",
            type,
            transport,
            serial: device.serial,
            address: transport === "network" ? device.serial : null,
            name: deviceLabel(device),
            model: device.properties.model || "",
            product: device.properties.product || "",
            state: device.state,
            selected: selectedDevice === device.serial
        };
    }));

    for (const service of services) {
        if (service.service === "_adb-tls-pairing._tcp") {
            devices.push({
                id: `pair:${service.address}`,
                protocol: "adb",
                type: "network",
                serial: null,
                address: service.address,
                name: service.name,
                model: "",
                product: "",
                state: "pairing",
                selected: false
            });
            continue;
        }
        if (service.service !== "_adb-tls-connect._tcp" && service.service !== "_adb._tcp") {
            continue;
        }
        const existing = devices.find(device => device.address === service.address ||
            device.serial?.replace(/\.$/, "") === `${service.name}.${service.service}`);
        if (existing) {
            existing.serviceName = service.name;
            continue;
        }
        devices.push({
            id: `network:${service.address}`,
            protocol: "adb",
            type: "network",
            serial: null,
            address: service.address,
            name: service.name,
            model: "",
            product: "",
            state: "available",
            selected: false
        });
    }

    devices.push(...harmonyDevices.map(device => ({ ...device, selected: selectedDevice === device.serial })));
    devices.push(...appleDevices.map(device => ({ ...device, selected: selectedDevice === device.serial })));
    if (selectedDevice && !devices.some(device => device.serial === selectedDevice && device.state === "device")) {
        selectedDevice = null;
    }

    return devices.sort((a, b) => {
        const order = { usb: 0, emulator: 1, network: 2, harmony: 3, ios: 4 };
        const typeOrder = order[a.type] - order[b.type];
        const stateOrder = Number(a.state !== "device") - Number(b.state !== "device");
        return typeOrder || stateOrder || a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });
}

function resetSelectedDeviceState(serial = selectedDevice) {
    if (serial) {
        deviceStates.delete(serial);
    }
}

async function waitForConnectedDevice(serial) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const device = (await connectedAdbDevices()).find(item => item.serial === serial);
        if (device?.state === "device") {
            return device;
        }
        await delay(250);
    }
    throw new Error("设备连接后未进入可用状态");
}

async function updateSelectedDevice(body) {
    let hdcAdapter = hdcConnection(body.hdcServer || "").adapter;
    let iosAdapter = iosConnection(body.iosServer || "").adapter;
    if (body.action === "select") {
        const serial = String(body.serial || "");
        if (isHdcDevice(serial)) {
            hdcAdapter = hdcDeviceConnection(serial).adapter;
            await hdcAdapter.assertConnected(serial);
        } else if (isIosDevice(serial)) {
            iosAdapter = iosDeviceConnection(serial).adapter;
            await iosAdapter.assertPresent(serial);
            await iosAdapter.validate(serial);
        } else {
            const connected = await connectedAdbDevices();
            if (!connected.some(item => item.serial === serial && item.state === "device")) {
                throw new Error("设备未连接或尚未授权");
            }
        }
        selectedDevice = serial;
    } else if (body.action === "connect") {
        if (body.protocol === "ios") { throw new Error("请连接 USB iPhone，或在 iPhone 页手动连接 usbmuxd 服务"); }
        if (body.protocol === "hdc") {
            selectedDevice = await hdcAdapter.connect(body.address);
            return { ok: true, selectedDevice, devices: await discoverDevices(hdcAdapter, iosAdapter) };
        }
        const address = normalizeAdbAddress(body.address);
        const output = await execAdb(["connect", address], { timeout: 15000, includeStderr: true });
        if (/failed|unable|cannot|error:/i.test(output)) {
            throw new Error(output.trim() || "ADB 连接失败");
        }
        await waitForConnectedDevice(address);
        selectedDevice = address;
    } else if (body.action === "pair" && body.protocol === "ios") {
        const serial = String(body.serial || "");
        iosAdapter = iosDeviceConnection(serial).adapter;
        await iosAdapter.pair(serial);
        selectedDevice = serial;
    } else if (body.action === "pair") {
        const address = String(body.address || "");
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code)) {
            throw new Error("请输入手机显示的六位配对码");
        }
        const services = await mdnsAdbServices();
        if (!services.some(item => item.address === address && item.service === "_adb-tls-pairing._tcp")) {
            throw new Error("配对服务已离开发现列表，请在手机上重新打开配对页面");
        }
        const output = await execAdb(["pair", address, code], { timeout: 30000, includeStderr: true });
        if (!/Successfully paired/i.test(output)) {
            throw new Error(output.trim() || "配对失败");
        }
        await delay(1000);
    } else if (body.action === "disconnect") {
        const current = String(body.serial || selectedDevice || "");
        if (current === selectedDevice) {
            selectedDevice = null;
        }
        resetSelectedDeviceState(current);
        if (current && !isHdcDevice(current) && !isIosDevice(current) && deviceTransport({ serial: current, properties: {} }) === "network") {
            await execAdb(["disconnect", current], { timeout: 10000 }).catch(() => {});
        }
    } else {
        throw new Error("未知设备操作");
    }

    return { ok: true, selectedDevice, devices: await discoverDevices(hdcAdapter, iosAdapter) };
}

function normalizeRemote(input, allowRoot = true) {
    if (typeof input !== "string" || input.includes("\0") || /[\r\n]/.test(input)) {
        throw new Error("文件路径无效");
    }
    const normalized = path.posix.normalize(input.startsWith("/") ? input : `/sdcard/${input}`);
    if (normalized !== "/sdcard" && !normalized.startsWith("/sdcard/")) {
        throw new Error("只允许访问 /sdcard");
    }
    if (!allowRoot && normalized === "/sdcard") {
        throw new Error("不允许操作 /sdcard 根目录");
    }
    return normalized;
}

function safeName(input) {
    if (typeof input !== "string" || !input || input === "." || input === ".." ||
        input.includes("/") || input.includes("\\") || input.includes("\0") || /[\r\n]/.test(input)) {
        throw new Error("文件名无效");
    }
    return input;
}

async function ensureRemoteBoundary(remotePath) {
    const resolved = (await runShell(`realpath ${shellQuote(remotePath)}`)).trim();
    const root = "/storage/emulated/0";
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new Error("文件真实路径超出 /sdcard");
    }
    return resolved;
}

async function ensureUploadDestination(remotePath) {
    await ensureRemoteBoundary(path.posix.dirname(remotePath));
    const quoted = shellQuote(remotePath);
    const resolved = (await runShell(`if [ -e ${quoted} ] || [ -L ${quoted} ]; then realpath ${quoted}; fi`)).trim();
    const root = "/storage/emulated/0";
    if (resolved && resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new Error("目标文件真实路径超出 /sdcard");
    }
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) {
            throw new Error("请求内容过大");
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function receiveFile(request, destination) {
    return new Promise((resolve, reject) => {
        const declared = Number(request.headers["content-length"] || 0);
        if (declared > MAX_UPLOAD_BYTES) {
            reject(new Error("文件不能超过 2 GB"));
            request.resume();
            return;
        }
        let size = 0;
        const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
        const fail = error => {
            output.destroy();
            fs.rm(destination, { force: true }, () => reject(error));
        };
        request.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
                request.destroy();
                fail(new Error("文件不能超过 2 GB"));
            }
        });
        request.on("error", fail);
        output.on("error", fail);
        output.on("finish", () => resolve(size));
        request.pipe(output);
    });
}

async function listFiles(remotePath) {
    await ensureRemoteBoundary(remotePath);
    const directory = remotePath === "/sdcard" ? "/sdcard/" : `${remotePath}/`;
    const quoted = shellQuote(directory);
    const command = `find ${quoted} -mindepth 1 -maxdepth 1 | while IFS= read -r item; do stat -c '%F|%s|%Y|%n' \"$item\"; done`;
    const output = await runShell(command);
    return output.split("\n").filter(Boolean).map(line => {
        const first = line.indexOf("|");
        const second = line.indexOf("|", first + 1);
        const third = line.indexOf("|", second + 1);
        if (first < 0 || second < 0 || third < 0) {
            return null;
        }
        const itemPath = line.slice(third + 1);
        let verified;
        try {
            verified = normalizeRemote(itemPath);
        } catch {
            return null;
        }
        const type = line.slice(0, first);
        return {
            name: path.posix.basename(verified),
            path: verified,
            directory: type === "directory",
            size: Number(line.slice(first + 1, second)) || 0,
            modified: (Number(line.slice(second + 1, third)) || 0) * 1000
        };
    }).filter(Boolean).sort((a, b) => Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function finiteNumber(value, name, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new Error(`${name}必须在 ${minimum} 到 ${maximum} 之间`);
    }
    return number;
}

function integer(value, name, minimum, maximum) {
    const number = finiteNumber(value, name, minimum, maximum);
    if (!Number.isInteger(number)) {
        throw new Error(`${name}必须是整数`);
    }
    return number;
}

function downloadHeader(filename, contentType = "application/octet-stream") {
    return {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store"
    };
}

function pipeAdbCommand(response, command) {
    const child = spawn(ADB, ["-s", requireDevice(), "exec-out", command], {
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(response);
    child.stderr.on("data", chunk => console.error(`adb stream: ${chunk.toString().trim()}`));
    child.on("error", () => response.destroy());
}

async function isRecording() {
    const state = currentDeviceState();
    if (!state.recording) {
        return false;
    }
    try {
        await runShell(`kill -0 ${state.recording.pid}`);
        return true;
    } catch {
        state.lastRecordingPath = state.recording.path;
        state.recording = null;
        return false;
    }
}

async function startRecording() {
    const state = currentDeviceState();
    if (await isRecording()) {
        throw new Error("录屏已经开始");
    }
    await runShell("mkdir -p /sdcard/Movies");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const remotePath = `/sdcard/Movies/screen-${stamp}.mp4`;
    const child = spawn(ADB, ["-s", requireDevice(), "shell", `screenrecord --bit-rate 6000000 --time-limit 600 ${shellQuote(remotePath)}`], {
        stdio: ["ignore", "ignore", "pipe"]
    });
    let recorderError = "";
    child.stderr.on("data", chunk => {
        recorderError += chunk.toString();
    });
    await delay(500);
    if (child.exitCode !== null) {
        throw new Error(recorderError.trim() || "录屏进程提前退出");
    }
    const pid = (await runShell("pidof screenrecord")).trim().split(/\s+/).pop();
    if (!/^\d+$/.test(pid || "")) {
        child.kill();
        throw new Error("无法启动录屏进程");
    }
    state.recording = { pid, path: remotePath, startedAt: Date.now(), child };
    const current = state.recording;
    child.on("exit", () => {
        if (state.recording === current) {
            state.lastRecordingPath = current.path;
            state.recording = null;
        }
    });
    return state.recording;
}

async function stopRecording() {
    const state = currentDeviceState();
    if (!state.recording) {
        throw new Error("当前没有正在进行的录屏");
    }
    const current = state.recording;
    await runShell(`kill -2 ${current.pid}`).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!await isRecording()) {
            break;
        }
        await delay(250);
    }
    state.lastRecordingPath = current.path;
    state.recording = null;
    return current.path;
}

async function displayStatus() {
    const [sizeOutput, densityOutput, automaticOutput, rotationOutput] = await Promise.all([
        runShell("wm size"),
        runShell("wm density"),
        runShell("settings get system accelerometer_rotation"),
        runShell("settings get system user_rotation")
    ]);
    const sizes = Array.from(sizeOutput.matchAll(/(?:Physical|Override) size: (\d+)x(\d+)/g));
    const densities = Array.from(densityOutput.matchAll(/(?:Physical|Override) density: (\d+)/g));
    const size = sizes.at(-1);
    const density = densities.at(-1);
    return {
        width: Number(size?.[1]) || 540,
        height: Number(size?.[2]) || 1200,
        density: Number(density?.[1]) || 240,
        automaticRotation: automaticOutput.trim() === "1",
        rotation: Number(rotationOutput.trim()) || 0
    };
}

async function networkStatus() {
    const [wifiOutput, proxyOutput, dnsModeOutput, dnsHostOutput] = await Promise.all([
        runShell("cmd wifi status"),
        runShell("settings get global http_proxy"),
        runShell("settings get global private_dns_mode"),
        runShell("settings get global private_dns_specifier")
    ]);
    const connected = wifiOutput.match(/Wifi is connected to \"([^\"]+)\"/);
    const ip = wifiOutput.match(/IP: \/?([0-9.]+)/);
    const proxy = proxyOutput.trim();
    return {
        enabled: /Wifi is enabled/.test(wifiOutput),
        connected: Boolean(connected),
        ssid: connected?.[1] || "",
        ip: ip?.[1] || "",
        proxy: proxy === "null" || proxy === ":0" ? "" : proxy,
        privateDnsMode: dnsModeOutput.trim() === "null" ? "opportunistic" : dnsModeOutput.trim(),
        privateDnsHost: dnsHostOutput.trim() === "null" ? "" : dnsHostOutput.trim()
    };
}

async function batteryStatus() {
    const [level, ac, usb, status] = await Promise.all([
        runShell("cmd battery get level"),
        runShell("cmd battery get ac"),
        runShell("cmd battery get usb"),
        runShell("cmd battery get status")
    ]);
    return {
        level: Number(level.trim()) || 0,
        charging: ac.trim() === "true" || usb.trim() === "true" || ac.trim() === "1" || usb.trim() === "1",
        status: Number(status.trim()) || 1
    };
}

async function deviceToolsStatus() {
    const state = currentDeviceState();
    const [display, network, battery, locationEnabled] = await Promise.all([
        displayStatus(),
        networkStatus(),
        batteryStatus(),
        runShell("cmd location is-location-enabled")
    ]);
    return { display, network, battery, location: { enabled: locationEnabled.trim() === "true", mock: state.mockLocation } };
}

async function readCpuAndMemory() {
    const output = await runShell("head -n 1 /proc/stat; head -n 5 /proc/meminfo");
    const lines = output.trim().split("\n");
    const cpuValues = lines[0].trim().split(/\s+/).slice(1).map(Number);
    const total = cpuValues.reduce((sum, value) => sum + (value || 0), 0);
    const idle = (cpuValues[3] || 0) + (cpuValues[4] || 0);
    const memory = {};
    for (const line of lines.slice(1)) {
        const match = line.match(/^(MemTotal|MemFree|MemAvailable|Buffers|Cached):\s+(\d+)/);
        if (match) {
            memory[match[1]] = Number(match[2]);
        }
    }
    return { cpu: { total, idle }, memory };
}

async function resourceStatus() {
    const state = currentDeviceState();
    let sample = await readCpuAndMemory();
    if (!state.previousCpuSample) {
        state.previousCpuSample = sample.cpu;
        await delay(250);
        sample = await readCpuAndMemory();
    }
    const totalDelta = sample.cpu.total - state.previousCpuSample.total;
    const idleDelta = sample.cpu.idle - state.previousCpuSample.idle;
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (totalDelta - idleDelta) * 100 / totalDelta)) : 0;
    state.previousCpuSample = sample.cpu;

    const totalKb = sample.memory.MemTotal || 0;
    const availableKb = sample.memory.MemAvailable || sample.memory.MemFree || 0;
    const usedKb = Math.max(0, totalKb - availableKb);

    const gpuBusyOutput = await runShell("for f in /sys/class/drm/card*/device/gpu_busy_percent /sys/class/kgsl/kgsl-3d0/gpubusy /sys/kernel/gpu/gpu_busy; do if [ -r \"$f\" ]; then cat \"$f\"; break; fi; done");
    let gpuPercent = null;
    const busyText = gpuBusyOutput.trim();
    const busyParts = busyText ? busyText.split(/\s+/).map(Number).filter(Number.isFinite) : [];
    if (busyParts.length === 1) {
        gpuPercent = Math.max(0, Math.min(100, busyParts[0]));
    } else if (busyParts.length >= 2 && busyParts[1] > 0) {
        gpuPercent = Math.max(0, Math.min(100, busyParts[0] * 100 / busyParts[1]));
    }

    if (!state.gpuDescription) {
        const surface = await runShell("dumpsys SurfaceFlinger | grep -m 1 '^GLES:'").catch(() => "");
        state.gpuDescription = surface.trim().replace(/^GLES:\s*/, "") || "未知渲染器";
    }
    return {
        cpuPercent: Number(cpuPercent.toFixed(1)),
        memory: {
            usedMb: Number((usedKb / 1024).toFixed(0)),
            totalMb: Number((totalKb / 1024).toFixed(0)),
            percent: totalKb ? Number((usedKb * 100 / totalKb).toFixed(1)) : 0
        },
        gpu: {
            percent: gpuPercent,
            software: /SwiftShader/i.test(state.gpuDescription),
            renderer: state.gpuDescription
        }
    };
}

async function updateDisplay(body) {
    if (body.action === "apply") {
        const width = integer(body.width, "宽度", 320, 2160);
        const height = integer(body.height, "高度", 320, 3840);
        const density = integer(body.density, "DPI", 120, 640);
        await runShell(`wm size ${width}x${height}; wm density ${density}`);
    } else if (body.action === "reset") {
        await runShell("wm size reset; wm density reset; settings put system accelerometer_rotation 1");
    } else if (body.action === "rotation") {
        if (body.mode === "auto") {
            await runShell("settings put system accelerometer_rotation 1");
        } else {
            const rotation = integer(body.rotation, "旋转方向", 0, 3);
            await runShell(`settings put system accelerometer_rotation 0; settings put system user_rotation ${rotation}`);
        }
    } else {
        throw new Error("未知显示操作");
    }
    return displayStatus();
}

async function updateNetwork(body) {
    if (body.action === "wifi") {
        if (body.enabled) {
            await runShell("svc wifi enable");
            if (!WIFI_SSID) {
                await delay(500);
                return networkStatus();
            }
            await delay(500);
            await runShell(`cmd wifi connect-network ${shellQuote(WIFI_SSID)} open`).catch(() => {});
            for (let attempt = 0; attempt < 12; attempt += 1) {
                const status = await networkStatus();
                if (status.connected) {
                    return status;
                }
                await delay(500);
            }
        } else {
            await runShell("svc wifi disable");
        }
    } else if (body.action === "proxy") {
        const host = String(body.host || "").trim();
        const port = integer(body.port, "代理端口", 1, 65535);
        if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) {
            throw new Error("代理主机格式无效");
        }
        await runShell(`settings put global http_proxy ${shellQuote(`${host}:${port}`)}`);
    } else if (body.action === "clearProxy") {
        await runShell("settings put global http_proxy :0");
    } else if (body.action === "dns") {
        const host = String(body.host || "").trim();
        if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) {
            throw new Error("私人 DNS 主机格式无效");
        }
        await runShell(`settings put global private_dns_mode hostname; settings put global private_dns_specifier ${shellQuote(host)}`);
    } else if (body.action === "automaticDns") {
        await runShell("settings put global private_dns_mode opportunistic; settings delete global private_dns_specifier");
    } else {
        throw new Error("未知网络操作");
    }
    return networkStatus();
}

async function updateSimulation(body) {
    const state = currentDeviceState();
    if (body.action === "location") {
        const latitude = finiteNumber(body.latitude, "纬度", -90, 90);
        const longitude = finiteNumber(body.longitude, "经度", -180, 180);
        const accuracy = finiteNumber(body.accuracy ?? 5, "精度", 1, 1000);
        await runShell("appops set 2000 android:mock_location allow").catch(() => {});
        await runShell("cmd location set-location-enabled true");
        await runShell("cmd location providers add-test-provider gps --requiresSatellite --supportsAltitude").catch(() => {});
        await runShell("cmd location providers set-test-provider-enabled gps true");
        await runShell(`cmd location providers set-test-provider-location gps --location ${latitude},${longitude} --accuracy ${accuracy}`);
        state.mockLocation = { latitude, longitude, accuracy };
    } else if (body.action === "resetLocation") {
        await runShell("cmd location providers remove-test-provider gps").catch(() => {});
        await runShell("appops set 2000 android:mock_location default").catch(() => {});
        state.mockLocation = null;
    } else if (body.action === "battery") {
        const level = integer(body.level, "电量", 0, 100);
        await runShell(`cmd battery set level ${level}`);
        if (body.charging) {
            await runShell("cmd battery set ac 1; cmd battery set status 2");
        } else {
            await runShell("cmd battery unplug; cmd battery set status 3");
        }
    } else if (body.action === "resetBattery") {
        await runShell("cmd battery reset");
    } else {
        throw new Error("未知模拟操作");
    }
    return { battery: await batteryStatus(), location: { mock: state.mockLocation } };
}

function validPackageName(value) {
    const packageName = String(value || "").trim();
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/.test(packageName)) {
        throw new Error("应用包名无效");
    }
    return packageName;
}

function diagnosticTarget(value) {
    const target = String(value || "").trim();
    if (!/^[a-zA-Z0-9._:-]{1,253}$/.test(target)) {
        throw new Error("目标地址格式无效");
    }
    return target;
}

async function listApplications(includeSystem) {
    const args = includeSystem ? "-s -f" : "-3 -f";
    const [packagesOutput, processesOutput] = await Promise.all([
        runShell(`pm list packages ${args}`),
        runShell("ps -A -o NAME").catch(() => "")
    ]);
    const processes = new Set(processesOutput.split("\n").map(line => line.trim()).filter(Boolean));
    return packagesOutput.split("\n").filter(Boolean).map(line => {
        const value = line.startsWith("package:") ? line.slice(8) : line;
        const separator = value.lastIndexOf("=");
        const packageName = separator >= 0 ? value.slice(separator + 1) : value;
        const apkPath = separator >= 0 ? value.slice(0, separator) : "";
        return {
            packageName,
            apkPath,
            system: includeSystem,
            running: processes.has(packageName) || Array.from(processes).some(name => name.startsWith(`${packageName}:`))
        };
    }).sort((a, b) => a.packageName.localeCompare(b.packageName));
}

async function applicationDetails(packageName) {
    const output = await runShell(`dumpsys package ${shellQuote(packageName)}`);
    if (!output.includes(`Package [${packageName}]`) && !output.includes(`Package{`)) {
        throw new Error("未找到该应用");
    }
    const value = name => output.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`))?.[1] || "";
    const permissions = [];
    const seen = new Set();
    for (const match of output.matchAll(/^\s+([a-zA-Z0-9_.]+): granted=(true|false)/gm)) {
        if (!seen.has(match[1])) {
            permissions.push({ name: match[1], granted: match[2] === "true" });
            seen.add(match[1]);
        }
    }
    return {
        packageName,
        versionName: value("versionName"),
        versionCode: value("versionCode"),
        minSdk: value("minSdk"),
        targetSdk: value("targetSdk"),
        firstInstallTime: output.match(/firstInstallTime=([^\n]+)/)?.[1]?.trim() || "",
        lastUpdateTime: output.match(/lastUpdateTime=([^\n]+)/)?.[1]?.trim() || "",
        permissions: permissions.sort((a, b) => a.name.localeCompare(b.name))
    };
}

async function updateApplication(body) {
    const packageName = validPackageName(body.packageName);
    if (body.action === "launch") {
        const output = await runAdb(["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], {
            includeStderr: true
        });
        if (!/Events injected:\s*1/.test(output)) {
            throw new Error("应用没有可启动的主界面");
        }
    } else if (body.action === "forceStop") {
        await runAdb(["shell", "am", "force-stop", packageName]);
    } else if (body.action === "clearData") {
        const output = await runAdb(["shell", "pm", "clear", packageName]);
        if (!/Success/i.test(output)) {
            throw new Error(output.trim() || "清除数据失败");
        }
    } else if (body.action === "uninstall") {
        const output = await runAdb(["uninstall", packageName], { timeout: 120000 });
        if (!/Success/i.test(output)) {
            throw new Error(output.trim() || "卸载失败");
        }
    } else {
        throw new Error("未知应用操作");
    }
    return { ok: true, packageName, action: body.action };
}

async function executeDeviceShell(body) {
    const command = String(body.command || "").trim();
    if (!command || command.length > 4000 || command.includes("\0")) {
        throw new Error("命令不能为空且不能超过 4000 个字符");
    }
    const startedAt = Date.now();
    const output = await runAdb(["shell", command], {
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        includeStderr: true
    });
    return { output, durationMs: Date.now() - startedAt };
}

async function readLogcat(url) {
    const lines = integer(url.searchParams.get("lines") || 300, "日志行数", 20, 2000);
    const level = String(url.searchParams.get("level") || "V").toUpperCase();
    if (!/^[VDIWEF]$/.test(level)) {
        throw new Error("日志级别无效");
    }
    const args = ["logcat", "-d", "-v", "threadtime", "-t", String(lines)];
    const packageValue = url.searchParams.get("package");
    if (packageValue) {
        const packageName = validPackageName(packageValue);
        const pid = (await runAdb(["shell", "pidof", packageName]).catch(() => "")).trim().split(/\s+/)[0];
        if (!pid) {
            return { output: "", lines: 0, packageName, running: false };
        }
        args.push(`--pid=${pid}`);
    }
    args.push(`*:${level}`);
    let output = await runAdb(args, { maxBuffer: 4 * 1024 * 1024 });
    const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
    if (search) {
        output = output.split("\n").filter(line => line.toLowerCase().includes(search)).join("\n");
    }
    return { output, lines: output ? output.split("\n").length : 0, running: true };
}

async function networkOverview() {
    const output = await runShell("ip -brief addr; echo; echo ROUTES; ip route show table 1016; echo; echo DNS; getprop net.dns1; getprop net.dns2");
    return { output };
}

async function runNetworkDiagnostic(body) {
    const target = diagnosticTarget(body.target);
    const startedAt = Date.now();
    if (body.type === "ping") {
        try {
            const output = await runAdb(["shell", "ping", "-c", "4", "-W", "2", target], { includeStderr: true, timeout: 15000 });
            return { type: body.type, target, reachable: true, output, durationMs: Date.now() - startedAt };
        } catch (error) {
            return { type: body.type, target, reachable: false, output: errorMessage(error), durationMs: Date.now() - startedAt };
        }
    }
    if (body.type === "dns") {
        try {
            const output = await runAdb(["shell", "ping", "-c", "1", "-W", "2", target], { includeStderr: true, timeout: 8000 });
            return { type: body.type, target, reachable: true, output: output.split("\n").slice(0, 2).join("\n"), durationMs: Date.now() - startedAt };
        } catch (error) {
            const output = errorMessage(error);
            const resolved = new RegExp(`^PING\\s+${target.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s+\\([^)]+\\)`, "m").test(output);
            return {
                type: body.type,
                target,
                reachable: resolved,
                output: output.split("\n").slice(0, 2).join("\n"),
                durationMs: Date.now() - startedAt
            };
        }
    }
    if (body.type === "route") {
        try {
            const output = await runAdb(["shell", "ip", "route", "get", target], { includeStderr: true, timeout: 8000 });
            return { type: body.type, target, reachable: true, output, durationMs: Date.now() - startedAt };
        } catch (error) {
            return { type: body.type, target, reachable: false, output: errorMessage(error), durationMs: Date.now() - startedAt };
        }
    }
    if (body.type === "port") {
        const port = integer(body.port, "端口", 1, 65535);
        try {
            await runAdb(["shell", "toybox", "nc", "-z", "-w", "3", target, String(port)], { timeout: 8000 });
            return { type: body.type, target, port, reachable: true, output: `${target}:${port} 可以连接`, durationMs: Date.now() - startedAt };
        } catch {
            return { type: body.type, target, port, reachable: false, output: `${target}:${port} 无法连接`, durationMs: Date.now() - startedAt };
        }
    }
    throw new Error("未知诊断类型");
}

function parseForwardList(output, direction) {
    return output.split("\n").filter(Boolean).map(line => {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 3 || !fields[1].startsWith("tcp:") || !fields[2].startsWith("tcp:")) {
            return null;
        }
        return {
            direction,
            serial: fields[0],
            localPort: Number(fields[1].slice(4)),
            remotePort: Number(fields[2].slice(4))
        };
    }).filter(Boolean);
}

async function listForwards() {
    const [forwardOutput, reverseOutput] = await Promise.all([
        runAdb(["forward", "--list"]),
        runAdb(["reverse", "--list"])
    ]);
    return [...parseForwardList(forwardOutput, "forward"), ...parseForwardList(reverseOutput, "reverse")];
}

async function updateForward(body) {
    const direction = body.direction === "reverse" ? "reverse" : body.direction === "forward" ? "forward" : "";
    if (!direction) {
        throw new Error("转发方向无效");
    }
    const localPort = integer(body.localPort, "本地端口", 1, 65535);
    if (body.action === "add") {
        const remotePort = integer(body.remotePort, "目标端口", 1, 65535);
        await runAdb([direction, `tcp:${localPort}`, `tcp:${remotePort}`]);
    } else if (body.action === "remove") {
        await runAdb([direction, "--remove", `tcp:${localPort}`]);
    } else {
        throw new Error("未知转发操作");
    }
    return { ok: true, forwards: await listForwards() };
}

async function handleLocalApi(request, response, url) {
    try {
        if (request.method === "GET" && url.pathname === "/local-api/devices") {
            const adapter = hdcConnection(url.searchParams.get("hdcServer") || "").adapter;
            const appleAdapter = iosConnection(url.searchParams.get("iosServer") || "").adapter;
            const devices = await discoverDevices(adapter, appleAdapter);
            json(response, 200, { selectedDevice, devices, providers: { adb: { error: adbDiscoveryError }, hdc: adapter.status(), ios: appleAdapter.status() } });
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/devices") {
            json(response, 200, await updateSelectedDevice(await readJson(request)));
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/device/config") {
            json(response, 200, { deviceId: requireDevice() });
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/device/status") {
            json(response, 200, await deviceToolsStatus());
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/device/resources") {
            json(response, 200, await resourceStatus());
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/device/screenshot") {
            const filename = `android-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
            response.writeHead(200, downloadHeader(filename, "image/png"));
            pipeAdbCommand(response, "screencap -p");
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/device/recording") {
            const state = currentDeviceState();
            json(response, 200, {
                recording: await isRecording(),
                startedAt: state.recording?.startedAt || null,
                path: state.recording?.path || state.lastRecordingPath
            });
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/device/recording") {
            const body = await readJson(request);
            if (body.action === "start") {
                const current = await startRecording();
                json(response, 200, { recording: true, startedAt: current.startedAt, path: current.path });
            } else if (body.action === "stop") {
                const remotePath = await stopRecording();
                await delay(500);
                json(response, 200, { recording: false, path: remotePath });
            } else {
                throw new Error("未知录屏操作");
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/device/display") {
            json(response, 200, { ok: true, display: await updateDisplay(await readJson(request)) });
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/device/network") {
            json(response, 200, { ok: true, network: await updateNetwork(await readJson(request)) });
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/device/simulation") {
            json(response, 200, { ok: true, ...(await updateSimulation(await readJson(request))) });
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/apps") {
            const includeSystem = url.searchParams.get("scope") === "system";
            json(response, 200, { apps: await listApplications(includeSystem), scope: includeSystem ? "system" : "user" });
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/apps/details") {
            json(response, 200, await applicationDetails(validPackageName(url.searchParams.get("package"))));
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/apps") {
            json(response, 200, await updateApplication(await readJson(request)));
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/shell") {
            json(response, 200, await executeDeviceShell(await readJson(request)));
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/logcat") {
            json(response, 200, await readLogcat(url));
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/logcat") {
            const body = await readJson(request);
            if (body.action !== "clear") {
                throw new Error("未知日志操作");
            }
            await runAdb(["logcat", "-c"]);
            json(response, 200, { ok: true });
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/network/diagnostics") {
            json(response, 200, await networkOverview());
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/network/diagnostics") {
            json(response, 200, await runNetworkDiagnostic(await readJson(request)));
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/forwards") {
            json(response, 200, { forwards: await listForwards() });
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/forwards") {
            json(response, 200, await updateForward(await readJson(request)));
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/files") {
            const remotePath = normalizeRemote(url.searchParams.get("path") || "/sdcard");
            const files = await listFiles(remotePath);
            json(response, 200, { path: remotePath, files });
            return;
        }

        if (request.method === "GET" && url.pathname === "/local-api/files/download") {
            const remotePath = normalizeRemote(url.searchParams.get("path") || "", false);
            await ensureRemoteBoundary(remotePath);
            const kind = (await runShell(`stat -c '%F|%s' ${shellQuote(remotePath)}`)).trim();
            const separator = kind.lastIndexOf("|");
            if (!kind.startsWith("regular file|") || separator < 0) {
                json(response, 400, { error: "只能下载普通文件" });
                return;
            }
            const filename = path.posix.basename(remotePath);
            response.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Length": Number(kind.slice(separator + 1)) || 0,
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
                "Cache-Control": "no-store"
            });
            const child = spawn(ADB, ["-s", requireDevice(), "exec-out", `cat ${shellQuote(remotePath)}`], {
                stdio: ["ignore", "pipe", "pipe"]
            });
            child.stdout.pipe(response);
            child.stderr.on("data", chunk => console.error(`download: ${chunk.toString().trim()}`));
            child.on("error", () => response.destroy());
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/files/upload") {
            const directory = normalizeRemote(url.searchParams.get("path") || "/sdcard");
            await ensureRemoteBoundary(directory);
            const name = safeName(url.searchParams.get("name") || "");
            const destination = normalizeRemote(path.posix.join(directory, name), false);
            await ensureUploadDestination(destination);
            const temporary = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}`);
            try {
                const size = await receiveFile(request, temporary);
                await runAdb(["push", temporary, destination], { timeout: 30 * 60 * 1000 });
                json(response, 200, { ok: true, path: destination, size });
            } finally {
                await fs.promises.rm(temporary, { force: true });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/apk/install") {
            const name = safeName(url.searchParams.get("name") || "application.apk");
            if (!name.toLowerCase().endsWith(".apk")) {
                throw new Error("请选择 APK 文件");
            }
            const temporary = path.join(os.tmpdir(), `apk-${crypto.randomUUID()}.apk`);
            try {
                const size = await receiveFile(request, temporary);
                const output = await runAdb(["install", "-r", "-g", temporary], { timeout: 30 * 60 * 1000 });
                if (!/Success/i.test(output)) {
                    throw new Error(output.trim() || "APK 安装失败");
                }
                json(response, 200, { ok: true, name, size, message: "安装成功" });
            } finally {
                await fs.promises.rm(temporary, { force: true });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/local-api/files/mkdir") {
            const body = await readJson(request);
            const remotePath = normalizeRemote(body.path || "", false);
            await ensureRemoteBoundary(path.posix.dirname(remotePath));
            await runShell(`mkdir ${shellQuote(remotePath)}`);
            json(response, 200, { ok: true, path: remotePath });
            return;
        }

        if (request.method === "DELETE" && url.pathname === "/local-api/files") {
            const remotePath = normalizeRemote(url.searchParams.get("path") || "", false);
            await ensureRemoteBoundary(remotePath);
            await runShell(`rm -rf -- ${shellQuote(remotePath)}`);
            json(response, 200, { ok: true, path: remotePath });
            return;
        }

        json(response, 404, { error: "接口不存在" });
    } catch (error) {
        console.error(`${request.method} ${url.pathname}: ${errorMessage(error)}`);
        if (!response.headersSent) {
            json(response, 400, { error: errorMessage(error) });
        } else {
            response.destroy();
        }
    }
}

function proxyHttp(request, response) {
    const incomingUrl = new URL(request.url, "http://localhost");
    if (incomingUrl.pathname === "/") {
        incomingUrl.pathname = "/dashboard.html";
    } else if (incomingUrl.pathname === "/device.html") {
        incomingUrl.pathname = "/";
    }
    const proxy = http.request({
        hostname: "127.0.0.1",
        port: UPSTREAM_PORT,
        method: request.method,
        path: `${incomingUrl.pathname}${incomingUrl.search}`,
        headers: request.headers
    }, upstreamResponse => {
        rememberApiToken(upstreamResponse.headers["set-cookie"]);
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
    });
    proxy.on("error", error => {
        if (!response.headersSent) {
            json(response, 502, { error: `控制服务尚未就绪: ${error.message}` });
        } else {
            response.destroy();
        }
    });
    request.pipe(proxy);
}

async function requestDevice(url) {
    const serial = String(url.searchParams.get("device") || selectedDevice || "");
    if (!serial) {
        throw new Error("请指定要控制的设备");
    }
    if (isHdcDevice(serial)) {
        await hdcDeviceConnection(serial).adapter.assertConnected(serial);
        return serial;
    }
    if (isIosDevice(serial)) {
        await iosDeviceConnection(serial).adapter.assertPresent(serial);
        return serial;
    }
    const connected = await connectedAdbDevices();
    if (!connected.some(device => device.serial === serial && device.state === "device")) {
        throw new Error("设备未连接或尚未授权");
    }
    return serial;
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/local-api/")) {
        if (!hasApiAccess(request)) {
            json(response, 401, { error: "登录状态无效，请刷新页面" });
            return;
        }
        if (url.pathname === "/local-api/devices") {
            handleLocalApi(request, response, url);
            return;
        }
        try {
            const serial = await requestDevice(url);
            deviceContext.run(serial, () => {
                if (isHdcDevice(serial)) { return hdcDeviceConnection(serial).handleApi(request, response, url, serial); }
                if (isIosDevice(serial)) { return iosDeviceConnection(serial).handleApi(request, response, url, serial); }
                return handleLocalApi(request, response, url);
            });
        } catch (error) {
            json(response, 400, { error: errorMessage(error) });
        }
        return;
    }
    proxyHttp(request, response);
});

server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/local-api/hap/stream") {
        if (!hasApiAccess(request)) {
            socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return;
        }
        const serial = String(url.searchParams.get("device") || "");
        if (!isHdcDevice(serial)) {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            return;
        }
        const webSocketServer = new WebSocketServer();
        webSocketServer.handleUpgrade(request, socket, head, webSocket => {
            (async () => {
                const connection = hdcDeviceConnection(serial);
                await connection.adapter.assertConnected(serial);
                await bridgeHapStream(webSocket, serial, connection.adapter, connection);
            })().catch(error => {
                if (webSocket.readyState === WebSocket.OPEN) { webSocket.close(1011, errorMessage(error).slice(0, 120)); }
            });
        });
        webSocketServer.on("error", () => { try { socket.destroy(); } catch {} });
        return;
    }
    if (url.searchParams.get("action") === "stream") {
        const serial = String(url.searchParams.get("udid") || "");
        if (isHdcDevice(serial) || isIosDevice(serial)) {
            socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
            return;
        }
        const connected = await connectedAdbDevices().catch(() => []);
        if (!connected.some(device => device.serial === serial && device.state === "device")) {
            socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
            return;
        }
    }
    const target = net.connect(UPSTREAM_PORT, "127.0.0.1", () => {
        const requestLine = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
        const headers = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
            headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        }
        target.write(`${requestLine}${headers.join("\r\n")}\r\n\r\n`);
        if (head.length) {
            target.write(head);
        }
        socket.pipe(target).pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log(`gateway listening on ${LISTEN_PORT}, ws-scrcpy upstream on ${UPSTREAM_PORT}`);
});

const hapBridgeServer = net.createServer(socket => {
    socket.setNoDelay(true);
    let received = Buffer.alloc(0);
    let bridged = false;
    const timer = setTimeout(() => { if (!bridged) { socket.destroy(); } }, 5000);
    timer.unref();
    const onData = chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 256) { socket.destroy(); return; }
        if (received.subarray(0, 4).toString("ascii") !== "WEB ") {
            socket.destroy();
            return;
        }
        const newline = received.indexOf(0x0a, 4);
        if (newline < 5) { return; }
        const token = received.subarray(4, newline).toString("ascii");
        const listener = hapBridgeListeners.get(token);
        if (!listener || listener.expiresAt < Date.now()) {
            hapBridgeListeners.delete(token);
            socket.destroy();
            return;
        }
        bridged = true; clearTimeout(timer);
        hapBridgeListeners.delete(token);
        socket.removeListener("data", onData);
        const remainder = received.subarray(newline + 1);
        if (remainder.length) { socket.unshift(remainder); }
        clearTimeout(listener.timeout);
        listener.resolve(socket);
    };
    socket.on("data", onData);
    socket.on("error", () => {});
});
hapBridgeServer.on("error", error => console.error(`HAP bridge listener: ${errorMessage(error)}`));
hapBridgeServer.listen(HAP_BRIDGE_PORT, "0.0.0.0", () => {
    console.log(`HAP reverse bridge listening on ${HAP_BRIDGE_PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    iosControl.closeAll();
    server.close();
    hapBridgeServer.close();
    for (const [serial, state] of deviceStates) {
        if (state.recording) {
            execAdb(["-s", serial, "exec-out", `kill -2 ${state.recording.pid}`]).catch(() => {});
        }
    }
    upstream.kill(signal);
    setTimeout(() => process.exit(0), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
