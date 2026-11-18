(() => {
    "use strict";

    const id = new URLSearchParams(location.search).get("device");
    const separator = id?.startsWith("hdc://") ? id.indexOf("/", 6) : -1;
    const key = separator > 6 ? id.slice(separator + 1) : "";
    const byId = name => document.getElementById(name);
    const aliasKey = "physical-web.device-aliases.v1";
    let fileRoot = "/data/local/tmp";
    let currentPath = fileRoot;
    let model = key || "鸿蒙设备";
    let apps = [];
    let activeTab = "screen";
    let hapInstalled = false;
    let logTimer;
    let logsActive = false;
    let connectionActive = false;
    let screenTimer = null;
    let screenLoading = false;
    let screenMode = "idle";
    let hapPlayer = null;
    let hapConnecting = false;
    let hapRetryTimer = null;
    let pointerStart = null;
    let lastInputPoint = null;
    let deviceWidth = 1280;
    let deviceHeight = 2832;

    function post(update) {
        if (parent !== window) {
            parent.postMessage({ type: "physical-web:device-telemetry", device: id, ...update }, location.origin);
        }
    }

    function status(message, error = false) {
        byId("tool-status").textContent = message;
        byId("tool-status").classList.toggle("error", error);
    }

    function apiUrl(route) {
        const url = new URL(route, location.origin);
        url.searchParams.set("device", id || "");
        return `${url.pathname}${url.search}`;
    }

    async function api(route, options = {}) {
        const response = await fetch(apiUrl(route), { cache: "no-store", ...options });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(body.error || `请求失败 (${response.status})`);
        }
        return body;
    }

    function send(route, body) {
        return api(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }

    async function action(button, callback) {
        if (button?.disabled) {
            return;
        }
        if (button) { button.disabled = true; }
        try { await callback(); } catch (error) { status(error.message, true); }
        finally {
            if (button) { button.disabled = false; }
            byId("file-up").disabled = currentPath === fileRoot;
        }
    }

    function aliases() {
        try {
            const value = JSON.parse(localStorage.getItem(aliasKey) || "{}");
            return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        } catch { return {}; }
    }

    function renderName() {
        byId("device-name").textContent = aliases()[id] || model;
        byId("device-key").textContent = key || "未指定设备";
    }

    async function refreshConnection() {
        if (connectionActive) { return; }
        connectionActive = true;
        try {
            if (!key) { throw new Error("请先从工作台添加鸿蒙设备"); }
            const config = await api("/local-api/device/config");
            model = config.device?.model || config.device?.name || key;
            fileRoot = config.fileRoot;
            hapInstalled = Boolean(config.capabilities?.hap?.installed);
            renderName();
            byId("connection-status").textContent = hapInstalled ?
                (config.capabilities?.hap?.running ? "HDC 已连接 · HAP 正在运行" : "HDC 已连接 · HAP 可自动启动") :
                "HDC 已连接 · 截图模式";
            byId("connection-status").dataset.state = "connected";
            post({ status: byId("connection-status").textContent, state: "connected" });
            return true;
        } catch (error) {
            byId("connection-status").textContent = error.message;
            byId("connection-status").dataset.state = "error";
            post({ status: error.message, state: "error" });
            throw error;
        } finally { connectionActive = false; }
    }

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) { node.textContent = text; }
        if (className) { node.className = className; }
        return node;
    }

    function button(text, callback, className) {
        const node = element("button", text, className);
        node.type = "button";
        node.addEventListener("click", () => action(node, callback));
        return node;
    }

    function formatSize(bytes) {
        if (bytes < 1024) { return `${bytes} B`; }
        return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    async function loadFiles(remotePath = currentPath) {
        status("正在读取文件");
        const body = await api(`/local-api/files?path=${encodeURIComponent(remotePath)}`);
        currentPath = body.path;
        byId("file-path").textContent = currentPath;
        byId("file-up").disabled = currentPath === fileRoot;
        const list = byId("file-list");
        list.replaceChildren();
        for (const item of body.files) {
            const row = element("div", undefined, "item-row");
            row.setAttribute("role", "listitem");
            const name = item.directory ? button(item.name, () => loadFiles(item.path), "item-name") : element("span", item.name, "item-name");
            name.appendChild(element("span", item.directory ? "文件夹" : formatSize(item.size), "item-meta"));
            row.appendChild(name);
            if (!item.directory) {
                const link = element("a", "下载");
                link.href = apiUrl(`/local-api/files/download?path=${encodeURIComponent(item.path)}`);
                row.appendChild(link);
            }
            row.appendChild(button("删除", async () => {
                if (!window.confirm(`确定删除“${item.name}”${item.directory ? "及其内容" : ""}吗？`)) { return; }
                await api(`/local-api/files?path=${encodeURIComponent(item.path)}`, { method: "DELETE" });
                await loadFiles();
            }, "danger"));
            list.appendChild(row);
        }
        if (!body.files.length) { list.appendChild(element("p", "此文件夹为空", "empty")); }
        status(`${body.files.length} 个项目`);
    }

    async function upload(route, file) {
        return api(route, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
    }

    async function loadApps() {
        status("正在读取鸿蒙应用");
        apps = (await api("/local-api/apps")).apps;
        renderApps();
        status(`${apps.length} 个应用`);
    }

    function renderApps() {
        const list = byId("app-list");
        const search = byId("app-search").value.trim().toLowerCase();
        list.replaceChildren();
        for (const app of apps.filter(item => item.packageName.toLowerCase().includes(search))) {
            const row = element("div", undefined, "item-row");
            row.setAttribute("role", "listitem");
            row.append(element("span", app.packageName, "item-name"), button("卸载", async () => {
                if (!window.confirm(`确定卸载 ${app.packageName} 吗？`)) { return; }
                status(`正在卸载 ${app.packageName}`);
                await send("/local-api/apps", { action: "uninstall", packageName: app.packageName });
                await loadApps();
            }, "danger"));
            list.appendChild(row);
        }
        if (!list.childElementCount) { list.appendChild(element("p", "没有匹配的应用", "empty")); }
    }

    async function loadLogs() {
        if (logsActive) { return; }
        logsActive = true;
        try {
            status("正在读取 HiLog");
            const query = new URLSearchParams({ lines: byId("log-lines").value, search: byId("log-search").value });
            const body = await api(`/local-api/logs?${query}`);
            byId("log-output").textContent = body.output || "暂无日志";
            status(`HiLog：${body.lines} 行`);
        } finally { logsActive = false; }
    }

    function screenUrl() {
        return apiUrl(`/local-api/live?width=720&frame=${Date.now()}`);
    }

    function setStreamMode(mode, detail = "") {
        screenMode = mode;
        const canvas = byId("device-screen-canvas");
        const image = byId("device-screen");
        canvas.hidden = mode !== "hap";
        image.hidden = mode === "hap";
        if (mode === "hap") {
            const jpeg = detail.includes("JPEG");
            byId("stream-mode").textContent = `HAP · ${jpeg ? "JPEG" : "H.264"} 实时视频`;
            byId("stream-note").textContent = "拖动画面可滑动，单击可点击。画面来自 HAP，输入仍由原有 HDC 控制接口执行。";
            post({ streamMode: jpeg ? "hap-jpeg" : "hap-h264", streamDetail: detail });
        } else if (mode === "jpeg") {
            byId("stream-mode").textContent = detail ? `截图回退 · JPEG · ${detail}` : "截图回退 · JPEG";
            byId("stream-note").textContent = "拖动画面可滑动，单击可点击。HAP 视频不可用，当前使用设备截图和原生输入。";
            post({ streamMode: "jpeg", streamDetail: detail });
        } else {
            byId("stream-mode").textContent = "正在检测 HAP 视频流；不可用时自动使用设备截图。";
        }
    }

    async function loadScreen() {
        if (screenMode === "hap" || screenLoading || document.hidden || activeTab !== "screen") { return; }
        screenLoading = true;
        const startedAt = performance.now();
        try {
            const response = await fetch(screenUrl(), { cache: "no-store" });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || `画面请求失败 (${response.status})`);
            }
            const blob = await response.blob();
            if (!blob.size) { throw new Error("设备返回了空画面"); }
            const reportedWidth = Number(response.headers.get("X-Device-Width"));
            const reportedHeight = Number(response.headers.get("X-Device-Height"));
            if (Number.isInteger(reportedWidth) && reportedWidth > 0 && Number.isInteger(reportedHeight) && reportedHeight > 0) {
                deviceWidth = reportedWidth;
                deviceHeight = reportedHeight;
            }
            const oldUrl = byId("device-screen").dataset.objectUrl;
            const objectUrl = URL.createObjectURL(blob);
            byId("device-screen").src = objectUrl;
            byId("device-screen").dataset.objectUrl = objectUrl;
            byId("device-screen").hidden = false;
            byId("device-screen-canvas").hidden = true;
            byId("screen-placeholder").hidden = true;
            if (oldUrl) { setTimeout(() => URL.revokeObjectURL(oldUrl), 50); }
            const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
            byId("screen-placeholder").textContent = `${elapsed} ms/帧`;
            status(`画面已更新 · ${elapsed} ms`);
        } catch (error) {
            stopScreen();
            status(error.message, true);
        } finally { screenLoading = false; }
    }

    function stopScreen() {
        clearTimeout(screenTimer);
        screenTimer = null;
        clearTimeout(hapRetryTimer);
        hapRetryTimer = null;
        hapPlayer?.stop();
        hapPlayer = null;
        screenMode = "idle";
        byId("device-screen").hidden = false;
        byId("device-screen-canvas").hidden = true;
        byId("connect-screen").textContent = "连接画面";
        byId("connect-screen").classList.add("primary");
    }

    function startScreen() {
        if (screenTimer) { return; }
        byId("connect-screen").textContent = "停止画面";
        byId("connect-screen").classList.remove("primary");
        setStreamMode("idle");
        byId("screen-placeholder").hidden = false;
        byId("screen-placeholder").textContent = "正在检测 HAP 视频…";
        const tick = async () => {
            if (!screenTimer) { return; }
            await loadScreen();
            if (screenTimer) { screenTimer = setTimeout(tick, 25); }
        };
        screenTimer = setTimeout(tick, 0);
        startHap().catch(error => fallbackToJpeg(error.message)).catch(error => status(error.message, true));
    }

    async function startHap() {
        if (!screenTimer || document.hidden || activeTab !== "screen" || screenMode === "hap" || hapConnecting) { return; }
        if (!hapInstalled || typeof createHdcH264Player !== "function") {
            await fallbackToJpeg(!hapInstalled ? "HAP 未安装" : "当前浏览器缺少 HAP 播放器");
            return;
        }
        hapConnecting = true;
        hapPlayer?.stop();
        hapPlayer = createHdcH264Player({
            canvas: byId("device-screen-canvas"),
            onConfig(config) {
                deviceWidth = config.width;
                deviceHeight = config.height;
                const codec = config.codec === 2 ? "JPEG" : config.codec === 0 ? "H.264" : "RAW";
                setStreamMode("hap", `${config.width}×${config.height} · ${config.fps} fps · ${codec}`);
                byId("screen-placeholder").hidden = true;
                byId("screen-placeholder").textContent = "";
            },
            onFrame({ width, height }) { deviceWidth = width; deviceHeight = height; },
            onDebug(message) { status(message); },
            onError(error) { fallbackToJpeg(error.message).catch(failure => status(failure.message, true)); }
        });
        const url = new URL(apiUrl("/local-api/hap/stream"), location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        try {
            const connection = await hapPlayer.start(url.toString());
            if (!connection || typeof connection.firstFrame?.then !== "function") {
                throw new Error("HAP 播放器未提供首帧状态");
            }
            const timeout = new Promise((_, reject) => {
                hapRetryTimer = setTimeout(() => reject(new Error("HAP 视频 8 秒内未返回首帧")), 8000);
            });
            await Promise.race([connection.firstFrame, timeout]);
        } catch (error) {
            await fallbackToJpeg(error.message);
        } finally {
            hapConnecting = false;
            clearTimeout(hapRetryTimer);
            hapRetryTimer = null;
        }
    }

    async function fallbackToJpeg(reason = "HAP 视频不可用") {
        if (!screenTimer || screenMode === "jpeg") { return; }
        hapPlayer?.stop();
        hapPlayer = null;
        hapConnecting = false;
        screenLoading = false;
        setStreamMode("jpeg", reason);
        byId("screen-placeholder").hidden = false;
        byId("screen-placeholder").textContent = "正在切换到截图预览…";
        await loadScreen();
    }

    async function input(action, extra = {}) {
        await send("/local-api/input", { action, ...extra });
        if (screenTimer) { setTimeout(() => { action === "swipe" || action === "text" ? null : loadScreen(); }, 100); }
    }

    function screenPoint(event) {
        const image = screenMode === "hap" ? byId("device-screen-canvas") : byId("device-screen");
        const rect = image.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(deviceWidth - 1, Math.round((event.clientX - rect.left) * deviceWidth / rect.width))),
            y: Math.max(0, Math.min(deviceHeight - 1, Math.round((event.clientY - rect.top) * deviceHeight / rect.height)))
        };
    }

    for (const tab of document.querySelectorAll("[data-tab]")) {
        tab.addEventListener("click", () => {
            activeTab = tab.dataset.tab;
            for (const item of document.querySelectorAll("[data-tab]")) {
                item.setAttribute("aria-selected", String(item === tab));
            }
            for (const panel of document.querySelectorAll("[data-panel]")) {
                panel.hidden = panel.dataset.panel !== activeTab;
            }
            if (activeTab !== "screen") { stopScreen(); }
            const load = { files: loadFiles, apps: loadApps, logs: loadLogs, screen: loadScreen }[activeTab];
            if (load) { action(null, () => load()); }
        });
    }

    function onClick(name, callback) {
        const node = byId(name);
        node.addEventListener("click", () => action(node, callback));
    }

    onClick("refresh-files", () => loadFiles());
    onClick("file-up", () => loadFiles(currentPath.slice(0, currentPath.lastIndexOf("/")) || fileRoot));
    onClick("upload-file", () => byId("file-input").click());
    onClick("install-app", () => byId("app-input").click());
    onClick("refresh-apps", loadApps);
    onClick("refresh-logs", loadLogs);
    onClick("refresh-device", async () => { await refreshConnection(); status("设备连接正常"); });
    onClick("connect-screen", () => screenTimer ? stopScreen() : startScreen());
    onClick("screen-home", () => input("keyEvent", { key: "Home" }));
    onClick("screen-back", () => input("keyEvent", { key: "Back" }));
    onClick("screen-refresh", () => screenMode === "hap" ? startHap() : loadScreen());
    onClick("clear-shell", () => { byId("shell-output").textContent = ""; });
    onClick("mkdir", async () => {
        const name = window.prompt("请输入文件夹名称");
        if (!name) { return; }
        if (name === "." || name === ".." || /[\\/\r\n\0]/.test(name)) { throw new Error("文件夹名称无效"); }
        await send("/local-api/files/mkdir", { path: `${currentPath}/${name}` });
        await loadFiles();
    });
    onClick("run-shell", async () => {
        const command = byId("shell-command").value.trim();
        if (!command) { throw new Error("请输入 Shell 命令"); }
        status("正在执行 Shell 命令");
        const body = await send("/local-api/shell", { command });
        const output = byId("shell-output");
        output.textContent = `${output.textContent}\n$ ${command}\n${body.output || "(无输出)"}`.slice(-2 * 1024 * 1024);
        output.scrollTop = output.scrollHeight;
        status(`执行完成：${body.durationMs} ms`);
    });
    byId("shell-command").addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault(); byId("run-shell").click();
        }
    });
    for (const [inputId, trigger, install] of [["file-input", "upload-file", false], ["app-input", "install-app", true]]) {
        byId(inputId).addEventListener("change", () => action(byId(trigger), async () => {
            const destination = currentPath;
            try {
                for (const file of byId(inputId).files) {
                    if (install && !/\.(hap|hsp)$/i.test(file.name)) { throw new Error("请选择 HAP 或 HSP 应用包"); }
                    status(`正在${install ? "安装" : "上传"} ${file.name}`);
                    const route = install ? "/local-api/apps/install" : `/local-api/files/upload?path=${encodeURIComponent(destination)}`;
                    await upload(`${route}${install ? "?" : "&"}name=${encodeURIComponent(file.name)}`, file);
                }
                if (install) { await loadApps(); } else { await loadFiles(); }
                status(install ? "应用安装完成" : "文件上传完成");
            } finally { byId(inputId).value = ""; }
        }));
    }
    onClick("rename-device", () => {
        const value = window.prompt("设备显示名称，留空恢复默认", aliases()[id] || "");
        if (value === null) { return; }
        const saved = aliases();
        const alias = value.trim().slice(0, 40);
        if (alias) { saved[id] = alias; } else { delete saved[id]; }
        localStorage.setItem(aliasKey, JSON.stringify(saved));
        renderName();
        if (parent !== window) { parent.postMessage({ type: "physical-web:device-alias", device: id, alias }, location.origin); }
    });
    onClick("close-device", () => {
        if (parent !== window) { parent.postMessage({ type: "physical-web:close-device", device: id }, location.origin); }
        else { location.href = "/"; }
    });
    onClick("download-logs", () => {
        const url = URL.createObjectURL(new Blob([byId("log-output").textContent], { type: "text/plain;charset=utf-8" }));
        const link = element("a");
        link.href = url; link.download = `hilog-${Date.now()}.txt`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    byId("app-search").addEventListener("input", renderApps);
    for (const node of [byId("device-screen"), byId("device-screen-canvas")]) node.addEventListener("pointerdown", event => {
        if (!screenTimer || node.hidden) { return; }
        pointerStart = screenPoint(event);
        node.setPointerCapture(event.pointerId);
    });
    for (const node of [byId("device-screen"), byId("device-screen-canvas")]) node.addEventListener("pointerup", event => {
        if (!pointerStart) { return; }
        const end = screenPoint(event);
        const start = pointerStart;
        pointerStart = null;
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        if (distance >= 18) {
            action(null, () => input("swipe", { x: start.x, y: start.y, x2: end.x, y2: end.y }));
        } else {
            lastInputPoint = end;
            action(null, () => input("click", end));
        }
    });
    for (const node of [byId("device-screen"), byId("device-screen-canvas")]) node.addEventListener("pointercancel", () => { pointerStart = null; });
    byId("text-form").addEventListener("submit", event => {
        event.preventDefault();
        const value = byId("input-text").value;
        if (!lastInputPoint) { throw new Error("请先点击设备画面中的输入框"); }
        action(null, async () => { await input("text", { ...lastInputPoint, text: value }); byId("input-text").value = ""; });
    });
    byId("auto-logs").addEventListener("change", () => {
        clearInterval(logTimer);
        if (byId("auto-logs").checked) {
            logTimer = setInterval(() => {
                if (activeTab === "logs" && !document.hidden) { action(null, loadLogs); }
            }, 3000);
        }
    });
    const connectionTimer = setInterval(() => {
        if (!document.hidden) { action(null, refreshConnection); }
    }, 10000);
    window.addEventListener("beforeunload", () => { clearInterval(logTimer); clearInterval(connectionTimer); stopScreen(); });
    renderName();
    action(null, async () => { await refreshConnection(); startScreen(); });
})();
