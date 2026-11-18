"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { screenshotCapability } = require("./ios");

function createIosApi(ios, { json, readJson, receiveFile, safeName, downloadHeader, errorMessage, control }) {
    return async function handleIosApi(request, response, url, id) {
        try {
            const route = url.pathname;
            if (control && request.method === "GET" && route === "/local-api/device/control") {
                const apps = await ios.applications(id);
                json(response, 200, { ...await control.status(id), installed: apps.filter(app =>
                    /device[ -]?kit/i.test(`${app.packageName} ${app.name}`)) });
                return;
            }
            if (control && request.method === "POST" && route === "/local-api/device/control") {
                const body = await readJson(request);
                if (body.action === "connect") {
                    await ios.validate(id);
                    json(response, 200, await control.connect(id));
                } else if (body.action === "disconnect") {
                    json(response, 200, await control.disconnect(id));
                } else { json(response, 200, await control.action(id, body)); }
                return;
            }
            if (control && request.method === "GET" && route === "/local-api/device/control/frame") {
                const frame = await control.frame(id);
                response.writeHead(200, { "Content-Type": frame.contentType, "Content-Length": frame.data.length, "Cache-Control": "no-store" });
                response.end(frame.data);
                return;
            }
            if (control && request.method === "GET" && route === "/local-api/device/control/stream") {
                await control.stream(id, response, { format: url.searchParams.get("format") || "mjpeg" });
                return;
            }
            if (request.method === "GET" && ["/local-api/device/config", "/local-api/device/info"].includes(route)) {
                const info = await ios.info(id);
                json(response, 200, { deviceId: id, protocol: "ios", info,
                    capabilities: { info: true, pair: true, logs: true, apps: true, stream: false, shell: false,
                        screenshot: screenshotCapability(info.productVersion) } });
                return;
            }
            if (request.method === "POST" && route === "/local-api/device/pair") {
                const body = await readJson(request);
                if (body.action && body.action !== "pair") { throw new Error("未知 iOS 配对操作"); }
                json(response, 200, { ok: true, message: await ios.pair(id) });
                return;
            }
            if (request.method === "GET" && route === "/local-api/device/screenshot") {
                const screenshot = await ios.screenshot(id);
                response.writeHead(200, { ...downloadHeader(`iphone-${Date.now()}.${screenshot.extension}`, screenshot.contentType),
                    "Content-Length": screenshot.data.length, "Cache-Control": "no-store" });
                response.end(screenshot.data);
                return;
            }
            if (request.method === "GET" && route === "/local-api/logs") {
                const controller = new AbortController();
                const abort = () => controller.abort();
                response.once("close", abort);
                try {
                    const logs = await ios.logs(id, { durationMs: Number(url.searchParams.get("durationMs") || 3000),
                        lines: Number(url.searchParams.get("lines") || 500), search: url.searchParams.get("search") || "",
                        signal: controller.signal });
                    if (!response.destroyed) { json(response, 200, logs); }
                } finally { response.removeListener("close", abort); }
                return;
            }
            if (request.method === "GET" && route === "/local-api/apps") {
                json(response, 200, { apps: await ios.applications(id) });
                return;
            }
            if (request.method === "POST" && route === "/local-api/apps") {
                const body = await readJson(request);
                if (body.action !== "uninstall") { throw new Error("未知 iOS 应用操作"); }
                json(response, 200, { ok: true, message: await ios.uninstall(id, body.packageName) });
                return;
            }
            if (request.method === "POST" && route === "/local-api/apps/install") {
                const name = safeName(url.searchParams.get("name") || "");
                if (!/\.ipa$/i.test(name)) { throw new Error("请选择已正确签名的 IPA 应用包"); }
                const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ios-install-"));
                const temporary = path.join(directory, "application.ipa");
                try {
                    const size = await receiveFile(request, temporary);
                    const message = await ios.install(id, temporary);
                    json(response, 200, { ok: true, name, size, message });
                } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
                return;
            }
            json(response, 501, { error: "此 iOS 功能尚未接入；画面控制需在“画面”页连接已启动的 DeviceKit，通用 Shell 不可用" });
        } catch (error) {
            console.error(`${request.method} ${url.pathname} (iOS): ${errorMessage(error)}`);
            if (!response.headersSent && !response.destroyed) {
                json(response, error.statusCode || 400, { error: errorMessage(error),
                    ...(error.code === "IOS_DEVICE_LOCKED" ? { code: error.code, locked: true } : {}) });
            }
            else if (!response.destroyed) { response.destroy(); }
        }
    };
}

module.exports = { createIosApi };
