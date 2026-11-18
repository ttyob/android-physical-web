(() => {
    "use strict";

    const id = new URLSearchParams(location.search).get("device") || "";
    const udid = id.startsWith("ios://") ? id.slice(id.indexOf("/", 6) + 1) : "";
    const byId = name => document.getElementById(name);
    const aliasKey = "physical-web.device-aliases.v1";
    const tabs = [...document.querySelectorAll("[data-tab]")];
    const busy = new Set();
    let model = "iPhone";
    let ready = false;
    let screenshotSupported = false;
    let screenshotUrl;
    let activeTab = null;
    let controlConnected = false;
    let screenshotReason = "";
    let toastTimer;
    const tools = byId("ios-tools");
    let logging = false;
    let logAbort;
    let logTimer;
    let apps = [];
    const control = window.createIphoneControl({ id, api, send, status, onState(state) {
        controlConnected = state.connected;
        renderAvailability();
    } });

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) { node.textContent = text; }
        if (className) { node.className = className; }
        return node;
    }

    function status(message, error = false) {
        byId("tool-status").textContent = message;
        byId("tool-status").classList.toggle("error", error);
        if (error) {
            const toast = byId("status-toast");
            clearTimeout(toastTimer);
            toast.textContent = message; toast.classList.add("error"); toast.hidden = false;
            toastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
        }
    }

    function apiUrl(route) {
        const url = new URL(route, location.origin);
        url.searchParams.set("device", id);
        return `${url.pathname}${url.search}`;
    }

    async function checkedFetch(route, options = {}) {
        const response = await fetch(apiUrl(route), { cache: "no-store", ...options });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw Object.assign(new Error(body.error || `请求失败 (${response.status})`), { code: body.code, locked: body.locked });
        }
        return response;
    }

    async function api(route, options) { return (await checkedFetch(route, options)).json(); }
    function send(route, body) {
        return api(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }

    function renderAvailability() {
        for (const name of ["capture-logs", "capture-screenshot", "install-app", "refresh-apps"]) {
            const button = byId(name);
            button.disabled = !ready || busy.has(button) || (name === "capture-logs" && logging) ||
                (name === "capture-screenshot" && !screenshotSupported && !controlConnected);
        }
        byId("auto-logs").disabled = !ready;
        byId("screenshot-note").textContent = controlConnected ? "截取当前 iPhone 画面，可预览和下载。" : screenshotReason || "请先连接画面，再截取屏幕。";
    }

    async function action(button, callback) {
        if (button?.disabled) { return; }
        if (button) { busy.add(button); button.disabled = true; }
        try { await callback(); } catch (error) { status(error.message, true); }
        finally { if (button) { busy.delete(button); button.disabled = false; } renderAvailability(); }
    }

    function onClick(name, callback) {
        byId(name).addEventListener("click", () => action(byId(name), callback));
    }

    function aliases() {
        try {
            const saved = JSON.parse(localStorage.getItem(aliasKey) || "{}");
            return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
        } catch { return {}; }
    }

    function renderName() {
        byId("device-name").textContent = aliases()[id] || model;
        byId("device-key").textContent = udid || "未指定设备";
        byId("device-key").title = udid || "未指定设备";
    }

    async function refreshInfo() {
        status("正在读取 iPhone 信息");
        try {
            if (!udid) { throw new Error("请从工作台添加 iPhone"); }
            const config = await api("/local-api/device/config");
            const info = config.info;
            model = info.deviceName || info.productType || "iPhone";
            ready = true;
            control.setReady(true);
            screenshotSupported = Boolean(config.capabilities.screenshot.supported);
            screenshotReason = screenshotSupported ? config.capabilities.screenshot.reason : "请先连接画面，再截取屏幕。";
            byId("connection-status").textContent = `${info.connection} · iOS ${info.productVersion}`;
            byId("connection-status").dataset.state = "connected";
            const list = byId("device-info");
            list.replaceChildren();
            for (const [label, value] of [["设备名称", info.deviceName], ["设备型号", info.productType],
                ["iOS 版本", info.productVersion], ["系统构建", info.buildVersion], ["序列号", info.serialNumber],
                ["硬件型号", info.hardwareModel], ["处理器", info.cpuArchitecture], ["UDID", info.udid],
                ["连接方式", info.connection], ["服务", info.service]]) {
                list.append(element("dt", label), element("dd", value || "—"));
            }
            renderName();
            status("设备信息已更新");
        } catch (error) {
            ready = false;
            control.setReady(false);
            stopLogs();
            byId("device-info").replaceChildren();
            byId("connection-status").textContent = error.message;
            byId("connection-status").dataset.state = "error";
            throw error;
        } finally { renderAvailability(); }
    }

    function renderApps() {
        const term = byId("app-search").value.toLowerCase();
        const list = byId("app-list");
        list.replaceChildren();
        for (const app of apps.filter(item => `${item.name} ${item.packageName}`.toLowerCase().includes(term))) {
            const row = element("div", undefined, "item-row");
            row.setAttribute("role", "listitem");
            const name = element("div", app.name, "item-name");
            name.append(element("span", `${app.packageName} · ${app.version || "未知版本"}`, "item-meta"));
            const uninstall = element("button", "卸载", "danger");
            uninstall.type = "button";
            uninstall.addEventListener("click", () => action(uninstall, async () => {
                if (!window.confirm(`卸载 ${app.name}（${app.packageName}）？应用数据也会被删除。`)) { return; }
                status(`正在卸载 ${app.name}`);
                await send("/local-api/apps", { action: "uninstall", packageName: app.packageName });
                await loadApps();
                status("应用已卸载");
            }));
            row.append(name, uninstall);
            list.append(row);
        }
        if (!list.childElementCount) { list.append(element("div", "没有匹配的用户应用", "empty")); }
    }

    async function loadApps() {
        status("正在读取用户应用");
        apps = (await api("/local-api/apps")).apps;
        renderApps();
        byId("app-count").textContent = `${apps.length} 个应用`;
        status(`共 ${apps.length} 个用户应用`);
    }

    function stopLogs() {
        clearTimeout(logTimer);
        byId("auto-logs").checked = false;
        logAbort?.abort();
    }

    async function captureLogs() {
        if (logging || !ready) { return; }
        logging = true;
        logAbort = new AbortController();
        renderAvailability();
        status("正在采集系统日志");
        try {
            const params = new URLSearchParams({ durationMs: byId("log-duration").value,
                lines: "2000", search: byId("log-search").value });
            const result = await api(`/local-api/logs?${params}`, { signal: logAbort.signal });
            const console = byId("log-output");
            if (result.output) {
                console.textContent = `${console.textContent}${console.textContent ? "\n" : ""}${result.output}`
                    .slice(-2 * 1024 * 1024).split("\n").slice(-2000).join("\n");
                console.scrollTop = console.scrollHeight;
            }
            status(`本段采集 ${result.lines} 行 · ${result.durationMs / 1000} 秒`);
        } catch (error) {
            if (error.name === "AbortError") { status("日志采集已停止"); }
            else { byId("auto-logs").checked = false; status(error.message, true); }
        } finally {
            logging = false;
            logAbort = null;
            renderAvailability();
            if (byId("auto-logs").checked && activeTab === "logs" && !document.hidden) {
                logTimer = setTimeout(captureLogs, 300);
            }
        }
    }

    function selectTab(name, focus = false) {
        if (name !== "logs") { stopLogs(); }
        activeTab = name;
        for (const tab of tabs) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute("aria-selected", String(selected));
            tab.classList.toggle("active", selected);
            tab.tabIndex = selected ? 0 : -1;
            if (selected && focus) { tab.focus(); }
        }
        for (const panel of document.querySelectorAll("[data-panel]")) { panel.hidden = panel.dataset.panel !== name; }
        if (name === "apps" && ready) { action(null, loadApps); }
    }

    for (const button of document.querySelectorAll("[data-open-tool]")) {
        button.addEventListener("click", () => {
            selectTab(button.dataset.openTool);
            if (!tools.open) { tools.showModal(); }
            byId(`tab-${button.dataset.openTool}`).focus();
        });
    }
    byId("close-tools").addEventListener("click", () => tools.close());
    tools.addEventListener("close", () => { stopLogs(); activeTab = null; });
    tools.addEventListener("click", event => { if (event.target === tools) {
        const rect = tools.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { tools.close(); }
    } });

    for (const tab of tabs) {
        tab.addEventListener("click", () => selectTab(tab.dataset.tab));
        tab.addEventListener("keydown", event => {
            const index = tabs.indexOf(tab);
            const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length,
                Home: 0, End: tabs.length - 1 }[event.key];
            if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].dataset.tab, true); }
        });
    }
    onClick("refresh-device", refreshInfo);
    onClick("pair-device", async () => {
        status("请在 iPhone 上确认信任；确认后可点击配对重试");
        await send("/local-api/device/pair", { action: "pair" });
        await refreshInfo();
    });
    onClick("refresh-apps", loadApps);
    onClick("install-app", () => byId("app-input").click());
    byId("app-input").addEventListener("change", () => action(byId("install-app"), async () => {
        const file = byId("app-input").files[0];
        if (!file) { return; }
        try {
            if (!/\.ipa$/i.test(file.name)) { throw new Error("请选择已正确签名的 IPA 应用包"); }
            status(`正在安装 ${file.name}`);
            await api(`/local-api/apps/install?name=${encodeURIComponent(file.name)}`, {
                method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
            await loadApps();
            status("IPA 安装完成");
        } finally { byId("app-input").value = ""; }
    }));
    byId("app-search").addEventListener("input", renderApps);
    byId("capture-logs").addEventListener("click", captureLogs);
    byId("auto-logs").addEventListener("change", () => {
        if (byId("auto-logs").checked) { captureLogs(); } else { stopLogs(); }
    });
    onClick("clear-logs", () => { byId("log-output").textContent = ""; });
    onClick("download-logs", () => {
        const url = URL.createObjectURL(new Blob([byId("log-output").textContent], { type: "text/plain;charset=utf-8" }));
        const link = element("a");
        link.href = url; link.download = `iphone-syslog-${Date.now()}.txt`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    onClick("capture-screenshot", async () => {
        status("正在截取 iPhone 屏幕");
        const blob = await (await checkedFetch(controlConnected ? "/local-api/device/control/frame" : "/local-api/device/screenshot")).blob();
        if (screenshotUrl) { URL.revokeObjectURL(screenshotUrl); }
        screenshotUrl = URL.createObjectURL(blob);
        const image = byId("screenshot-image");
        image.hidden = !["image/png", "image/jpeg"].includes(blob.type);
        if (!image.hidden) { image.src = screenshotUrl; }
        const link = byId("download-screenshot");
        link.href = screenshotUrl; link.download = `iphone-${Date.now()}.${blob.type === "image/png" ? "png" : blob.type === "image/jpeg" ? "jpg" : "tiff"}`;
        link.hidden = false;
        status(image.hidden ? "截图已生成，请下载 TIFF 文件查看" : "截图已生成");
    });
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
        stopLogs();
        control.close();
        if (parent !== window) { parent.postMessage({ type: "physical-web:close-device", device: id }, location.origin); }
        else { location.href = "/"; }
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { stopLogs(); } });
    window.addEventListener("beforeunload", () => { stopLogs(); control.close(); if (screenshotUrl) { URL.revokeObjectURL(screenshotUrl); } });
    renderName();
    action(null, refreshInfo);
})();
