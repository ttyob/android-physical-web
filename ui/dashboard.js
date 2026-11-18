(() => {
    "use strict";

    const STORAGE_KEY = "physical-web.open-devices.v1";
    const ALIAS_STORAGE_KEY = "physical-web.device-aliases.v1";
    const DISCOVERY_TAB_KEY = "physical-web.discovery-tab.v1";
    const grid = document.getElementById("device-grid");
    const emptyWorkspace = document.getElementById("empty-workspace");
    const summary = document.getElementById("device-summary");
    const discovery = document.getElementById("device-discovery");
    const discoveryStatus = document.getElementById("discovery-status");
    const discoveryProviderError = document.getElementById("discovery-provider-error");
    const discoveryTabs = [...document.querySelectorAll("[data-discovery-tab]")];
    const discoveryPanels = [...document.querySelectorAll("[data-discovery-panel]")];
    const usbDevices = document.getElementById("usb-devices");
    const emulatorDevices = document.getElementById("emulator-devices");
    const harmonyDevices = document.getElementById("harmony-devices");
    const iosDevices = document.getElementById("ios-devices");
    const networkDevices = document.getElementById("network-devices");
    const toast = document.getElementById("toast");
    let devices = [];
    let providers = {};
    let activeDiscoveryTab = "phone";
    let scanComplete = false;
    let showScanPending = false;
    let actionPending = false;
    let actionStatus = null;
    let refreshActive = false;
    let hdcServer = "";
    let iosServer = "";
    let refreshTimer;
    let toastTimer;
    const telemetry = new Map();

    try {
        const savedTab = localStorage.getItem(DISCOVERY_TAB_KEY);
        if (discoveryTabs.some(tab => tab.dataset.discoveryTab === savedTab)) {
            activeDiscoveryTab = savedTab;
        }
    } catch {}

    function readOpenDevices() {
        try {
            const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
            return Array.isArray(value) ? value.filter(serial => typeof serial === "string" && serial && !/^(hdc|ios):\/\//.test(serial)) : [];
        } catch {
            return [];
        }
    }

    let openDevices = [...new Set(readOpenDevices())];

    function readAliases() {
        try {
            const value = JSON.parse(localStorage.getItem(ALIAS_STORAGE_KEY) || "{}");
            return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        } catch {
            return {};
        }
    }

    const deviceAliases = readAliases();

    function saveOpenDevices() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(openDevices.filter(serial => !/^(hdc|ios):\/\//.test(serial))));
    }

    function saveAlias(serial, value) {
        const alias = String(value || "").trim().slice(0, 40);
        if (alias) {
            deviceAliases[serial] = alias;
        } else {
            delete deviceAliases[serial];
        }
        localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(deviceAliases));
        updateCardHeader(serial);
    }

    function showToast(message, error = false) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.toggle("error", error);
        toast.hidden = false;
        toastTimer = setTimeout(() => {
            toast.hidden = true;
        }, 4000);
    }

    async function apiJson(url, options) {
        const response = await fetch(url, { cache: "no-store", ...options });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(body.error || `请求失败 (${response.status})`);
        }
        return body;
    }

    function deviceName(serial) {
        if (deviceAliases[serial]) {
            return deviceAliases[serial];
        }
        const device = devices.find(item => item.serial === serial);
        return (device?.protocol === "ios" ? device.name || device.model : device?.model || device?.name) || serial;
    }

    function findCard(serial) {
        return [...grid.querySelectorAll(".device-card")].find(card => card.dataset.device === serial);
    }

    function updateCardHeader(serial) {
        const card = findCard(serial);
        if (!card) {
            return;
        }
        const frame = card.querySelector(".device-frame");
        frame.title = `${deviceName(serial)} 控制界面`;
    }

    function createDeviceCard(serial) {
        const card = document.createElement("section");
        card.className = "device-card";
        card.dataset.device = serial;

        const frame = document.createElement("iframe");
        frame.className = "device-frame";
        const page = serial.startsWith("hdc://") ? "/hdc.html" : serial.startsWith("ios://") ? "/ios.html" : "/device.html";
        frame.src = `${page}?device=${encodeURIComponent(serial)}`;
        frame.allow = "clipboard-read; clipboard-write";
        card.appendChild(frame);
        return card;
    }

    function renderWorkspace() {
        for (const card of [...grid.querySelectorAll(".device-card")]) {
            if (!openDevices.includes(card.dataset.device)) {
                card.remove();
            }
        }
        for (const serial of openDevices) {
            if (!findCard(serial)) {
                grid.appendChild(createDeviceCard(serial));
            }
            updateCardHeader(serial);
        }
        const count = openDevices.length;
        summary.textContent = `${count} 台已打开 · ${devices.filter(device => device.state === "device").length} 台可用`;
        emptyWorkspace.hidden = count !== 0;
    }

    function stateText(device) {
        if (device.state === "device") {
            if (device.protocol === "ios") {
                return `${device.transport === "remote" ? "远程 USB" : "USB"} 已信任${device.version ? ` · iOS ${device.version}` : ""}`;
            }
            if (device.protocol === "hdc") {
                return device.transport === "usb" ? "HDC USB 已连接" : "HDC 网络已连接";
            }
            if (device.type === "emulator") {
                return "模拟器已连接";
            }
            return device.type === "usb" ? "USB 已授权" : "网络已连接";
        }
        if (device.state === "unauthorized") {
            if (device.protocol === "ios") { return device.error || "解锁手机并信任此电脑"; }
            return "等待手机授权";
        }
        if (device.state === "pairing") {
            return "等待六位配对码";
        }
        if (device.state === "available") {
            return "局域网已发现";
        }
        if (device.state === "offline") {
            return "设备离线";
        }
        return device.state;
    }

    function addDevice(serial) {
        if (!serial || openDevices.includes(serial)) {
            return;
        }
        openDevices.push(serial);
        saveOpenDevices();
        renderWorkspace();
        renderDiscovery();
    }

    async function runDeviceAction(body, pendingText) {
        if (actionPending) { return; }
        actionPending = true;
        const actionTab = activeDiscoveryTab;
        actionStatus = { text: pendingText, tab: actionTab, error: false };
        renderDiscovery();
        try {
            const result = await apiJson("/local-api/devices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...body, ...(hdcServer ? { hdcServer } : {}), ...(iosServer ? { iosServer } : {}) })
            });
            devices = result.devices;
            if (body.action === "connect") {
                addDevice(result.selectedDevice);
                showToast("设备已连接并加入工作台");
            } else if (body.action === "pair" && body.protocol === "ios") {
                addDevice(result.selectedDevice);
                showToast("iPhone 配对成功，已加入工作台");
            } else if (body.action === "pair") {
                showToast("配对成功，正在等待连接服务");
            }
            await refreshDevices(false);
            actionStatus = null;
        } catch (error) {
            actionStatus = { text: `操作失败：${error.message}`, tab: actionTab, error: true };
            showToast(error.message, true);
        } finally {
            actionPending = false;
            renderDiscovery();
        }
    }

    function createDeviceRow(device) {
        const row = document.createElement("div");
        row.className = "device-row";
        const kind = document.createElement("span");
        kind.className = "device-kind";
        kind.textContent = { usb: "USB", emulator: "EMU", network: "LAN", harmony: "HDC", ios: "iOS" }[device.type] || "ADB";
        const main = document.createElement("div");
        main.className = "device-main";
        const name = document.createElement("strong");
        name.textContent = device.serial ? deviceName(device.serial) : device.model || device.name || "Android 设备";
        const meta = document.createElement("span");
        meta.textContent = `${stateText(device)} · ${device.udid || device.connectKey || device.serial || device.address}`;
        main.append(name, meta);
        row.append(kind, main);

        if (device.state === "pairing") {
            const controls = document.createElement("div");
            controls.className = "pair-controls";
            const input = document.createElement("input");
            input.type = "text";
            input.inputMode = "numeric";
            input.autocomplete = "one-time-code";
            input.maxLength = 6;
            input.placeholder = "六位配对码";
            input.setAttribute("aria-label", `${name.textContent} 配对码`);
            const pair = document.createElement("button");
            pair.type = "button";
            pair.disabled = actionPending;
            pair.className = "device-command primary";
            pair.textContent = "配对";
            pair.addEventListener("click", () => runDeviceAction({
                action: "pair",
                address: device.address,
                code: input.value
            }, "正在配对网络设备"));
            controls.append(input, pair);
            row.appendChild(controls);
            return row;
        }

        const command = document.createElement("button");
        command.type = "button";
        command.className = "device-command";
        if (device.state === "device" && openDevices.includes(device.serial)) {
            command.textContent = "已打开";
            command.disabled = true;
        } else if (device.state === "device") {
            command.textContent = "添加";
            command.classList.add("primary");
            command.addEventListener("click", () => addDevice(device.serial));
        } else if (device.state === "unauthorized" && device.protocol === "ios") {
            command.textContent = "配对";
            command.classList.add("primary");
            command.addEventListener("click", () => runDeviceAction({ action: "pair", protocol: "ios", serial: device.serial }, "请在 iPhone 上确认信任，然后重试配对"));
        } else if (device.state === "available") {
            command.textContent = "连接";
            command.classList.add("primary");
            command.addEventListener("click", () => runDeviceAction({ action: "connect", address: device.address }, "正在连接网络设备"));
        } else {
            command.textContent = device.state === "unauthorized" ? "待授权" : "不可用";
            command.disabled = true;
        }
        command.disabled ||= actionPending;
        row.appendChild(command);
        return row;
    }

    function renderList(container, items, emptyText) {
        if (container.contains(document.activeElement) && document.activeElement.matches("input")) {
            return;
        }
        container.replaceChildren();
        if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "empty-list";
            empty.textContent = emptyText;
            container.appendChild(empty);
            return;
        }
        container.append(...items.map(createDeviceRow));
    }

    function groupedDevices() {
        return {
            phone: devices.filter(device => !["hdc", "ios"].includes(device.protocol) && ["usb", "network"].includes(device.type)),
            emulator: devices.filter(device => !["hdc", "ios"].includes(device.protocol) && device.type === "emulator"),
            harmony: devices.filter(device => device.protocol === "hdc"),
            ios: devices.filter(device => device.protocol === "ios")
        };
    }

    function renderDiscoveryStatus() {
        const current = groupedDevices()[activeDiscoveryTab];
        const online = current.filter(device => device.state === "device").length;
        const opened = current.filter(device => openDevices.includes(device.serial)).length;
        const message = actionStatus?.tab === activeDiscoveryTab ? actionStatus : null;
        discoveryStatus.textContent = message?.text ||
            (showScanPending || !scanComplete ? "正在查找设备" : `${online} 台在线 · ${opened} 台已打开`);
        discoveryStatus.classList.toggle("error", Boolean(message?.error));
        const provider = providers[{ harmony: "hdc", ios: "ios" }[activeDiscoveryTab] || "adb"];
        discoveryProviderError.textContent = provider?.error || "";
        discoveryProviderError.hidden = !provider?.error;
    }

    function selectDiscoveryTab(name, focus = false, remember = true) {
        activeDiscoveryTab = name;
        for (const tab of discoveryTabs) {
            const selected = tab.dataset.discoveryTab === name;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && focus) { tab.focus({ preventScroll: true }); }
        }
        for (const panel of discoveryPanels) {
            panel.hidden = panel.dataset.discoveryPanel !== name;
        }
        discovery.querySelector(".discovery-content").scrollTop = 0;
        if (remember) {
            try { localStorage.setItem(DISCOVERY_TAB_KEY, name); } catch {}
        }
        renderDiscoveryStatus();
    }

    function renderDiscovery() {
        const groups = groupedDevices();
        const usb = groups.phone.filter(device => device.type === "usb");
        const network = groups.phone.filter(device => device.type === "network");
        document.getElementById("usb-device-group").hidden = !usb.length;
        document.getElementById("network-device-group").hidden = !network.length;
        document.getElementById("phone-empty").hidden = Boolean(groups.phone.length);
        renderList(usbDevices, usb, "");
        renderList(networkDevices, network, "");
        renderList(emulatorDevices, groups.emulator, "暂未发现模拟器，启动后会自动出现在这里。");
        renderList(harmonyDevices, groups.harmony, providers.hdc?.enabled === false ? "HDC 未启用，请在服务配置中开启。" : !hdcServer ? "连接 HDC 服务后，设备会显示在这里。" : "暂未发现鸿蒙设备，请确认设备已启动并开启 HDC 调试。");
        renderList(iosDevices, groups.ios, providers.ios?.enabled === false ? "iOS 工具未启用，请在服务配置中开启。" : iosServer ? "此服务暂未发现 iPhone，请确认手机已连接并解锁。" : "暂未发现 iPhone，请用数据线连接到开发服务器，或展开下方的远程连接。");
        for (const [name, items] of Object.entries(groups)) {
            document.getElementById(`${name}-tab-count`).textContent = items.length;
        }
        for (const form of discovery.querySelectorAll("form")) {
            const hdcForm = ["hdc-connect-form", "hdc-server-form"].includes(form.id);
            form.querySelector("button").disabled = actionPending || (hdcForm && providers.hdc?.enabled === false) ||
                (form.id === "hdc-connect-form" && !hdcServer) || (form.id === "ios-server-form" && providers.ios?.enabled === false);
        }
        document.getElementById("hdc-server-form").hidden = Boolean(hdcServer);
        document.getElementById("hdc-service").hidden = !hdcServer;
        document.getElementById("hdc-device-connection").hidden = !hdcServer;
        document.getElementById("disconnect-hdc-server").disabled = actionPending;
        const hdc = providers.hdc;
        document.getElementById("hdc-service-address").textContent = hdcServer;
        document.getElementById("hdc-service-state").textContent = hdc?.error ? "连接异常" : "服务可用";
        document.getElementById("hdc-service").dataset.state = hdc?.error ? "error" : "connected";
        document.getElementById("hdc-connect-hint").textContent = hdcServer ? `此地址由 HDC 服务 ${hdcServer} 所在主机访问。` : "请先连接 HDC 服务。";
        document.getElementById("ios-service").hidden = !iosServer;
        document.getElementById("ios-service-address").textContent = iosServer;
        document.getElementById("ios-service").dataset.state = providers.ios?.error ? "error" : "connected";
        document.getElementById("disconnect-ios-server").disabled = actionPending;
        renderDiscoveryStatus();
    }

    function discoveryUrl(server = hdcServer, appleServer = iosServer) {
        const params = new URLSearchParams();
        if (server) { params.set("hdcServer", server); }
        if (appleServer) { params.set("iosServer", appleServer); }
        return `/local-api/devices${params.size ? `?${params}` : ""}`;
    }

    function closeIosDevices() {
        openDevices = openDevices.filter(serial => !serial.startsWith("ios://"));
        saveOpenDevices();
        renderWorkspace();
    }

    async function connectIosServer() {
        if (actionPending) { return; }
        const address = document.getElementById("ios-server-input").value.trim();
        if (!address) { return; }
        actionPending = true;
        actionStatus = { text: "正在连接 usbmuxd 服务", tab: "ios", error: false };
        renderDiscovery();
        try {
            const result = await apiJson(discoveryUrl(hdcServer, address));
            const provider = result.providers?.ios;
            if (!provider?.enabled || !provider.available || provider.error || !provider.server) {
                throw new Error(provider?.error || "usbmuxd 服务不可用");
            }
            closeIosDevices();
            iosServer = provider.server;
            document.getElementById("ios-server-input").value = "";
            document.getElementById("ios-remote-connection").open = false;
            devices = result.devices;
            providers = result.providers;
            scanComplete = true;
            actionStatus = null;
        } catch (error) {
            actionStatus = { text: error.message, tab: "ios", error: true };
            showToast(error.message, true);
        } finally {
            actionPending = false;
            renderWorkspace();
            renderDiscovery();
        }
    }

    function closeHdcDevices() {
        openDevices = openDevices.filter(serial => !serial.startsWith("hdc://"));
        saveOpenDevices();
        renderWorkspace();
    }

    async function connectHdcServer() {
        if (actionPending) { return; }
        const address = document.getElementById("hdc-server-input").value.trim();
        if (!address) { return; }
        actionPending = true;
        actionStatus = { text: "正在连接 HDC 服务", tab: "harmony", error: false };
        renderDiscovery();
        try {
            const result = await apiJson(discoveryUrl(address));
            const provider = result.providers?.hdc;
            if (!provider?.enabled || !provider.available || provider.error || !provider.server) {
                throw new Error(provider?.error || "HDC 服务不可用");
            }
            closeHdcDevices();
            hdcServer = provider.server;
            document.getElementById("hdc-server-input").value = "";
            document.getElementById("hdc-address").value = "";
            devices = result.devices;
            providers = result.providers;
            scanComplete = true;
            actionStatus = null;
        } catch (error) {
            actionStatus = { text: error.message, tab: "harmony", error: true };
            showToast(error.message, true);
        } finally {
            actionPending = false;
            renderWorkspace();
            renderDiscovery();
        }
    }

    async function refreshDevices(showPending = true) {
        if (refreshActive) {
            return;
        }
        refreshActive = true;
        showScanPending = showPending;
        if (showPending && !actionPending) { actionStatus = null; }
        renderDiscoveryStatus();
        const requestedServer = hdcServer;
        const requestedIosServer = iosServer;
        try {
            const result = await apiJson(discoveryUrl(requestedServer, requestedIosServer));
            if (requestedServer !== hdcServer || requestedIosServer !== iosServer) { return; }
            devices = result.devices;
            providers = result.providers || {};
            scanComplete = true;
            renderWorkspace();
            renderDiscovery();
        } catch (error) {
            actionStatus = { text: `扫描失败：${error.message}`, tab: activeDiscoveryTab, error: true };
            showToast(error.message, true);
        } finally {
            refreshActive = false;
            showScanPending = false;
            renderDiscoveryStatus();
        }
    }

    function openDiscovery() {
        if (!discovery.open) {
            discovery.showModal();
            selectDiscoveryTab(activeDiscoveryTab, true, false);
        }
        clearInterval(refreshTimer);
        refreshDevices();
        refreshTimer = setInterval(() => refreshDevices(false), 3000);
    }

    document.getElementById("add-device").addEventListener("click", openDiscovery);
    document.getElementById("empty-add-device").addEventListener("click", openDiscovery);
    document.getElementById("refresh-dashboard").addEventListener("click", () => refreshDevices(false));
    document.getElementById("refresh-discovery").addEventListener("click", () => refreshDevices());
    document.getElementById("close-discovery").addEventListener("click", () => discovery.close());
    for (const tab of discoveryTabs) {
        tab.addEventListener("click", () => selectDiscoveryTab(tab.dataset.discoveryTab));
        tab.addEventListener("keydown", event => {
            const index = discoveryTabs.indexOf(tab);
            const next = { ArrowRight: (index + 1) % discoveryTabs.length, ArrowLeft: (index + discoveryTabs.length - 1) % discoveryTabs.length,
                Home: 0, End: discoveryTabs.length - 1 }[event.key];
            if (next === undefined) { return; }
            event.preventDefault();
            selectDiscoveryTab(discoveryTabs[next].dataset.discoveryTab, true);
        });
    }
    document.getElementById("adb-connect-form").addEventListener("submit", event => {
        event.preventDefault();
        runDeviceAction({ action: "connect", address: document.getElementById("adb-address").value }, "正在连接 ADB 设备");
    });
    document.getElementById("emulator-connect-form").addEventListener("submit", event => {
        event.preventDefault();
        runDeviceAction({ action: "connect", address: document.getElementById("emulator-address").value }, "正在连接 Android 模拟器");
    });
    document.getElementById("hdc-server-form").addEventListener("submit", event => {
        event.preventDefault();
        connectHdcServer();
    });
    document.getElementById("disconnect-hdc-server").addEventListener("click", () => {
        hdcServer = "";
        document.getElementById("hdc-server-input").value = "";
        document.getElementById("hdc-address").value = "";
        document.getElementById("hdc-device-connection").open = false;
        actionStatus = null;
        devices = devices.filter(device => device.protocol !== "hdc");
        providers = { ...providers, hdc: { ...providers.hdc, configured: false, server: null, error: null } };
        closeHdcDevices();
        renderDiscovery();
        refreshDevices(false);
    });
    document.getElementById("hdc-connect-form").addEventListener("submit", event => {
        event.preventDefault();
        runDeviceAction({ action: "connect", protocol: "hdc", address: document.getElementById("hdc-address").value }, "正在连接鸿蒙设备");
    });
    document.getElementById("ios-server-form").addEventListener("submit", event => {
        event.preventDefault();
        connectIosServer();
    });
    document.getElementById("disconnect-ios-server").addEventListener("click", () => {
        iosServer = "";
        document.getElementById("ios-server-input").value = "";
        document.getElementById("ios-remote-connection").open = false;
        actionStatus = null;
        devices = devices.filter(device => device.protocol !== "ios");
        providers = { ...providers, ios: { ...providers.ios, server: null, error: null } };
        closeIosDevices();
        renderDiscovery();
        refreshDevices(false);
    });
    discovery.addEventListener("close", () => clearInterval(refreshTimer));
    discovery.addEventListener("click", event => {
        if (event.target === discovery) {
            discovery.close();
        }
    });
    window.addEventListener("message", event => {
        if (event.origin !== location.origin) {
            return;
        }
        if (event.data?.type === "physical-web:open-devices") {
            openDiscovery();
            return;
        }
        if (event.data?.type === "physical-web:close-device" && openDevices.includes(event.data.device)) {
            openDevices = openDevices.filter(serial => serial !== event.data.device);
            saveOpenDevices();
            findCard(event.data.device)?.remove();
            renderWorkspace();
            if (discovery.open) {
                renderDiscovery();
            }
            return;
        }
        if (event.data?.type === "physical-web:device-alias" && openDevices.includes(event.data.device)) {
            if (event.data.alias) {
                deviceAliases[event.data.device] = String(event.data.alias).slice(0, 40);
            } else {
                delete deviceAliases[event.data.device];
            }
            updateCardHeader(event.data.device);
            return;
        }
        if (event.data?.type === "physical-web:device-telemetry" && openDevices.includes(event.data.device)) {
            const card = findCard(event.data.device);
            if (!card || card.querySelector(".device-frame").contentWindow !== event.source) {
                return;
            }
            const { screenWidth, screenHeight } = event.data;
            if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0) {
                card.dataset.orientation = screenWidth > screenHeight ? "landscape" : "portrait";
            }
            const current = telemetry.get(event.data.device) || {};
            telemetry.set(event.data.device, {
                ...current,
                status: event.data.status ?? current.status,
                state: event.data.state ?? current.state,
                cpu: event.data.cpu ?? current.cpu,
                memory: event.data.memory ?? current.memory
            });
            updateCardHeader(event.data.device);
        }
    });

    document.getElementById("hdc-server-input").value = "";
    document.getElementById("hdc-address").value = "";
    document.getElementById("ios-server-input").value = "";
    saveOpenDevices();
    renderWorkspace();
    selectDiscoveryTab(activeDiscoveryTab, false, false);
    renderDiscovery();
    if (!openDevices.length) { openDiscovery(); }
    else { refreshDevices(false); }
})();
