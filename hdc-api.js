"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { normalizeHdcPath, quote } = require("./hdc");

function hapCapabilities(status) {
    return {
        hap: { installed: status.installed, running: status.process, listening: status.listening, available: status.available,
            reason: status.reason },
        streamMode: status.available ? "hap" : "jpeg",
        streamFallback: "jpeg"
    };
}

function createHdcApi(hdc, { json, readJson, receiveFile, safeName, downloadHeader, errorMessage } = {}) {
    return async function handleHdcApi(request, response, url, id) {
        try {
            const route = url.pathname;
            if (request.method === "GET" && route === "/local-api/device/config") {
                const device = await hdc.assertConnected(id);
                const hap = await hdc.hapStatus(id).catch(() => ({ installed: false, process: false, listening: false,
                    available: false, reason: "无法探测 HAP 服务，使用截图回退" }));
                json(response, 200, { deviceId: id, protocol: "hdc", fileRoot: hdc.fileRoot,
                    device,
                    capabilities: { shell: true, files: true, logs: true, apps: true, stream: true, input: true,
                        ...hapCapabilities(hap) } });
                return;
            }
            if (request.method === "POST" && route === "/local-api/hap/start") {
                const status = await hdc.ensureHap(id);
                json(response, 200, { ok: true, hap: status });
                return;
            }
            if (request.method === "GET" && route === "/local-api/live") {
                const width = Number(url.searchParams.get("width") || 720);
                if (!Number.isInteger(width) || width < 180 || width > 1080) {
                    throw new Error("截图宽度必须在 180 到 1080 之间");
                }
                const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hdc-frame-"));
                const temporary = path.join(temporaryDirectory, "frame.jpeg");
                try {
                    const frame = await hdc.captureJpeg(id, temporary, width);
                    response.writeHead(200, {
                        "Content-Type": "image/jpeg",
                        "Content-Length": frame.size,
                        "Cache-Control": "no-store, no-cache, must-revalidate",
                        "Pragma": "no-cache",
                        "X-Device-Width": frame.deviceWidth ? String(frame.deviceWidth) : "",
                        "X-Device-Height": frame.deviceHeight ? String(frame.deviceHeight) : ""
                    });
                    await pipeline(fs.createReadStream(temporary), response);
                } finally {
                    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
                }
                return;
            }
            if (request.method === "POST" && route === "/local-api/input") {
                const body = await readJson(request);
                json(response, 200, await hdc.sendInput(id, body.action, body));
                return;
            }
            if (request.method === "POST" && route === "/local-api/shell") {
                const body = await readJson(request);
                const command = String(body.command || "").trim();
                if (!command || command.length > 4000 || command.includes("\0")) {
                    throw new Error("命令不能为空且不能超过 4000 个字符");
                }
                const startedAt = Date.now();
                const output = await hdc.shell(id, command, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, includeStderr: true });
                json(response, 200, { output, durationMs: Date.now() - startedAt });
                return;
            }
            if (request.method === "GET" && route === "/local-api/files") {
                const remotePath = normalizeHdcPath(url.searchParams.get("path") || hdc.fileRoot);
                json(response, 200, { path: remotePath, files: await hdc.listFiles(id, remotePath) });
                return;
            }
            if (request.method === "POST" && route === "/local-api/files/mkdir") {
                const body = await readJson(request);
                const remotePath = normalizeHdcPath(body.path || "", false);
                await hdc.ensureBoundary(id, path.posix.dirname(remotePath));
                await hdc.shell(id, `mkdir ${quote(remotePath)}`, { checkFailure: true, includeStderr: true });
                json(response, 200, { ok: true, path: remotePath });
                return;
            }
            if (request.method === "DELETE" && route === "/local-api/files") {
                const remotePath = normalizeHdcPath(url.searchParams.get("path") || "", false);
                await hdc.ensureBoundary(id, remotePath);
                await hdc.shell(id, `rm -rf -- ${quote(remotePath)}`, { checkFailure: true, includeStderr: true });
                json(response, 200, { ok: true, path: remotePath });
                return;
            }
            if (request.method === "POST" && route === "/local-api/files/upload") {
                const directory = normalizeHdcPath(url.searchParams.get("path") || hdc.fileRoot);
                const name = safeName(url.searchParams.get("name") || "");
                const destination = normalizeHdcPath(path.posix.join(directory, name), false);
                await hdc.ensureBoundary(id, directory);
                const temporary = path.join(os.tmpdir(), `hdc-upload-${crypto.randomUUID()}`);
                try {
                    const size = await receiveFile(request, temporary);
                    await hdc.sendFile(id, temporary, destination);
                    json(response, 200, { ok: true, path: destination, size });
                } finally {
                    await fs.promises.rm(temporary, { force: true });
                }
                return;
            }
            if (request.method === "GET" && route === "/local-api/files/download") {
                const remotePath = normalizeHdcPath(url.searchParams.get("path") || "", false);
                const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hdc-download-"));
                const temporary = path.join(temporaryDirectory, "download");
                try {
                    const size = await hdc.receiveFile(id, remotePath, temporary);
                    response.writeHead(200, { ...downloadHeader(path.posix.basename(remotePath)), "Content-Length": size });
                    await pipeline(fs.createReadStream(temporary), response);
                } finally {
                    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
                }
                return;
            }
            if (request.method === "GET" && route === "/local-api/apps") {
                json(response, 200, { apps: await hdc.applications(id) });
                return;
            }
            if (request.method === "POST" && route === "/local-api/apps") {
                const body = await readJson(request);
                if (body.action !== "uninstall") {
                    throw new Error("当前仅支持卸载鸿蒙应用");
                }
                json(response, 200, await hdc.uninstall(id, body.packageName));
                return;
            }
            if (request.method === "POST" && route === "/local-api/apps/install") {
                const name = safeName(url.searchParams.get("name") || "");
                const extension = path.extname(name).toLowerCase();
                if (![".hap", ".hsp"].includes(extension)) {
                    throw new Error("请选择 HAP 或 HSP 应用包");
                }
                const temporary = path.join(os.tmpdir(), `hdc-install-${crypto.randomUUID()}${extension}`);
                try {
                    const size = await receiveFile(request, temporary);
                    const message = await hdc.install(id, temporary);
                    json(response, 200, { ok: true, name, size, message });
                } finally {
                    await fs.promises.rm(temporary, { force: true });
                }
                return;
            }
            if (request.method === "GET" && route === "/local-api/logs") {
                const lines = Number(url.searchParams.get("lines") || 300);
                if (!Number.isInteger(lines) || lines < 20 || lines > 2000) {
                    throw new Error("日志行数必须在 20 到 2000 之间");
                }
                const output = await hdc.shell(id, "hilog -x", { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
                const search = (url.searchParams.get("search") || "").toLowerCase();
                const filtered = output.split(/\r?\n/).filter(line => line && (!search || line.toLowerCase().includes(search))).slice(-lines);
                json(response, 200, { output: filtered.join("\n"), lines: filtered.length });
                return;
            }
            json(response, 501, { error: "鸿蒙设备尚未接入此功能；可使用画面、触控、文件、Shell、HiLog 和应用管理" });
        } catch (error) {
            console.error(`${request.method} ${url.pathname} (HDC): ${errorMessage(error)}`);
            if (!response.headersSent) {
                json(response, 400, { error: errorMessage(error) });
            } else {
                response.destroy();
            }
        }
    };
}

module.exports = { createHdcApi, hapCapabilities };
