"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const FILE_ROOT = "/data/local/tmp";
const PREFIX = "hdc://";

function isHdcDevice(id) {
    return typeof id === "string" && id.startsWith(PREFIX);
}

function targetKey(id) {
    return parseHdcDevice(id).key;
}

function parseHdcDevice(id) {
    const separator = isHdcDevice(id) ? id.indexOf("/", PREFIX.length) : -1;
    if (separator < 0) {
        throw new Error("HDC 设备标识无效，请重新手动连接服务");
    }
    const server = normalizeHdcAddress(id.slice(PREFIX.length, separator));
    const key = id.slice(separator + 1);
    if (!/^[a-zA-Z0-9_\[\]][a-zA-Z0-9_.:\[\]-]{0,510}$/.test(key)) {
        throw new Error("HDC 设备标识无效");
    }
    return { server, key };
}

function parseHdcTargets(output) {
    return output.replace(/\r/g, "").split("\n").map(line => line.trim())
        .filter(line => line && (!line.startsWith("[") || /^\[[0-9a-f:.]+\]:\d+\s/i.test(line)) &&
            !/^(?:ConnectKey|Connect key|List of)/i.test(line))
        .map(line => {
            const fields = line.split(/\s+/);
            const key = fields[0];
            if (!/^[a-zA-Z0-9_\[\]][a-zA-Z0-9_.:\[\]-]{0,510}$/.test(key)) {
                return null;
            }
            const status = fields.slice(1).join(" ").toLowerCase();
            const state = /unauthor|not.?author|auth.*(?:fail|pending)|permit|unauth/.test(status) ? "unauthorized" :
                /offline|disconnect|unknown/.test(status) ? "offline" :
                fields.length === 1 || /\b(?:connected|ready|online)\b/.test(status) ? "device" : "offline";
            return { key, state, transport: /\btcp\b/i.test(status) || key.includes(":") ? "network" : "usb" };
        }).filter(Boolean);
}

function normalizeHdcAddress(value) {
    const address = typeof value === "string" ? value.trim() : "";
    const net = require("node:net");
    const match = address.match(/^(\[[^\]]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}):(\d{1,5})$/);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 ||
        (match[1].startsWith("[") && net.isIP(match[1].slice(1, -1)) !== 6)) {
        throw new Error("请输入 IP:端口形式的有效 HDC 地址");
    }
    const host = match[1].toLowerCase() === "localhost" ? "127.0.0.1" : match[1].toLowerCase();
    return `${host}:${Number(match[2])}`;
}

function normalizeHdcPath(value, allowRoot = true) {
    if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
        throw new Error("文件路径无效");
    }
    const normalized = path.posix.normalize(value.startsWith("/") ? value : `${FILE_ROOT}/${value}`);
    if (normalized !== FILE_ROOT && !normalized.startsWith(`${FILE_ROOT}/`)) {
        throw new Error(`只允许访问 ${FILE_ROOT}`);
    }
    if (!allowRoot && normalized === FILE_ROOT) {
        throw new Error("不允许操作文件根目录");
    }
    return normalized;
}

function quote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function packageName(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/.test(value)) {
        throw new Error("鸿蒙应用包名无效");
    }
    return value;
}

function parseHapStatus({ bundleOutput = "", processOutput = "", listenerOutput = "" } = {}) {
    const installed = /com\.ohos\.scrcpy\.server:\s*\{/.test(bundleOutput) ||
        /\bbundleName\b\s+"?com\.ohos\.scrcpy\.server"?/.test(bundleOutput);
    const process = /(?:^|\n)\s*\d+\s+com\.ohos\.scrcpy\.server(?:\s|$)/m.test(processOutput);
    const listening = /(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\])\s*:53535\s+/m.test(listenerOutput);
    let reason = "HAP 已安装，可以尝试连接 H.264";
    if (!installed) {
        reason = "未安装 HAP 服务，使用截图回退";
    } else if (!process) {
        reason = "HAP 服务未运行，使用截图回退";
    } else if (!listening) {
        reason = "HAP 服务未监听 53535，使用截图回退";
    }
    return { installed, process, listening, available: installed && process && listening, reason };
}

function createHdcAdapter({ executable = path.join(__dirname, "vendor/hdc/linux-x64/hdc"), server = "",
    enabled = true, execute = execFile } = {}) {
    const serverAddress = server ? normalizeHdcAddress(server) : null;
    const remoteServer = serverAddress && !["127.0.0.1", "[::1]"].includes(serverAddress.slice(0, serverAddress.lastIndexOf(":")));
    const names = new Map();
    const displaySizes = new Map();
    const hapStatuses = new Map();
    const forwardPorts = new Map();
    let discoveryError = null;
    let discoveryPromise = null;
    const available = fs.existsSync(executable);

    function run(args, options = {}) {
        if (!enabled || !available) {
            return Promise.reject(new Error(enabled ? "项目内的 HDC 工具不可用" : "HDC 已禁用"));
        }
        if (!serverAddress) {
            return Promise.reject(new Error("请先填写 HDC 服务地址并连接"));
        }
        return new Promise((resolve, reject) => {
            execute(executable, ["-s", serverAddress, ...(remoteServer ? ["-p"] : []), ...args], {
                timeout: options.timeout || 10000,
                maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
                encoding: "utf8"
            }, (error, stdout = "", stderr = "") => {
                if (error) {
                    error.stdout = stdout;
                    error.stderr = stderr;
                    if (error.killed || error.code === "ETIMEDOUT") {
                        error.message = `HDC 服务 ${serverAddress} 连接超时，请检查服务监听地址和网络`;
                    }
                    reject(error);
                } else if (options.checkFailure && /\[Fail\]|\b(?:failed to|connect failed|permission denied)\b/i.test(`${stdout}\n${stderr}`)) {
                    reject(new Error(`${stdout}\n${stderr}`.trim()));
                } else {
                    resolve(options.includeStderr ? `${stdout}${stderr}` : stdout);
                }
            });
        });
    }

    function deviceRun(id, args, options) {
        const device = parseHdcDevice(id);
        if (device.server !== serverAddress) {
            throw new Error("HDC 设备与服务地址不匹配");
        }
        return run(["-t", device.key, ...args], options);
    }

    function shell(id, command, options) {
        return deviceRun(id, ["shell", command], options);
    }

    async function discoverDevices() {
        if (!enabled || !available || !serverAddress) {
            discoveryError = enabled && !available ? "项目内的 HDC 工具不可用" : null;
            return [];
        }
        try {
            const output = await run(["list", "targets", "-v"], { timeout: 5000, checkFailure: true });
            const targets = parseHdcTargets(output);
            discoveryError = null;
            return await Promise.all(targets.map(async target => {
                const id = `${PREFIX}${serverAddress}/${target.key}`;
                let cached = names.get(target.key);
                if (target.state === "device" && (!cached || Date.now() - cached.time > 30000)) {
                    const model = (await shell(id, "param get const.product.model", { timeout: 2000 }).catch(() => "")).trim();
                    cached = { model: model && model.length < 120 && !/[\r\n]/.test(model) && !/not found|fail|error/i.test(model) ? model : "", time: Date.now() };
                    names.set(target.key, cached);
                    if (names.size > 200) {
                        names.delete(names.keys().next().value);
                    }
                }
                return { id, serial: id, connectKey: target.key, protocol: "hdc", type: "harmony",
                    transport: target.transport, state: target.state, model: cached?.model || "",
                    name: cached?.model || target.key, address: target.transport === "network" ? target.key : null };
            }));
        } catch (error) {
            const message = error.stderr?.trim() || error.stdout?.trim() || error.message;
            discoveryError = message.startsWith(`HDC 服务 ${serverAddress}`) ? message : `HDC 服务 ${serverAddress}：${message}`;
            return [];
        }
    }

    function listDevices() {
        if (!discoveryPromise) {
            discoveryPromise = discoverDevices().finally(() => { discoveryPromise = null; });
        }
        return discoveryPromise;
    }

    async function assertConnected(id) {
        targetKey(id);
        const device = (await listDevices()).find(item => item.serial === id);
        if (!device || device.state !== "device") {
            throw new Error(discoveryError || "鸿蒙设备未连接或尚未授权，请在设备上允许 HDC 调试");
        }
        return device;
    }

    async function localForwardPort(id) {
        const target = targetKey(id);
        const existing = forwardPorts.get(target);
        if (Number.isInteger(existing)) {
            return existing;
        }
        // remoteServer is informational only; the local socket belongs to the
        // HDC server reachable from this gateway. Verify it instead of assuming
        // that a forward created by another HDC process is local.
        for (let port = 40000 + Math.floor(Math.random() * 20000); port < 65535; port += 1) {
            try {
                await forward(id, port);
            } catch {
                continue;
            }
            const reachable = await new Promise(resolve => {
                const net = require("node:net");
                const socket = net.connect({ host: "127.0.0.1", port });
                const finish = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
                socket.setTimeout(600, () => finish(false));
                socket.once("connect", () => finish(true));
                socket.once("error", () => finish(false));
            });
            if (reachable) {
                forwardPorts.set(target, port);
                return port;
            }
        }
        throw new Error("HDC 端口转发未在当前网关生效，HAP 视频不可达");
    }

    async function connect(address) {
        const normalized = normalizeHdcAddress(address);
        await run(["tconn", normalized], { timeout: 15000, checkFailure: true, includeStderr: true });
        const id = `${PREFIX}${serverAddress}/${normalized}`;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const device = (await listDevices()).find(item => item.serial === id);
            if (device?.state === "device") {
                return id;
            }
            if (device?.state === "unauthorized") {
                throw new Error("请在鸿蒙设备上允许 HDC 调试，然后重新连接");
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error(discoveryError || "HDC 连接后未发现可用设备，请检查调试授权和地址");
    }

    async function forward(id, localPort) {
        if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
            throw new Error("HDC 转发端口无效");
        }
        const output = await deviceRun(id, ["fport", `tcp:${localPort}`, "tcp:53535"],
            { timeout: 5000, checkFailure: true, includeStderr: true });
        if (!/Forwardport result:\s*OK/i.test(output)) {
            throw new Error(output.trim() || "HDC 视频转发失败");
        }
        return localPort;
    }

    async function ensureBoundary(id, remotePath) {
        const output = await shell(id, `realpath ${quote(FILE_ROOT)} && realpath ${quote(remotePath)}`);
        const lines = output.trim().split(/\r?\n/);
        const [root, resolved] = lines;
        if (lines.length !== 2 || !root.startsWith("/") || (resolved !== root && !resolved.startsWith(`${root}/`))) {
            throw new Error(`文件真实路径超出 ${FILE_ROOT} 或不可访问`);
        }
        return resolved;
    }

    async function listFiles(id, remotePath) {
        await ensureBoundary(id, remotePath);
        const output = await shell(id, `find ${quote(remotePath)} -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} \\;`);
        return output.split(/\r?\n/).filter(Boolean).map(line => {
            const match = line.match(/^([^|]+)\|(\d+)\|(\d+)\|(.+)$/);
            if (!match) {
                return null;
            }
            let itemPath;
            try { itemPath = normalizeHdcPath(match[4]); } catch { return null; }
            return { name: path.posix.basename(itemPath), path: itemPath, directory: match[1] === "directory",
                size: Number(match[2]), modified: Number(match[3]) * 1000 };
        }).filter(Boolean).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    }

    async function sendFile(id, localPath, remotePath) {
        await ensureBoundary(id, path.posix.dirname(remotePath));
        const target = quote(remotePath);
        const existing = (await shell(id, `if [ -e ${target} ] || [ -L ${target} ]; then realpath ${target}; fi`)).trim();
        if (existing) {
            await ensureBoundary(id, remotePath);
        }
        await deviceRun(id, ["file", "send", localPath, remotePath], { timeout: 30 * 60 * 1000, checkFailure: true, includeStderr: true });
    }

    async function receiveFile(id, remotePath, localPath) {
        await ensureBoundary(id, remotePath);
        const kind = (await shell(id, `stat -c '%F' ${quote(remotePath)}`)).trim();
        if (kind !== "regular file") {
            throw new Error("只能下载普通文件");
        }
        await deviceRun(id, ["file", "recv", remotePath, localPath], { timeout: 30 * 60 * 1000, checkFailure: true, includeStderr: true });
        const stat = await fs.promises.stat(localPath);
        if (!stat.isFile()) {
            throw new Error("HDC 文件接收失败");
        }
        return stat.size;
    }

    async function displaySize(id) {
        const device = parseHdcDevice(id);
        const cached = displaySizes.get(device.key);
        if (cached && Date.now() - cached.time < 60000) {
            return cached;
        }
        const output = await shell(id, "hidumper -s RenderService -a screen", { timeout: 5000 });
        const match = output.match(/render resolution=(\d+)x(\d+)/i) || output.match(/activeMode: (\d+)x(\d+)/i);
        if (!match) {
            throw new Error("无法读取鸿蒙设备显示尺寸");
        }
        const result = { width: Number(match[1]), height: Number(match[2]), time: Date.now() };
        displaySizes.set(device.key, result);
        return result;
    }

    async function hapStatus(id) {
        const device = parseHdcDevice(id);
        const cached = hapStatuses.get(device.key);
        if (cached && Date.now() - cached.time < 5000) {
            return cached.status;
        }
        const [bundleOutput, processOutput, listenerOutput] = await Promise.all([
            shell(id, "bm dump -n com.ohos.scrcpy.server", { timeout: 5000 }).catch(() => ""),
            shell(id, "ps -o pid,args", { timeout: 5000 }).catch(() => ""),
            shell(id, "netstat -ltn", { timeout: 5000 }).catch(() => "")
        ]);
        const status = parseHapStatus({ bundleOutput, processOutput, listenerOutput });
        hapStatuses.set(device.key, { status, time: Date.now() });
        return status;
    }

    async function ensureHap(id) {
        const device = parseHdcDevice(id);
        const packageCheck = await shell(id, "bm dump -n com.ohos.scrcpy.server", { timeout: 5000 }).catch(() => "");
        if (!/com\.ohos\.scrcpy\.server:\s*\{/.test(packageCheck)) {
            throw new Error("鸿蒙设备未安装 HAP 服务");
        }
        let status = await hapStatus(id);
        if (!status.process || !status.listening) {
            await shell(id, "aa start -a EntryAbility -b com.ohos.scrcpy.server", { timeout: 10000, includeStderr: true });
            hapStatuses.delete(device.key);
            for (let attempt = 0; attempt < 12; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 250));
                status = await hapStatus(id);
                if (status.process && status.listening) { break; }
            }
        }
        if (!status.process || !status.listening) {
            throw new Error(status.reason === "HAP 已安装，可以尝试连接 H.264" ?
                "HAP 服务未能启动或监听 53535" : status.reason);
        }
        return status;
    }

    async function startHapBridge(id, { host, port, token }) {
        if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 ||
            !/^[a-zA-Z0-9_-]{20,128}$/.test(token)) {
            throw new Error("HAP 桥接参数无效");
        }
        await ensureHap(id);
        const command = `aa start -a EntryAbility -b com.ohos.scrcpy.server ` +
            `--ps webBridgeHost ${host} --ps webBridgePort ${port} --ps webBridgeToken ${token}`;
        const output = await shell(id, command, { timeout: 10000, includeStderr: true });
        if (!/start ability successfully/i.test(output)) {
            throw new Error(output.trim() || "HAP 桥接启动失败");
        }
        return true;
    }

    async function captureJpeg(id, localPath, width = 720) {
        if (!Number.isInteger(width) || width < 180 || width > 1080) {
            throw new Error("截图宽度必须在 180 到 1080 之间");
        }
        const display = await displaySize(id);
        const height = Math.max(1, Math.round(width * display.height / display.width));
        const filename = `physical-web-${Date.now()}-${Math.random().toString(16).slice(2)}.jpeg`;
        const remotePath = `${FILE_ROOT}/${filename}`;
        const info = await shell(id, `snapshot_display -f ${quote(remotePath)} -w ${width} -h ${height} -t jpeg`,
            { timeout: 10000, maxBuffer: 1024 * 1024, includeStderr: true });
        try {
            const size = await receiveFile(id, remotePath, localPath);
            if (size < 4) {
                throw new Error("鸿蒙设备返回了空截图");
            }
            const match = info.match(/process: display \d+, file type: jpeg, width: (\d+), height: (\d+)/i);
            return {
                size,
                deviceWidth: match ? Number(match[1]) : display.width,
                deviceHeight: match ? Number(match[2]) : display.height
            };
        } finally {
            await shell(id, `rm -f ${quote(remotePath)}`, { timeout: 5000 }).catch(() => {});
        }
    }

    async function sendInput(id, action, body = {}) {
        const displayId = Number.isInteger(body.displayId) && body.displayId >= 0 && body.displayId < 32 ? body.displayId : 0;
        const coordinate = (value, name) => {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 0 || number > 16384) {
                throw new Error(`${name}坐标无效`);
            }
            return number;
        };
        let command;
        if (action === "click" || action === "longClick" || action === "doubleClick") {
            command = `${action} ${coordinate(body.x, "X")} ${coordinate(body.y, "Y")} ${displayId}`;
        } else if (action === "swipe") {
            command = `swipe ${coordinate(body.x, "起点 X")} ${coordinate(body.y, "起点 Y")} ` +
                `${coordinate(body.x2, "终点 X")} ${coordinate(body.y2, "终点 Y")} 600 ${displayId}`;
        } else if (action === "keyEvent") {
            if (!["Home", "Back", "Power"].includes(body.key)) {
                throw new Error("不支持此按键");
            }
            command = `keyEvent ${body.key} ${displayId}`;
        } else if (action === "text") {
            const text = typeof body.text === "string" ? body.text : "";
            if (!text || text.length > 1024 || /[\0\r\n]/.test(text)) {
                throw new Error("输入文本无效");
            }
            command = `inputText ${coordinate(body.x, "X")} ${coordinate(body.y, "Y")} ${quote(text)} ${displayId}`;
        } else {
            throw new Error("不支持的鸿蒙输入操作");
        }
        const output = await shell(id, `uitest uiInput ${command}`, { timeout: 10000, includeStderr: true });
        if (!/No Error|success/i.test(output) && /error|fail|invalid/i.test(output)) {
            throw new Error(output.trim() || "鸿蒙输入注入失败");
        }
        return { ok: true, action, output: output.trim() };
    }

    async function install(id, localPath) {
        const output = await deviceRun(id, ["install", "-r", localPath], { timeout: 30 * 60 * 1000, checkFailure: true, includeStderr: true });
        if (!/\bsuccess\b|successfully/i.test(output)) {
            throw new Error(output.trim() || "鸿蒙应用安装失败");
        }
        return output.trim();
    }

    async function applications(id) {
        const output = await shell(id, "bm dump -a");
        return [...new Set(output.split(/\r?\n/).map(line => line.trim().replace(/^\[|\]$/g, ""))
            .filter(line => /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/.test(line)))]
            .sort().map(name => ({ packageName: name }));
    }

    async function uninstall(id, name) {
        const output = await deviceRun(id, ["uninstall", packageName(name)], { timeout: 120000, checkFailure: true, includeStderr: true });
        if (!/\bsuccess\b|successfully/i.test(output)) {
            throw new Error(output.trim() || "鸿蒙应用卸载失败");
        }
        return { ok: true, packageName: name };
    }

    function status() {
        return { enabled, available, configured: Boolean(serverAddress), server: serverAddress, error: discoveryError };
    }

    return { listDevices, assertConnected, connect, forward, shell, ensureBoundary, listFiles, sendFile, receiveFile, captureJpeg,
        hapStatus, ensureHap, startHapBridge, localForwardPort, sendInput, install, applications, uninstall, status, fileRoot: FILE_ROOT };
}

module.exports = { createHdcAdapter, isHdcDevice, parseHdcDevice, targetKey, parseHdcTargets, parseHapStatus,
    normalizeHdcAddress, normalizeHdcPath, quote };
