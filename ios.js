"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { execFile, spawn } = require("node:child_process");

const PREFIX = "ios://";
const UDID = /^(?:[a-f0-9]{40}|[a-f0-9]{8}-[a-f0-9]{16})$/i;
const TOOLS = ["idevice_id", "ideviceinfo", "idevicepair", "idevicesyslog", "idevicescreenshot", "ideviceinstaller"];
const activeLogs = new Set();

function isIosDevice(id) { return typeof id === "string" && id.startsWith(PREFIX); }

function normalizeIosServer(value) {
    const address = typeof value === "string" ? value.trim() : "";
    const match = /^(\[[a-f0-9:.]+\]|[a-z0-9][a-z0-9.-]*):(\d{1,5})$/i.exec(address);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 ||
        (match[1].startsWith("[") && !net.isIP(match[1].slice(1, -1)))) {
        throw new Error("usbmuxd 服务地址无效，请填写主机 IP:端口");
    }
    return `${match[1].toLowerCase()}:${Number(match[2])}`;
}

function parseIosDevice(id) {
    const separator = isIosDevice(id) ? id.indexOf("/", PREFIX.length) : -1;
    if (separator < 0) { throw new Error("iOS 设备标识无效，请重新添加设备"); }
    const service = id.slice(PREFIX.length, separator);
    const server = service === "local" ? "" : normalizeIosServer(service);
    const udid = id.slice(separator + 1);
    if (!UDID.test(udid)) { throw new Error("iOS 设备 UDID 无效"); }
    return { server, udid };
}

// Parse the small XML plist subset emitted by the pinned tools, without loading a DTD
// or expanding external entities. Dictionaries never inherit object properties.
function parsePlist(output) {
    const start = output.indexOf("<plist");
    if (start < 0) { throw new Error("iOS 工具未返回有效的 plist 数据"); }
    const xml = output.slice(start).replace(/<\/?plist\b[^>]*>/g, "").trim();
    const tokens = xml.match(/<[^>]+>|[^<]+/g) || [];
    let index = 0;
    function whitespace() { while (tokens[index] && !tokens[index].trim()) { index++; } }
    function decode(text) {
        return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/gi, entity => {
            const names = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
            if (names[entity]) { return names[entity]; }
            const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
            return String.fromCodePoint(code);
        });
    }
    function read(depth = 0) {
        whitespace();
        if (depth > 64) { throw new Error("plist 嵌套过深"); }
        const tag = tokens[index++];
        const match = /^<(dict|array|string|key|integer|real|true|false|data|date)\s*(\/?)>$/.exec(tag || "");
        if (!match) { throw new Error("plist 数据格式错误"); }
        const name = match[1];
        if (name === "true" || name === "false") {
            if (!match[2] && tokens[index++] !== `</${name}>`) { throw new Error("plist 布尔值格式错误"); }
            return name === "true";
        }
        if (name === "dict" || name === "array") {
            const value = name === "dict" ? Object.create(null) : [];
            if (match[2]) { return value; }
            whitespace();
            while (tokens[index] !== `</${name}>`) {
                if (name === "dict") {
                    if (!/^<key\s*\/?>$/.test(tokens[index] || "")) { throw new Error("plist 缺少字典键"); }
                    const key = read(depth + 1);
                    value[key] = read(depth + 1);
                } else { value.push(read(depth + 1)); }
                whitespace();
            }
            index++;
            return value;
        }
        let value = "";
        if (!match[2]) {
            if (tokens[index] && !tokens[index].startsWith("<")) { value = tokens[index++]; }
            if (tokens[index++] !== `</${name}>`) { throw new Error("plist 值格式错误"); }
        }
        return name === "integer" || name === "real" ? Number(value) : decode(value);
    }
    const result = read();
    whitespace();
    if (index !== tokens.length) { throw new Error("plist 数据未完整解析"); }
    return result;
}

function iosError(error) {
    const detail = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim().slice(0, 1500);
    let message = detail;
    if (/password.?protected|device.*locked|passcode/i.test(detail)) {
        message = "请解锁 iPhone 后重试";
    } else if (/pairing.*dialog|trust|not paired|invalid.?host|pair record|user.?denied|validate.*failed|please pair/i.test(detail)) {
        message = "请解锁 iPhone，在手机上选择“信任此电脑”，然后点击配对重试";
    } else if (/screenshotr|developer.*image/i.test(detail)) {
        message = "设备调试服务不可用；截图需要匹配的开发者镜像，iOS 16 还需开启开发者模式";
    } else if (/invalid.?service|start.*service/i.test(detail)) {
        message = "设备所需的 iOS 服务不可用，请解锁手机并检查系统版本和信任状态";
    } else if (error.killed || error.code === "ETIMEDOUT") {
        message = "iOS 工具执行超时，请检查设备、信任状态和服务连接";
    }
    return Object.assign(new Error(message), { statusCode: error.statusCode || 400 });
}

function screenshotCapability(version) {
    const major = parseInt(version, 10);
    if (!Number.isFinite(major)) { return { supported: false, reason: "无法读取 iOS 版本，请刷新设备信息后重试" }; }
    return major < 17 ? {
        supported: true, reason: "需要已挂载匹配的开发者镜像；iOS 16 还需开启开发者模式"
    } : { supported: false, reason: "当前工具尚未接入 iOS 17 及以上的截图开发者通道" };
}

function createIosAdapter({ toolsDir = "/usr/bin", server = "", enabled = true, execute = execFile,
    launch = spawn, existsSync = fs.existsSync } = {}) {
    const serverAddress = server ? normalizeIosServer(server) : "";
    const available = TOOLS.every(tool => existsSync(path.join(toolsDir, tool)));
    // Override inherited socket settings on every invocation, so a remote page can
    // never change a concurrent local (or other remote) device's transport.
    const environment = { ...process.env, USBMUXD_SOCKET_ADDRESS: serverAddress || "UNIX:/run/usbmuxd" };
    const metadata = new Map();
    let discoveryError = null;
    let discoveryPromise = null;

    function run(tool, args, options = {}) {
        if (!enabled || !available) {
            return Promise.reject(new Error(enabled ? "项目内的 iOS 工具不可用，请重建镜像" : "iOS 工具已禁用"));
        }
        return new Promise((resolve, reject) => execute(path.join(toolsDir, tool), args, {
            env: { ...environment }, timeout: options.timeout || 10000, maxBuffer: 8 * 1024 * 1024,
            encoding: "utf8", killSignal: "SIGKILL"
        }, (error, stdout = "", stderr = "") => {
            if (error || /(?:^|\n)(?:ERROR:|Error occurred:)/i.test(`${stdout}\n${stderr}`)) {
                reject(iosError(Object.assign(error || new Error("iOS 操作失败"), { stdout, stderr })));
            } else { resolve(options.includeStderr ? `${stdout}${stderr}` : stdout); }
        }));
    }

    function target(id) {
        const parsed = parseIosDevice(id);
        if (parsed.server !== serverAddress) { throw new Error("iOS 设备与 usbmuxd 服务不匹配"); }
        return parsed.udid;
    }

    function deviceRun(id, tool, args, options) { return run(tool, ["-u", target(id), ...args], options); }

    async function assertPresent(id) {
        const udid = target(id);
        const output = await run("idevice_id", ["-l"], { timeout: 5000 });
        if (!output.split(/\r?\n/).some(line => line.trim() === udid)) {
            throw new Error("iPhone 未连接，请检查数据线或远程 usbmuxd 服务");
        }
        return udid;
    }

    async function validate(id) { await deviceRun(id, "idevicepair", ["validate"], { timeout: 5000 }); }

    async function info(id) {
        await validate(id);
        const raw = parsePlist(await deviceRun(id, "ideviceinfo", ["-x"]));
        return { udid: target(id), deviceName: String(raw.DeviceName || "iPhone"),
            productType: String(raw.ProductType || ""), productVersion: String(raw.ProductVersion || ""),
            buildVersion: String(raw.BuildVersion || ""), serialNumber: String(raw.SerialNumber || ""),
            hardwareModel: String(raw.HardwareModel || ""), cpuArchitecture: String(raw.CPUArchitecture || ""),
            connection: serverAddress ? "远程 USB" : "本机 USB", service: serverAddress || "本机 usbmuxd" };
    }

    async function pair(id) {
        await assertPresent(id);
        const output = await deviceRun(id, "idevicepair", ["pair"], { timeout: 20000, includeStderr: true });
        await validate(id);
        metadata.delete(target(id));
        return output.trim();
    }

    async function discover() {
        if (!enabled || !available) {
            discoveryError = enabled && !available ? "项目内的 iOS 工具不可用，请重建镜像" : null;
            return [];
        }
        try {
            const output = await run("idevice_id", ["-l"], { timeout: 5000 });
            const udids = [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(line => UDID.test(line)))].slice(0, 64);
            const devices = [];
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(4, udids.length) }, async () => {
                while (next < udids.length) {
                    const udid = udids[next++];
                    const id = `${PREFIX}${serverAddress || "local"}/${udid}`;
                    let cached = metadata.get(udid);
                    if (!cached || Date.now() - cached.time > 15000) {
                        try { cached = { info: await info(id), state: "device", time: Date.now() }; }
                        catch (error) { cached = { state: /信任|解锁/.test(error.message) ? "unauthorized" : "offline", error: error.message, time: Date.now() }; }
                        metadata.set(udid, cached);
                    }
                    devices.push({ id, serial: id, udid, protocol: "ios", type: "ios", transport: serverAddress ? "remote" : "usb",
                        state: cached.state, model: cached.info?.productType || "", name: cached.info?.deviceName || "iPhone",
                        version: cached.info?.productVersion || "", error: cached.error || null, address: serverAddress || null });
                }
            }));
            for (const key of metadata.keys()) { if (!udids.includes(key)) { metadata.delete(key); } }
            discoveryError = null;
            return devices;
        } catch (error) {
            discoveryError = `${serverAddress ? `usbmuxd ${serverAddress}` : "本机 usbmuxd"}：${error.message}`;
            return [];
        }
    }

    function listDevices() {
        if (!discoveryPromise) { discoveryPromise = discover().finally(() => { discoveryPromise = null; }); }
        return discoveryPromise;
    }

    async function applications(id) {
        await validate(id);
        const result = parsePlist(await deviceRun(id, "ideviceinstaller", ["list", "--user", "--xml"], { timeout: 20000 }));
        if (!Array.isArray(result)) { throw new Error("iOS 应用列表格式错误"); }
        return result.map(app => ({ packageName: String(app.CFBundleIdentifier || ""),
            name: String(app.CFBundleDisplayName || app.CFBundleName || app.CFBundleIdentifier || ""),
            version: String(app.CFBundleShortVersionString || app.CFBundleVersion || "") }))
            .filter(app => /^[a-z0-9][a-z0-9_.-]{0,254}$/i.test(app.packageName));
    }

    async function install(id, file) {
        await validate(id);
        return deviceRun(id, "ideviceinstaller", ["install", file], { timeout: 180000, includeStderr: true });
    }

    async function uninstall(id, packageName) {
        if (typeof packageName !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,254}$/i.test(packageName)) {
            throw new Error("iOS 应用 Bundle ID 无效");
        }
        if (!(await applications(id)).some(app => app.packageName === packageName)) {
            throw new Error("该应用不在当前设备的用户应用列表中");
        }
        return deviceRun(id, "ideviceinstaller", ["uninstall", packageName], { timeout: 60000, includeStderr: true });
    }

    async function screenshot(id) {
        const details = await info(id);
        const capability = screenshotCapability(details.productVersion);
        if (!capability.supported) { throw Object.assign(new Error(capability.reason), { statusCode: 501 }); }
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ios-screenshot-"));
        const file = path.join(directory, "screenshot.png");
        try {
            await deviceRun(id, "idevicescreenshot", [file], { timeout: 20000 });
            const stat = await fs.promises.stat(file);
            if (!stat.isFile() || stat.size > 32 * 1024 * 1024) { throw new Error("截图文件无效或超过 32 MB"); }
            const data = await fs.promises.readFile(file);
            if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
                return { data, contentType: "image/png", extension: "png" };
            }
            if (["49492a00", "4d4d002a"].includes(data.subarray(0, 4).toString("hex"))) {
                return { data, contentType: "image/tiff", extension: "tiff" };
            }
            throw new Error("截图工具未返回有效图像");
        } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    }

    async function logs(id, { durationMs = 3000, lines = 500, search = "", signal } = {}) {
        if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 10000 ||
            !Number.isInteger(lines) || lines < 20 || lines > 2000 || typeof search !== "string" || search.length > 200) {
            throw new Error("日志采集时间需为 1–10 秒，行数需为 20–2000，关键词不超过 200 字符");
        }
        if (activeLogs.has(id) || activeLogs.size >= 4) {
            throw Object.assign(new Error("日志正在采集中，请稍后重试"), { statusCode: 409 });
        }
        activeLogs.add(id);
        try {
            await validate(id);
            if (signal?.aborted) { throw new Error("日志采集已取消"); }
            return await new Promise((resolve, reject) => {
                const child = launch(path.join(toolsDir, "idevicesyslog"), ["-u", target(id), "--no-colors", "-x"],
                    { env: { ...environment }, stdio: ["ignore", "pipe", "pipe"] });
                let output = "", stderr = "", stopped = false, settled = false;
                let forceTimer;
                function stop() {
                    if (stopped) { return; }
                    stopped = true;
                    child.kill("SIGTERM");
                    forceTimer = setTimeout(() => child.kill("SIGKILL"), 500);
                }
                function finish(error) {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timer); clearTimeout(forceTimer);
                    signal?.removeEventListener("abort", stop);
                    if (error) { reject(iosError(error)); return; }
                    const term = search.toLowerCase();
                    const filtered = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)
                        .filter(line => line && (!term || line.toLowerCase().includes(term))).slice(-lines);
                    resolve({ output: filtered.join("\n"), lines: filtered.length, durationMs });
                }
                const timer = setTimeout(stop, durationMs);
                signal?.addEventListener("abort", stop, { once: true });
                child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
                child.stdout.on("data", chunk => { output = (output + chunk).slice(-2 * 1024 * 1024); });
                child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-65536); });
                child.once("error", finish);
                child.once("close", (code, exitSignal) => {
                    if (signal?.aborted) { finish(new Error("日志采集已取消")); }
                    else if ((!stopped && (code !== 0 || exitSignal)) || /(?:^|\n)ERROR:/i.test(`${output}\n${stderr}`)) {
                        finish(Object.assign(new Error(stderr || output || "日志采集异常中断"), { stdout: output, stderr }));
                    } else { finish(); }
                });
            });
        } finally { activeLogs.delete(id); }
    }

    return { listDevices, assertPresent, info, pair, validate, applications, install, uninstall, screenshot, logs,
        status: () => ({ enabled, available, server: serverAddress || null, error: discoveryError }) };
}

module.exports = { createIosAdapter, isIosDevice, parseIosDevice, normalizeIosServer, parsePlist, screenshotCapability };
