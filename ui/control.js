(() => {
    "use strict";

    const CONTROL_CHANNEL = 2;
    const FRAME_HEADER_BYTES = 13;
    const connection = document.querySelector(".connection");
    const statusText = document.getElementById("status-text");
    const loading = document.getElementById("loading");
    const loadingText = document.getElementById("loading-text");
    const screen = document.getElementById("screen-frame");
    const workspace = document.querySelector(".workspace");
    const video = document.getElementById("player");
    const clipboardText = document.getElementById("clipboard-text");
    const keyboardCapture = document.getElementById("keyboard-capture");
    const fixedDeviceId = new URLSearchParams(location.search).get("device") || undefined;
    document.documentElement.classList.toggle("embedded-device", Boolean(fixedDeviceId));

    let socket;
    let muxer;
    let muxerReady = false;
    let muxerGeneration = 0;
    const pendingVideoFrames = [];
    let reconnectTimer;
    let deviceId = fixedDeviceId;
    let screenWidth = 540;
    let screenHeight = 1200;
    let receivedVideo = false;
    let videoConfiguration;
    let deviceMessageBuffer = new Uint8Array();
    let clipboardReadTimer;
    let clipboardSequence = 0n;
    let clipboardAckSequence;
    let clipboardAckPaste = false;
    let clipboardAckTimer;
    let textInputBuffer = "";
    let textInputTimer;
    const inputQueue = [];
    const activePointers = new Set();

    function postDashboardTelemetry(update) {
        if (!fixedDeviceId || window.parent === window) {
            return;
        }
        window.parent.postMessage({
            type: "physical-web:device-telemetry",
            device: fixedDeviceId,
            ...update
        }, location.origin);
    }

    function updateScreenSize(width, height) {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return;
        }
        if (width === screenWidth && height === screenHeight && workspace.style.getPropertyValue("--screen-ratio")) {
            return;
        }
        screenWidth = width;
        screenHeight = height;
        workspace.style.setProperty("--screen-ratio", width / height);
        postDashboardTelemetry({ screenWidth, screenHeight });
    }

    function setStatus(text, state = "") {
        statusText.textContent = text;
        connection.className = `connection ${state}`.trim();
        postDashboardTelemetry({ status: text, state });
    }

    function showLoading(text) {
        loadingText.textContent = text;
        loading.classList.remove("hidden");
    }

    function destroyMuxer() {
        muxerGeneration++;
        muxerReady = false;
        pendingVideoFrames.length = 0;
        if (muxer && typeof muxer.destroy === "function") {
            muxer.destroy();
        }
        muxer = undefined;
        video.classList.remove("ready");
        video.removeAttribute("src");
        video.load();
    }

    function createMuxer() {
        destroyMuxer();
        const generation = muxerGeneration;
        muxer = new JMuxer({
            node: video,
            mode: "video",
            videoCodec: "H264",
            flushingTime: 0,
            maxDelay: 150,
            clearBuffer: true,
            fps: 30,
            debug: false,
            onReady: () => {
                if (generation !== muxerGeneration) { return; }
                muxerReady = true;
                for (const { frame, keyframe } of pendingVideoFrames.splice(0)) {
                    feedVideoFrame(frame, keyframe);
                }
            },
            onError: () => {
                if (generation !== muxerGeneration) { return; }
                setStatus("画面解码失败", "error");
                showLoading("画面解码失败");
            },
            onUnsupportedCodec: () => {
                if (generation !== muxerGeneration) { return; }
                setStatus("浏览器不支持 H.264", "error");
                showLoading("浏览器不支持 H.264");
            }
        });
    }

    function feedVideoFrame(frame, keyframe) {
        // After a rotation, packets can arrive before MSE has opened. JMuxer
        // drops those packets, including SPS/PPS and the first keyframe.
        if (!muxerReady) {
            if (pendingVideoFrames.length >= 90) {
                socket?.close();
                return;
            }
            pendingVideoFrames.push({ frame, keyframe });
            return;
        }
        muxer.feed({ video: frame, duration: 1000 / 30, isLastVideoFrameComplete: true });
        if (!receivedVideo && keyframe) {
            receivedVideo = true;
            video.play().catch(() => {});
        }
    }

    function streamUrl() {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const url = new URL(`${protocol}//${location.host}/`);
        url.searchParams.set("action", "stream");
        url.searchParams.set("udid", deviceId);
        url.searchParams.set("bitrate", "3000000");
        url.searchParams.set("maxFps", "30");
        url.searchParams.set("maxSize", "1200");
        return url;
    }

    function localApiUrl(input) {
        const url = new URL(input, location.origin);
        if (deviceId && url.pathname.startsWith("/local-api/")) {
            url.searchParams.set("device", deviceId);
        }
        return `${url.pathname}${url.search}`;
    }

    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1500);
    }

    async function connect() {
        clearTimeout(reconnectTimer);
        clearTimeout(clipboardAckTimer);
        clearTimeout(textInputTimer);
        receivedVideo = false;
        videoConfiguration = undefined;
        deviceMessageBuffer = new Uint8Array();
        clipboardAckSequence = undefined;
        clipboardAckPaste = false;
        textInputBuffer = "";
        inputQueue.length = 0;
        activePointers.clear();
        setStatus("正在连接");
        showLoading("正在启动画面");

        if (socket) {
            socket.onclose = null;
            socket.close();
        }

        if (!deviceId) {
            try {
                const config = await apiJson("/local-api/device/config");
                if (!config.deviceId) {
                    setStatus("请选择设备");
                    showLoading("请选择要控制的设备");
                    openDevicePicker();
                    return;
                }
                deviceId = config.deviceId;
                deviceIdentity.textContent = deviceId;
                refreshDevices(false);
            } catch (error) {
                setStatus("连接失败", "error");
                showLoading(`无法获取设备：${error.message}`);
                scheduleReconnect();
                return;
            }
        }
        createMuxer();
        socket = new WebSocket(streamUrl());
        socket.binaryType = "arraybuffer";
        socket.onopen = () => setStatus("正在启动");
        socket.onmessage = onSocketMessage;
        socket.onerror = () => {
            setStatus("连接失败", "error");
            showLoading("连接失败，正在重试");
        };
        socket.onclose = () => {
            deviceId = fixedDeviceId;
            setStatus("连接已断开", "error");
            showLoading("连接已断开，正在重试");
            scheduleReconnect();
        };
    }

    function handleDeviceMessages(payload) {
        const merged = new Uint8Array(deviceMessageBuffer.length + payload.length);
        merged.set(deviceMessageBuffer);
        merged.set(payload, deviceMessageBuffer.length);
        deviceMessageBuffer = merged;

        while (deviceMessageBuffer.length) {
            const type = deviceMessageBuffer[0];
            let messageLength;
            if (type === 0) {
                if (deviceMessageBuffer.length < 5) {
                    return;
                }
                messageLength = 5 + new DataView(deviceMessageBuffer.buffer, deviceMessageBuffer.byteOffset).getUint32(1);
                if (deviceMessageBuffer.length < messageLength) {
                    return;
                }
                const text = new TextDecoder().decode(deviceMessageBuffer.subarray(5, messageLength));
                clearTimeout(clipboardReadTimer);
                clipboardText.value = text;
                showToast("已读取设备剪贴板");
                if (typeof toolsStatus !== "undefined") {
                    toolsStatus.textContent = "设备剪贴板已更新";
                }
            } else if (type === 1) {
                messageLength = 9;
            } else if (type === 2) {
                if (deviceMessageBuffer.length < 5) {
                    return;
                }
                messageLength = 5 + new DataView(deviceMessageBuffer.buffer, deviceMessageBuffer.byteOffset).getUint16(3);
            } else {
                deviceMessageBuffer = new Uint8Array();
                return;
            }

            if (deviceMessageBuffer.length < messageLength) {
                return;
            }
            if (type === 1) {
                acknowledgeClipboard(new DataView(
                    deviceMessageBuffer.buffer,
                    deviceMessageBuffer.byteOffset,
                    messageLength
                ).getBigUint64(1));
            }
            deviceMessageBuffer = deviceMessageBuffer.slice(messageLength);
        }
    }

    function onSocketMessage(event) {
        const packet = new Uint8Array(event.data);
        if (!packet.length) {
            return;
        }

        if (packet[0] === 3) {
            handleDeviceMessages(packet.subarray(1));
            return;
        }

        if (packet[0] === 4) {
            try {
                const metadata = JSON.parse(new TextDecoder().decode(packet.subarray(1)));
                updateScreenSize(metadata.screenWidth, metadata.screenHeight);
                setStatus("已连接", "connected");
            } catch (error) {
                console.error("无法解析设备信息", error);
            }
            return;
        }

        if (packet[0] !== 0 || packet.length <= FRAME_HEADER_BYTES || !muxer) {
            return;
        }

        const frame = packet.subarray(FRAME_HEADER_BYTES);
        if ((packet[1] & 0x80) !== 0) {
            // JMuxer keeps the first SPS/PPS. Start a new decoder when scrcpy
            // changes them, otherwise rotating can leave MSE using the old size.
            if (videoConfiguration && (videoConfiguration.length !== frame.length ||
                videoConfiguration.some((byte, index) => byte !== frame[index]))) {
                receivedVideo = false;
                createMuxer();
                showLoading("正在调整画面");
            }
            videoConfiguration = frame.slice();
        }
        feedVideoFrame(frame, (packet[1] & 0x40) !== 0);
    }

    // scrcpy sends its metadata once. Later rotations change the decoded video
    // dimensions, which must also update the layout and touch coordinate space.
    video.addEventListener("resize", () => updateScreenSize(video.videoWidth, video.videoHeight));
    video.addEventListener("playing", () => {
        video.classList.add("ready");
        loading.classList.add("hidden");
        setStatus("已连接", "connected");
    });

    function sendControl(payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        const message = new Uint8Array(payload.length + 1);
        message[0] = CONTROL_CHANNEL;
        message.set(payload, 1);
        socket.send(message);
        return true;
    }

    function sendKey(action, keycode, repeat = 0, metaState = 0) {
        const payload = new Uint8Array(14);
        const view = new DataView(payload.buffer);
        view.setUint8(0, 0);
        view.setUint8(1, action);
        view.setInt32(2, keycode);
        view.setInt32(6, repeat);
        view.setInt32(10, metaState);
        sendControl(payload);
    }

    function pressKey(keycode) {
        sendKey(0, keycode);
        window.setTimeout(() => sendKey(1, keycode), 30);
    }

    function nextClipboardSequence() {
        clipboardSequence += 1n;
        return clipboardSequence;
    }

    function sendClipboardNow(text, paste, sequence) {
        const encoded = new TextEncoder().encode(text);
        if (encoded.length > 256 * 1024 - 14) {
            throw new Error("剪贴板文本过长");
        }
        const payload = new Uint8Array(14 + encoded.length);
        const view = new DataView(payload.buffer);
        view.setUint8(0, 9);
        view.setBigUint64(1, sequence);
        view.setUint8(9, paste ? 1 : 0);
        view.setUint32(10, encoded.length);
        payload.set(encoded, 14);
        return sendControl(payload);
    }

    function pumpInputQueue() {
        if (clipboardAckSequence !== undefined) {
            return;
        }
        while (inputQueue.length) {
            const operation = inputQueue[0];
            if (operation.type === "key") {
                inputQueue.shift();
                sendKey(operation.action, operation.keycode, operation.repeat, operation.metaState);
                continue;
            }

            const sequence = nextClipboardSequence();
            if (!sendClipboardNow(operation.text, false, sequence)) {
                return;
            }
            inputQueue.shift();
            clipboardAckSequence = sequence;
            clipboardAckPaste = operation.paste;
            clearTimeout(clipboardAckTimer);
            clipboardAckTimer = setTimeout(finishClipboardOperation, 1000);
            return;
        }
    }

    function finishClipboardOperation() {
        const paste = clipboardAckPaste;
        clipboardAckSequence = undefined;
        clipboardAckPaste = false;
        if (paste) {
            sendKey(0, 50, 0, 0x1000);
            setTimeout(() => {
                sendKey(1, 50, 0, 0x1000);
                setTimeout(pumpInputQueue, 20);
            }, 30);
            return;
        }
        pumpInputQueue();
    }

    function acknowledgeClipboard(sequence) {
        if (sequence !== clipboardAckSequence) {
            return;
        }
        clearTimeout(clipboardAckTimer);
        finishClipboardOperation();
    }

    function flushTextInput() {
        clearTimeout(textInputTimer);
        if (!textInputBuffer) {
            return;
        }
        inputQueue.push({ type: "clipboard", text: textInputBuffer, paste: true });
        textInputBuffer = "";
        pumpInputQueue();
    }

    function sendClipboard(text, paste) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        flushTextInput();
        inputQueue.push({ type: "clipboard", text, paste });
        pumpInputQueue();
        return true;
    }

    function sendTextInput(text) {
        if (!text || !socket || socket.readyState !== WebSocket.OPEN) {
            return !text;
        }
        textInputBuffer += text;
        clearTimeout(textInputTimer);
        textInputTimer = setTimeout(flushTextInput, 160);
        return true;
    }

    function sendCapturedKey(action, keycode, repeat = 0, metaState = 0) {
        flushTextInput();
        inputQueue.push({ type: "key", action, keycode, repeat, metaState });
        pumpInputQueue();
    }

    function pressCapturedKey(keycode) {
        sendCapturedKey(0, keycode);
        sendCapturedKey(1, keycode);
    }

    function requestDeviceClipboard() {
        const sent = sendControl(new Uint8Array([8, 0]));
        if (sent) {
            clearTimeout(clipboardReadTimer);
            clipboardReadTimer = setTimeout(() => {
                clipboardText.value = "";
                toolsStatus.textContent = "设备剪贴板为空";
                showToast("设备剪贴板为空");
            }, 1200);
        }
        return sent;
    }

    function sendSimpleControl(type) {
        return sendControl(new Uint8Array([type]));
    }

    function pointerPosition(event) {
        const rect = screen.getBoundingClientRect();
        const x = Math.round((event.clientX - rect.left) * screenWidth / rect.width);
        const y = Math.round((event.clientY - rect.top) * screenHeight / rect.height);
        return {
            x: Math.max(0, Math.min(screenWidth - 1, x)),
            y: Math.max(0, Math.min(screenHeight - 1, y))
        };
    }

    function sendTouch(action, event) {
        const position = pointerPosition(event);
        const payload = new Uint8Array(32);
        const view = new DataView(payload.buffer);
        view.setUint8(0, 2);
        view.setUint8(1, action);
        view.setUint32(2, 0);
        view.setUint32(6, event.pointerId >>> 0);
        view.setUint32(10, position.x);
        view.setUint32(14, position.y);
        view.setUint16(18, screenWidth);
        view.setUint16(20, screenHeight);
        view.setUint16(22, action === 1 ? 0 : 65535);
        view.setUint32(24, 0);
        view.setUint32(28, action === 1 ? 0 : 1);
        sendControl(payload);
    }

    screen.addEventListener("pointerdown", event => {
        event.preventDefault();
        screen.focus();
        screen.setPointerCapture(event.pointerId);
        activePointers.add(event.pointerId);
        sendTouch(0, event);
    });

    screen.addEventListener("pointermove", event => {
        if (!activePointers.has(event.pointerId)) {
            return;
        }
        event.preventDefault();
        sendTouch(2, event);
    });

    function finishPointer(event) {
        if (!activePointers.delete(event.pointerId)) {
            return;
        }
        event.preventDefault();
        sendTouch(1, event);
        if (event.pointerType === "mouse" && event.button === 0) {
            setTimeout(() => keyboardCapture.focus({ preventScroll: true }), 0);
        }
    }

    screen.addEventListener("pointerup", finishPointer);
    screen.addEventListener("pointercancel", finishPointer);
    screen.addEventListener("contextmenu", event => {
        event.preventDefault();
        pressKey(4);
    });

    document.querySelectorAll("[data-keycode]").forEach(button => {
        button.addEventListener("click", () => pressKey(Number(button.dataset.keycode)));
    });

    document.getElementById("reconnect").addEventListener("click", () => {
        deviceId = fixedDeviceId;
        connect();
    });

    const keycodes = {
        Escape: 4,
        Home: 3,
        Enter: 66,
        Backspace: 67,
        Delete: 112,
        Tab: 61,
        ArrowUp: 19,
        ArrowDown: 20,
        ArrowLeft: 21,
        ArrowRight: 22
    };
    const LANGUAGE_SWITCH_KEYCODE = 204;
    let shiftTapCandidate = false;

    function browserKeycode(event) {
        if (keycodes[event.key] !== undefined) {
            return keycodes[event.key];
        }
        return undefined;
    }

    screen.addEventListener("keydown", event => {
        if (event.key === "Shift") {
            event.preventDefault();
            shiftTapCandidate = !event.repeat;
            return;
        }
        if (event.shiftKey) {
            shiftTapCandidate = false;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            sendTextInput(event.key);
            return;
        }
        const keycode = browserKeycode(event);
        if (keycode === undefined) {
            return;
        }
        event.preventDefault();
        const metaState = event.shiftKey ? 1 : 0;
        sendCapturedKey(0, keycode, event.repeat ? 1 : 0, metaState);
    });

    screen.addEventListener("keyup", event => {
        if (event.key === "Shift") {
            event.preventDefault();
            if (shiftTapCandidate) {
                pressCapturedKey(LANGUAGE_SWITCH_KEYCODE);
            }
            shiftTapCandidate = false;
            return;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            return;
        }
        const keycode = browserKeycode(event);
        if (keycode === undefined) {
            return;
        }
        event.preventDefault();
        const metaState = event.shiftKey ? 1 : 0;
        sendCapturedKey(1, keycode, 0, metaState);
    });

    function captureControlKey(event, action) {
        if (event.key === "Shift") {
            event.preventDefault();
            if (action === 0) {
                shiftTapCandidate = !event.repeat;
            } else {
                if (shiftTapCandidate) {
                    pressCapturedKey(LANGUAGE_SWITCH_KEYCODE);
                }
                shiftTapCandidate = false;
            }
            return;
        }
        if (action === 0 && event.shiftKey) {
            shiftTapCandidate = false;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
            event.preventDefault();
            if (action === 0) {
                sendControl(new Uint8Array([8, 1]));
            }
            return;
        }
        const keycode = browserKeycode(event);
        if (keycode === undefined) {
            return;
        }
        event.preventDefault();
        sendCapturedKey(action, keycode, event.repeat ? 1 : 0, event.shiftKey ? 1 : 0);
    }

    keyboardCapture.addEventListener("keydown", event => captureControlKey(event, 0));
    keyboardCapture.addEventListener("keyup", event => captureControlKey(event, 1));

    let compositionTimer;
    keyboardCapture.addEventListener("compositionend", () => {
        clearTimeout(compositionTimer);
        compositionTimer = setTimeout(() => {
            if (keyboardCapture.value) {
                sendTextInput(keyboardCapture.value);
                keyboardCapture.value = "";
            }
        }, 0);
    });

    keyboardCapture.addEventListener("input", event => {
        if (event.isComposing) {
            return;
        }
        clearTimeout(compositionTimer);
        const text = keyboardCapture.value || event.data || "";
        keyboardCapture.value = "";
        sendTextInput(text);
    });

    keyboardCapture.addEventListener("paste", event => {
        event.preventDefault();
        clearTimeout(compositionTimer);
        const text = event.clipboardData?.getData("text/plain") || "";
        keyboardCapture.value = "";
        sendTextInput(text);
    });

    const fileManager = document.getElementById("file-manager");
    const fileList = document.getElementById("file-list");
    const filePath = document.getElementById("file-path");
    const fileStatus = document.getElementById("file-status");
    const fileProgress = document.getElementById("file-progress");
    const fileInput = document.getElementById("file-input");
    const apkInput = document.getElementById("apk-input");
    const dropOverlay = document.getElementById("drop-overlay");
    const toast = document.getElementById("toast");
    const devicePicker = document.getElementById("device-picker");
    const usbDeviceList = document.getElementById("usb-device-list");
    const emulatorDeviceList = document.getElementById("emulator-device-list");
    const networkDeviceList = document.getElementById("network-device-list");
    const devicePickerStatus = document.getElementById("device-picker-status");
    const selectedDeviceLabel = document.getElementById("selected-device-label");
    const deviceIdentity = document.getElementById("device-identity");
    const deviceSerial = document.getElementById("device-serial");
    const deviceNameInput = document.getElementById("device-name-input");
    const renameDevice = document.getElementById("rename-device");
    const disconnectDevice = document.getElementById("disconnect-device");
    const aliasStorageKey = "physical-web.device-aliases.v1";
    let systemDeviceName = deviceId || "Android 设备";
    let currentPath = "/sdcard";
    let dragDepth = 0;
    let toastTimer;
    let resourceTimer;
    let resourceRequestActive = false;
    let deviceRefreshTimer;
    let deviceRefreshActive = false;

    function readDeviceAliases() {
        try {
            const value = JSON.parse(localStorage.getItem(aliasStorageKey) || "{}");
            return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        } catch {
            return {};
        }
    }

    function deviceAlias() {
        return deviceId ? String(readDeviceAliases()[deviceId] || "") : "";
    }

    function renderDeviceDisplayName() {
        deviceIdentity.textContent = deviceAlias() || systemDeviceName;
        deviceSerial.textContent = deviceId || "--";
    }

    function finishDeviceRename(save = true) {
        if (deviceNameInput.hidden) {
            return;
        }
        if (save && deviceId) {
            const aliases = readDeviceAliases();
            const alias = deviceNameInput.value.trim().slice(0, 40);
            if (alias) {
                aliases[deviceId] = alias;
            } else {
                delete aliases[deviceId];
            }
            localStorage.setItem(aliasStorageKey, JSON.stringify(aliases));
            window.parent.postMessage({ type: "physical-web:device-alias", device: deviceId, alias }, location.origin);
        }
        deviceNameInput.hidden = true;
        deviceIdentity.hidden = false;
        renameDevice.textContent = "修改";
        renderDeviceDisplayName();
    }

    renameDevice.addEventListener("click", () => {
        if (!deviceNameInput.hidden) {
            finishDeviceRename();
            return;
        }
        deviceIdentity.hidden = true;
        deviceNameInput.hidden = false;
        deviceNameInput.value = deviceAlias();
        deviceNameInput.placeholder = systemDeviceName;
        renameDevice.textContent = "保存";
        deviceNameInput.focus();
        deviceNameInput.select();
    });
    deviceNameInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            finishDeviceRename();
        } else if (event.key === "Escape") {
            event.preventDefault();
            finishDeviceRename(false);
        }
    });
    deviceNameInput.addEventListener("blur", event => {
        if (event.relatedTarget !== renameDevice) {
            finishDeviceRename();
        }
    });
    document.getElementById("close-device-frame").addEventListener("click", () => {
        if (fixedDeviceId && window.parent !== window) {
            window.parent.postMessage({ type: "physical-web:close-device", device: fixedDeviceId }, location.origin);
        }
    });

    function showToast(message, isError = false, timeout = 4000) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.toggle("error", isError);
        toast.hidden = false;
        if (timeout) {
            toastTimer = setTimeout(() => {
                toast.hidden = true;
            }, timeout);
        }
    }

    async function apiJson(url, options) {
        const response = await fetch(localApiUrl(url), { cache: "no-store", ...options });
        let body = {};
        try {
            body = await response.json();
        } catch {
            body = {};
        }
        if (!response.ok) {
            throw new Error(body.error || `请求失败 (${response.status})`);
        }
        return body;
    }

    function deviceStateText(device) {
        if (device.state === "device") {
            if (device.type === "emulator") {
                return "模拟器已连接";
            }
            return device.type === "usb" ? "USB 已授权" : "网络已连接";
        }
        if (device.state === "unauthorized") {
            return "等待手机授权";
        }
        if (device.state === "pairing") {
            return "等待配对码";
        }
        if (device.state === "available") {
            return "局域网已发现";
        }
        if (device.state === "offline") {
            return "设备离线";
        }
        return device.state;
    }

    function updateDeviceIdentity(device) {
        const label = device?.model || device?.name || deviceId || "未选择设备";
        systemDeviceName = label;
        renderDeviceDisplayName();
        selectedDeviceLabel.textContent = deviceId ? `${label} · ${deviceId}` : "未连接";
        disconnectDevice.hidden = !deviceId || Boolean(fixedDeviceId);
    }

    async function runDeviceAction(body, pendingText) {
        devicePickerStatus.textContent = pendingText;
        document.querySelectorAll(".device-row-command").forEach(button => {
            button.disabled = true;
        });
        try {
            const result = await apiJson("/local-api/devices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            if (body.action === "select" || body.action === "connect") {
                deviceId = result.selectedDevice;
                const selected = result.devices.find(device => device.selected);
                updateDeviceIdentity(selected);
                devicePickerStatus.textContent = "设备已连接";
                devicePicker.close();
                connect();
            } else if (body.action === "pair") {
                devicePickerStatus.textContent = "配对成功，正在等待连接服务";
                showToast("网络设备配对成功");
                await refreshDevices();
            } else if (body.action === "disconnect") {
                if (socket) {
                    socket.onclose = null;
                    socket.close();
                }
                deviceId = undefined;
                destroyMuxer();
                updateDeviceIdentity(null);
                setStatus("请选择设备");
                showLoading("请选择要控制的设备");
                await refreshDevices();
            }
        } catch (error) {
            devicePickerStatus.textContent = `操作失败：${error.message}`;
            showToast(`设备操作失败：${error.message}`, true, 6000);
            await refreshDevices(false);
        } finally {
            document.querySelector("#adb-connect-form button").disabled = false;
        }
    }

    function createDeviceRow(device) {
        const row = document.createElement("div");
        row.className = `connection-device-row${device.selected ? " selected" : ""}`;

        const kind = document.createElement("span");
        kind.className = "device-kind";
        kind.textContent = { usb: "USB", emulator: "EMU", network: "LAN" }[device.type] || "ADB";
        row.appendChild(kind);

        const main = document.createElement("div");
        main.className = "device-row-main";
        const name = document.createElement("strong");
        name.textContent = device.model || device.name || "Android 设备";
        const meta = document.createElement("span");
        meta.textContent = `${deviceStateText(device)} · ${device.serial || device.address}`;
        main.append(name, meta);
        row.appendChild(main);

        if (device.state === "pairing") {
            const controls = document.createElement("div");
            controls.className = "device-pair-controls";
            const input = document.createElement("input");
            input.type = "text";
            input.inputMode = "numeric";
            input.autocomplete = "one-time-code";
            input.maxLength = 6;
            input.placeholder = "配对码";
            input.setAttribute("aria-label", `${device.name} 配对码`);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "device-row-command primary";
            button.textContent = "配对";
            button.addEventListener("click", () => runDeviceAction({
                action: "pair",
                address: device.address,
                code: input.value
            }, "正在配对网络设备"));
            controls.append(input, button);
            row.appendChild(controls);
            return row;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "device-row-command";
        if (device.selected) {
            button.textContent = "当前设备";
            button.disabled = true;
        } else if (device.state === "device") {
            button.textContent = "选择";
            button.classList.add("primary");
            button.addEventListener("click", () => runDeviceAction({ action: "select", serial: device.serial }, "正在切换设备"));
        } else if (device.state === "available") {
            button.textContent = "连接";
            button.classList.add("primary");
            button.addEventListener("click", () => runDeviceAction({ action: "connect", address: device.address }, "正在连接网络设备"));
        } else {
            button.textContent = device.state === "unauthorized" ? "等待授权" : "不可用";
            button.disabled = true;
        }
        row.appendChild(button);
        return row;
    }

    function renderDeviceList(container, devices, emptyText) {
        container.replaceChildren();
        if (!devices.length) {
            const empty = document.createElement("div");
            empty.className = "device-empty";
            empty.textContent = emptyText;
            container.appendChild(empty);
            return;
        }
        container.append(...devices.map(createDeviceRow));
    }

    async function refreshDevices(showPending = true) {
        if (deviceRefreshActive) {
            return;
        }
        deviceRefreshActive = true;
        if (showPending) {
            devicePickerStatus.textContent = "正在扫描真机和模拟器";
        }
        try {
            const result = await apiJson("/local-api/devices");
            const selected = fixedDeviceId ?
                result.devices.find(device => device.serial === fixedDeviceId) :
                result.devices.find(device => device.selected);
            if (fixedDeviceId) {
                deviceId = fixedDeviceId;
            } else if (result.selectedDevice) {
                deviceId = result.selectedDevice;
            } else if (!socket || socket.readyState !== WebSocket.OPEN) {
                deviceId = undefined;
            }
            updateDeviceIdentity(selected);
            renderDeviceList(usbDeviceList, result.devices.filter(device => device.type === "usb"), "未发现 USB Android 设备");
            renderDeviceList(emulatorDeviceList, result.devices.filter(device => device.type === "emulator"), "未发现模拟器，可通过 ADB 地址连接");
            renderDeviceList(networkDeviceList, result.devices.filter(device => device.type === "network"), "未发现局域网 Android 设备");
            devicePickerStatus.textContent = `发现 ${result.devices.length} 个设备或服务`;
        } catch (error) {
            devicePickerStatus.textContent = `扫描失败：${error.message}`;
        } finally {
            deviceRefreshActive = false;
        }
    }

    function openDevicePicker() {
        if (fixedDeviceId && window.parent !== window) {
            window.parent.postMessage({ type: "physical-web:open-devices" }, location.origin);
            return;
        }
        if (!devicePicker.open) {
            devicePicker.showModal();
        }
        clearInterval(deviceRefreshTimer);
        refreshDevices();
        deviceRefreshTimer = setInterval(() => refreshDevices(false), 3000);
    }

    function closeDevicePicker() {
        if (!deviceId) {
            devicePickerStatus.textContent = "请先选择一个可用设备";
            return;
        }
        devicePicker.close();
    }

    document.getElementById("open-devices").addEventListener("click", openDevicePicker);
    document.getElementById("refresh-devices").addEventListener("click", () => refreshDevices());
    document.getElementById("close-devices").addEventListener("click", closeDevicePicker);
    document.getElementById("adb-connect-form").addEventListener("submit", event => {
        event.preventDefault();
        runDeviceAction({ action: "connect", address: document.getElementById("adb-address").value }, "正在连接 ADB 设备");
    });
    disconnectDevice.addEventListener("click", () => runDeviceAction({ action: "disconnect" }, "正在断开设备"));
    devicePicker.addEventListener("close", () => clearInterval(deviceRefreshTimer));
    devicePicker.addEventListener("cancel", event => {
        if (!deviceId) {
            event.preventDefault();
            devicePickerStatus.textContent = "请先选择一个可用设备";
        }
    });

    async function refreshResourceMonitor() {
        if (!deviceId || resourceRequestActive || document.hidden) {
            return;
        }
        resourceRequestActive = true;
        try {
            const body = await apiJson("/local-api/device/resources");
            document.getElementById("cpu-usage").textContent = `${body.cpuPercent}%`;
            document.getElementById("memory-usage").textContent = `${body.memory.usedMb}/${body.memory.totalMb}M`;
            const gpuUsage = document.getElementById("gpu-usage");
            gpuUsage.textContent = body.gpu.percent === null ? body.gpu.software ? "软件" : "不可用" : `${body.gpu.percent}%`;
            document.getElementById("gpu-metric").title = body.gpu.renderer;
            postDashboardTelemetry({
                cpu: `${body.cpuPercent}%`,
                memory: `${body.memory.usedMb}/${body.memory.totalMb}M`
            });
        } catch {
            document.getElementById("cpu-usage").textContent = "--";
            document.getElementById("memory-usage").textContent = "--";
            document.getElementById("gpu-usage").textContent = "--";
            postDashboardTelemetry({ cpu: "--", memory: "--" });
        } finally {
            resourceRequestActive = false;
        }
    }

    function formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 1) {
            return bytes === 0 ? "0 B" : "-";
        }
        const units = ["B", "KB", "MB", "GB"];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const value = bytes / (1024 ** index);
        return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
    }

    function formatTime(value) {
        if (!value) {
            return "-";
        }
        return new Intl.DateTimeFormat("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        }).format(new Date(value));
    }

    function parentPath(remotePath) {
        if (remotePath === "/sdcard") {
            return remotePath;
        }
        const parent = remotePath.slice(0, remotePath.lastIndexOf("/"));
        return parent === "/sdcard" || parent.startsWith("/sdcard/") ? parent : "/sdcard";
    }

    function downloadFile(item) {
        const link = document.createElement("a");
        link.href = localApiUrl(`/local-api/files/download?path=${encodeURIComponent(item.path)}`);
        link.download = item.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    async function deleteItem(item) {
        const type = item.directory ? "文件夹" : "文件";
        if (!window.confirm(`确定删除${type}“${item.name}”吗？${item.directory ? " 文件夹内的内容也会被删除。" : ""}`)) {
            return;
        }
        fileStatus.textContent = `正在删除 ${item.name}`;
        try {
            await apiJson(`/local-api/files?path=${encodeURIComponent(item.path)}`, { method: "DELETE" });
            await loadFiles();
        } catch (error) {
            fileStatus.textContent = `删除失败：${error.message}`;
            showToast(`删除失败：${error.message}`, true);
        }
    }

    function makeAction(symbol, title, handler, className = "") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `file-action ${className}`.trim();
        button.title = title;
        button.setAttribute("aria-label", title);
        button.textContent = symbol;
        button.addEventListener("click", handler);
        return button;
    }

    function renderFiles(files) {
        fileList.replaceChildren();
        if (!files.length) {
            const empty = document.createElement("div");
            empty.className = "file-empty";
            empty.textContent = "此文件夹为空";
            fileList.appendChild(empty);
            return;
        }

        for (const item of files) {
            const row = document.createElement("div");
            row.className = "file-row";
            row.setAttribute("role", "listitem");

            const name = document.createElement("button");
            name.type = "button";
            name.className = `file-name${item.directory ? " directory" : ""}`;
            name.title = item.directory ? `打开 ${item.name}` : item.name;
            const icon = document.createElement("span");
            icon.className = "file-icon";
            icon.textContent = item.directory ? "\uD83D\uDCC1" : "\u25A4";
            const label = document.createElement("span");
            label.className = "label";
            label.textContent = item.name;
            name.append(icon, label);
            if (item.directory) {
                name.addEventListener("click", () => loadFiles(item.path));
            }

            const size = document.createElement("span");
            size.className = "file-meta";
            size.textContent = item.directory ? "-" : formatSize(item.size);
            const modified = document.createElement("span");
            modified.className = "file-meta";
            modified.textContent = formatTime(item.modified);
            const actions = document.createElement("div");
            actions.className = "file-actions";
            if (!item.directory) {
                actions.appendChild(makeAction("\u21E9", `下载 ${item.name}`, () => downloadFile(item)));
            }
            actions.appendChild(makeAction("\u00D7", `删除 ${item.name}`, () => deleteItem(item), "delete"));
            row.append(name, size, modified, actions);
            fileList.appendChild(row);
        }
    }

    async function loadFiles(remotePath = currentPath) {
        fileStatus.textContent = "正在读取";
        fileList.setAttribute("aria-busy", "true");
        try {
            const body = await apiJson(`/local-api/files?path=${encodeURIComponent(remotePath)}`);
            currentPath = body.path;
            filePath.textContent = currentPath;
            document.getElementById("file-up").disabled = currentPath === "/sdcard";
            renderFiles(body.files);
            fileStatus.textContent = `${body.files.length} 个项目`;
        } catch (error) {
            fileStatus.textContent = `读取失败：${error.message}`;
            showToast(`读取失败：${error.message}`, true);
        } finally {
            fileList.removeAttribute("aria-busy");
        }
    }

    function uploadBlob(endpoint, file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", localApiUrl(endpoint));
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            xhr.upload.onprogress = event => {
                if (event.lengthComputable) {
                    onProgress(Math.round(event.loaded * 100 / event.total));
                }
            };
            xhr.onerror = () => reject(new Error("网络连接失败"));
            xhr.onload = () => {
                let body = {};
                try {
                    body = JSON.parse(xhr.responseText || "{}");
                } catch {
                    body = {};
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(body);
                } else {
                    reject(new Error(body.error || `请求失败 (${xhr.status})`));
                }
            };
            xhr.send(file);
        });
    }

    function showProgress(value) {
        fileProgress.hidden = false;
        fileProgress.value = value;
    }

    async function uploadFiles(files) {
        const selected = Array.from(files);
        if (!selected.length) {
            return;
        }
        const destination = currentPath;
        fileProgress.hidden = false;
        try {
            for (let index = 0; index < selected.length; index += 1) {
                const file = selected[index];
                fileStatus.textContent = `正在上传 ${file.name} (${index + 1}/${selected.length})`;
                showProgress(0);
                const url = `/local-api/files/upload?path=${encodeURIComponent(destination)}&name=${encodeURIComponent(file.name)}`;
                await uploadBlob(url, file, showProgress);
            }
            fileStatus.textContent = `已上传 ${selected.length} 个文件`;
            showToast(`上传完成：${selected.length} 个文件`);
            await loadFiles(destination);
        } catch (error) {
            fileStatus.textContent = `上传失败：${error.message}`;
            showToast(`上传失败：${error.message}`, true, 6000);
        } finally {
            fileProgress.hidden = true;
            fileInput.value = "";
        }
    }

    async function installApks(files) {
        const selected = Array.from(files).filter(file => file.name.toLowerCase().endsWith(".apk"));
        if (!selected.length) {
            showToast("没有找到 APK 文件", true);
            return;
        }
        try {
            for (let index = 0; index < selected.length; index += 1) {
                const file = selected[index];
                const prefix = selected.length > 1 ? ` (${index + 1}/${selected.length})` : "";
                showToast(`正在上传 ${file.name}${prefix}：0%`, false, 0);
                const url = `/local-api/apk/install?name=${encodeURIComponent(file.name)}`;
                await uploadBlob(url, file, progress => {
                    showToast(progress < 100 ? `正在上传 ${file.name}${prefix}：${progress}%` : `正在安装 ${file.name}${prefix}`, false, 0);
                });
                showToast(`${file.name} 安装成功`, false, selected.length > 1 ? 1200 : 5000);
            }
            if (selected.length > 1) {
                showToast(`${selected.length} 个 APK 安装成功`);
            }
        } catch (error) {
            showToast(`安装失败：${error.message}`, true, 8000);
        } finally {
            apkInput.value = "";
        }
    }

    document.getElementById("open-files").addEventListener("click", () => {
        if (!fileManager.open) {
            fileManager.showModal();
        }
        loadFiles();
    });
    document.getElementById("close-files").addEventListener("click", () => fileManager.close());
    document.getElementById("file-up").addEventListener("click", () => loadFiles(parentPath(currentPath)));
    document.getElementById("file-refresh").addEventListener("click", () => loadFiles());
    document.getElementById("file-upload").addEventListener("click", () => fileInput.click());
    document.getElementById("apk-picker").addEventListener("click", () => apkInput.click());
    fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
    apkInput.addEventListener("change", () => installApks(apkInput.files));

    document.getElementById("file-mkdir").addEventListener("click", async () => {
        const name = window.prompt("请输入文件夹名称");
        if (!name) {
            return;
        }
        if (name === "." || name === ".." || /[\\/\r\n]/.test(name)) {
            showToast("文件夹名称无效", true);
            return;
        }
        const remotePath = `${currentPath}/${name}`;
        fileStatus.textContent = `正在创建 ${name}`;
        try {
            await apiJson("/local-api/files/mkdir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: remotePath })
            });
            await loadFiles();
        } catch (error) {
            fileStatus.textContent = `创建失败：${error.message}`;
            showToast(`创建失败：${error.message}`, true);
        }
    });

    fileManager.addEventListener("click", event => {
        if (event.target === fileManager) {
            fileManager.close();
        }
    });

    window.addEventListener("dragenter", event => {
        if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) {
            return;
        }
        event.preventDefault();
        dragDepth += 1;
        dropOverlay.classList.add("visible");
    });
    window.addEventListener("dragover", event => {
        if (event.dataTransfer) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    window.addEventListener("dragleave", event => {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) {
            dropOverlay.classList.remove("visible");
        }
    });
    window.addEventListener("drop", event => {
        event.preventDefault();
        dragDepth = 0;
        dropOverlay.classList.remove("visible");
        const files = Array.from(event.dataTransfer.files);
        const apks = files.filter(file => file.name.toLowerCase().endsWith(".apk"));
        const ordinary = files.filter(file => !file.name.toLowerCase().endsWith(".apk"));
        if (apks.length) {
            installApks(apks);
        }
        if (ordinary.length && fileManager.open) {
            uploadFiles(ordinary);
        } else if (ordinary.length) {
            showToast("普通文件请打开文件管理器后拖入", true);
        }
    });

    const deviceTools = document.getElementById("device-tools");
    const toolsStatus = document.getElementById("tools-status");
    const recordingButton = document.getElementById("toggle-recording");
    const batteryLevel = document.getElementById("battery-level");
    const batteryOutput = document.getElementById("battery-output");
    let recordingActive = false;

    function selectToolTab(tab) {
        document.querySelectorAll("[data-tool-tab]").forEach(button => {
            button.classList.toggle("active", button.dataset.toolTab === tab);
        });
        document.querySelectorAll("[data-tool-panel]").forEach(panel => {
            panel.classList.toggle("active", panel.dataset.toolPanel === tab);
        });
    }

    async function postTool(endpoint, body, pendingText, successText) {
        toolsStatus.textContent = pendingText;
        try {
            const result = await apiJson(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            toolsStatus.textContent = successText;
            showToast(successText);
            return result;
        } catch (error) {
            toolsStatus.textContent = `操作失败：${error.message}`;
            showToast(`操作失败：${error.message}`, true, 6000);
            throw error;
        }
    }

    function updateDisplayForm(display) {
        document.getElementById("display-width").value = display.width;
        document.getElementById("display-height").value = display.height;
        document.getElementById("display-density").value = display.density;
        const active = display.automaticRotation ? "auto" : String(display.rotation);
        document.querySelectorAll("[data-rotation]").forEach(button => {
            button.classList.toggle("active", button.dataset.rotation === active);
        });
    }

    function updateNetworkForm(network) {
        document.getElementById("wifi-enabled").checked = network.enabled;
        document.getElementById("network-state").textContent = network.connected ? network.ssid : network.enabled ? "未连接" : "Wi-Fi 已关闭";
        document.getElementById("network-address").textContent = network.ip || "-";
        const separator = network.proxy.lastIndexOf(":");
        document.getElementById("proxy-host").value = separator > 0 ? network.proxy.slice(0, separator) : "";
        document.getElementById("proxy-port").value = separator > 0 ? network.proxy.slice(separator + 1) : "";
        document.getElementById("dns-host").value = network.privateDnsMode === "hostname" ? network.privateDnsHost : "";
    }

    function updateSimulationForm(body) {
        batteryLevel.value = body.battery.level;
        batteryOutput.value = `${body.battery.level}%`;
        document.getElementById("battery-charging").checked = body.battery.charging;
        if (body.location.mock) {
            document.getElementById("mock-latitude").value = body.location.mock.latitude;
            document.getElementById("mock-longitude").value = body.location.mock.longitude;
            document.getElementById("mock-accuracy").value = body.location.mock.accuracy;
        }
    }

    async function refreshTools() {
        toolsStatus.textContent = "正在读取设备状态";
        try {
            const body = await apiJson("/local-api/device/status");
            updateDisplayForm(body.display);
            updateNetworkForm(body.network);
            updateSimulationForm(body);
            toolsStatus.textContent = "设备状态已更新";
        } catch (error) {
            toolsStatus.textContent = `读取失败：${error.message}`;
            showToast(`读取设备状态失败：${error.message}`, true);
        }
    }

    function openTools(tab = "clipboard") {
        selectToolTab(tab);
        if (!deviceTools.open) {
            deviceTools.showModal();
        }
        refreshTools();
    }

    async function copyTextToComputer(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        clipboardText.focus();
        clipboardText.select();
        if (!document.execCommand("copy")) {
            throw new Error("浏览器拒绝访问剪贴板");
        }
    }

    document.getElementById("paste-device").addEventListener("click", () => {
        try {
            if (!sendClipboard(clipboardText.value, true)) {
                throw new Error("设备尚未连接");
            }
            showToast("文本已粘贴到设备");
        } catch (error) {
            showToast(error.message, true);
        }
    });

    document.getElementById("read-device-clipboard").addEventListener("click", () => {
        if (requestDeviceClipboard()) {
            toolsStatus.textContent = "正在读取设备剪贴板";
        } else {
            showToast("设备尚未连接", true);
        }
    });

    document.getElementById("copy-computer").addEventListener("click", async () => {
        try {
            await copyTextToComputer(clipboardText.value);
            showToast("已复制到电脑剪贴板");
        } catch (error) {
            showToast(error.message, true);
        }
    });

    document.getElementById("read-computer").addEventListener("click", async () => {
        try {
            if (!navigator.clipboard || !window.isSecureContext) {
                throw new Error("当前浏览器要求在文本框中直接粘贴");
            }
            clipboardText.value = await navigator.clipboard.readText();
            showToast("已读取电脑剪贴板");
        } catch (error) {
            showToast(error.message, true);
        }
    });

    async function takeScreenshot() {
        showToast("正在截图", false, 0);
        try {
            const response = await fetch(localApiUrl("/local-api/device/screenshot"), { cache: "no-store" });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || `截图失败 (${response.status})`);
            }
            const blob = await response.blob();
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `android-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            showToast("截图已下载");
        } catch (error) {
            showToast(error.message, true);
        }
    }

    function updateRecordingButton(active) {
        recordingActive = active;
        recordingButton.classList.toggle("recording", active);
        recordingButton.title = active ? "停止录屏" : "开始录屏";
        recordingButton.setAttribute("aria-label", recordingButton.title);
    }

    function downloadRemotePath(remotePath) {
        const link = document.createElement("a");
        link.href = localApiUrl(`/local-api/files/download?path=${encodeURIComponent(remotePath)}`);
        link.download = remotePath.slice(remotePath.lastIndexOf("/") + 1);
        link.click();
    }

    async function syncRecording() {
        try {
            const body = await apiJson("/local-api/device/recording");
            updateRecordingButton(body.recording);
        } catch {
            updateRecordingButton(false);
        }
    }

    async function toggleRecording() {
        recordingButton.disabled = true;
        try {
            if (!recordingActive) {
                const body = await postTool("/local-api/device/recording", { action: "start" }, "正在启动录屏", "录屏已开始");
                updateRecordingButton(body.recording);
            } else {
                const body = await postTool("/local-api/device/recording", { action: "stop" }, "正在保存录屏", "录屏已保存");
                updateRecordingButton(false);
                if (body.path) {
                    downloadRemotePath(body.path);
                }
            }
        } catch {
            await syncRecording();
        } finally {
            recordingButton.disabled = false;
        }
    }

    document.getElementById("take-screenshot").addEventListener("click", takeScreenshot);
    recordingButton.addEventListener("click", toggleRecording);
    document.getElementById("open-clipboard").addEventListener("click", () => openTools("clipboard"));
    document.getElementById("open-tools").addEventListener("click", () => openTools("display"));
    document.getElementById("quick-rotate").addEventListener("click", () => {
        if (sendSimpleControl(11)) {
            showToast("已旋转屏幕");
        } else {
            showToast("设备尚未连接", true);
        }
    });

    document.querySelectorAll("[data-tool-tab]").forEach(button => {
        button.addEventListener("click", () => selectToolTab(button.dataset.toolTab));
    });
    document.getElementById("close-tools").addEventListener("click", () => deviceTools.close());
    deviceTools.addEventListener("click", event => {
        if (event.target === deviceTools) {
            deviceTools.close();
        }
    });

    document.getElementById("apply-display").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/display", {
                action: "apply",
                width: document.getElementById("display-width").value,
                height: document.getElementById("display-height").value,
                density: document.getElementById("display-density").value
            }, "正在应用显示设置", "显示设置已应用");
            updateDisplayForm(body.display);
            setTimeout(connect, 700);
        } catch {}
    });

    document.getElementById("reset-display").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/display", { action: "reset" }, "正在恢复显示设置", "显示设置已恢复");
            updateDisplayForm(body.display);
            setTimeout(connect, 700);
        } catch {}
    });

    document.querySelectorAll("[data-rotation]").forEach(button => {
        button.addEventListener("click", async () => {
            const value = button.dataset.rotation;
            try {
                const body = await postTool("/local-api/device/display", value === "auto" ?
                    { action: "rotation", mode: "auto" } :
                    { action: "rotation", mode: "locked", rotation: Number(value) },
                    "正在切换屏幕方向", "屏幕方向已更新");
                updateDisplayForm(body.display);
            } catch {}
        });
    });

    document.getElementById("wifi-enabled").addEventListener("change", async event => {
        try {
            const body = await postTool("/local-api/device/network", {
                action: "wifi",
                enabled: event.target.checked
            }, "正在切换 Wi-Fi", event.target.checked ? "Wi-Fi 已连接" : "Wi-Fi 已关闭");
            updateNetworkForm(body.network);
        } catch {
            refreshTools();
        }
    });

    document.getElementById("apply-proxy").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/network", {
                action: "proxy",
                host: document.getElementById("proxy-host").value,
                port: document.getElementById("proxy-port").value
            }, "正在设置代理", "代理已应用");
            updateNetworkForm(body.network);
        } catch {}
    });

    document.getElementById("clear-proxy").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/network", { action: "clearProxy" }, "正在清除代理", "代理已清除");
            updateNetworkForm(body.network);
        } catch {}
    });

    document.getElementById("apply-dns").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/network", {
                action: "dns",
                host: document.getElementById("dns-host").value
            }, "正在设置私人 DNS", "私人 DNS 已应用");
            updateNetworkForm(body.network);
        } catch {}
    });

    document.getElementById("automatic-dns").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/network", { action: "automaticDns" }, "正在恢复自动 DNS", "DNS 已恢复自动");
            updateNetworkForm(body.network);
        } catch {}
    });

    document.getElementById("apply-location").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/simulation", {
                action: "location",
                latitude: document.getElementById("mock-latitude").value,
                longitude: document.getElementById("mock-longitude").value,
                accuracy: document.getElementById("mock-accuracy").value
            }, "正在设置模拟位置", "模拟位置已应用");
            updateSimulationForm(body);
        } catch {}
    });

    document.getElementById("reset-location").addEventListener("click", async () => {
        try {
            await postTool("/local-api/device/simulation", { action: "resetLocation" }, "正在恢复位置", "模拟位置已关闭");
        } catch {}
    });

    batteryLevel.addEventListener("input", () => {
        batteryOutput.value = `${batteryLevel.value}%`;
    });

    document.getElementById("apply-battery").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/simulation", {
                action: "battery",
                level: batteryLevel.value,
                charging: document.getElementById("battery-charging").checked
            }, "正在设置电池状态", "电池状态已应用");
            updateSimulationForm(body);
        } catch {}
    });

    document.getElementById("reset-battery").addEventListener("click", async () => {
        try {
            const body = await postTool("/local-api/device/simulation", { action: "resetBattery" }, "正在恢复电池状态", "电池状态已恢复");
            updateSimulationForm(body);
        } catch {}
    });

    const workbench = document.getElementById("workbench");
    const workbenchStatus = document.getElementById("workbench-status");
    const appList = document.getElementById("app-list");
    const appDetails = document.getElementById("app-details");
    const shellCommand = document.getElementById("shell-command");
    const shellOutput = document.getElementById("shell-output");
    const logcatOutput = document.getElementById("logcat-output");
    let activeWorkbenchTab = "apps";
    let applications = [];
    let selectedPackage = "";
    let logcatTimer;
    let logcatRequestActive = false;
    let forwardDirection = "forward";

    function makeElement(tag, className = "", text = "") {
        const element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text) {
            element.textContent = text;
        }
        return element;
    }

    function makeCommandButton(text, handler, className = "") {
        const button = makeElement("button", className, text);
        button.type = "button";
        button.addEventListener("click", handler);
        return button;
    }

    function setWorkbenchStatus(text, error = false) {
        workbenchStatus.textContent = text;
        workbenchStatus.style.color = error ? "#fca5a5" : "";
    }

    function stopLogcatTimer() {
        clearInterval(logcatTimer);
        logcatTimer = undefined;
    }

    function selectWorkbenchTab(tab) {
        activeWorkbenchTab = tab;
        document.querySelectorAll("[data-workbench-tab]").forEach(button => {
            button.classList.toggle("active", button.dataset.workbenchTab === tab);
        });
        document.querySelectorAll("[data-workbench-panel]").forEach(panel => {
            panel.classList.toggle("active", panel.dataset.workbenchPanel === tab);
        });
        if (tab !== "logcat") {
            stopLogcatTimer();
        } else if (document.getElementById("auto-logcat").checked) {
            startLogcatTimer();
        }
        if (tab === "apps" && !applications.length) {
            loadApplications();
        } else if (tab === "logcat" && !logcatOutput.textContent) {
            loadLogcat();
        } else if (tab === "diagnostics") {
            loadNetworkOverview();
        } else if (tab === "forwards") {
            loadForwards();
        }
    }

    function renderApplications() {
        const query = document.getElementById("app-search").value.trim().toLowerCase();
        const filtered = applications.filter(app => app.packageName.toLowerCase().includes(query));
        appList.replaceChildren();
        if (!filtered.length) {
            appList.appendChild(makeElement("div", "workbench-empty", query ? "没有匹配的应用" : "没有应用"));
            return;
        }
        for (const app of filtered) {
            const row = makeElement("div", `app-row${app.packageName === selectedPackage ? " selected" : ""}`);
            row.setAttribute("role", "listitem");
            const packageButton = makeCommandButton(app.packageName, () => showApplicationDetails(app), "app-package");
            packageButton.title = app.packageName;
            const state = makeElement("span", `app-state${app.running ? " running" : ""}`, app.running ? "运行中" : "已停止");
            const actions = makeElement("div", "app-actions");
            actions.append(
                makeCommandButton("启动", () => runApplicationAction("launch", app)),
                makeCommandButton("停止", () => runApplicationAction("forceStop", app)),
                makeCommandButton("详情", () => showApplicationDetails(app))
            );
            row.append(packageButton, state, actions);
            appList.appendChild(row);
        }
    }

    async function loadApplications() {
        const scope = document.getElementById("app-scope").value;
        setWorkbenchStatus("正在读取应用列表");
        appList.replaceChildren(makeElement("div", "workbench-empty", "正在读取"));
        try {
            const body = await apiJson(`/local-api/apps?scope=${encodeURIComponent(scope)}`);
            applications = body.apps;
            renderApplications();
            setWorkbenchStatus(`${scope === "system" ? "系统" : "用户"}应用：${applications.length} 个`);
        } catch (error) {
            appList.replaceChildren(makeElement("div", "workbench-empty", `读取失败：${error.message}`));
            setWorkbenchStatus(`读取失败：${error.message}`, true);
        }
    }

    async function runApplicationAction(action, app) {
        const labels = { launch: "启动", forceStop: "停止", clearData: "清除数据", uninstall: "卸载" };
        if (action === "clearData" && !window.confirm(`确定清除 ${app.packageName} 的全部应用数据吗？`)) {
            return;
        }
        if (action === "uninstall" && !window.confirm(`确定卸载 ${app.packageName} 吗？`)) {
            return;
        }
        setWorkbenchStatus(`正在${labels[action]} ${app.packageName}`);
        try {
            await apiJson("/local-api/apps", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, packageName: app.packageName })
            });
            showToast(`${labels[action]}完成：${app.packageName}`);
            setWorkbenchStatus(`${labels[action]}完成`);
            if (action === "uninstall") {
                selectedPackage = "";
                appDetails.replaceChildren(makeElement("strong", "", "应用详情"), makeElement("p", "", "选择应用查看版本和权限。"));
            }
            await loadApplications();
        } catch (error) {
            setWorkbenchStatus(`${labels[action]}失败：${error.message}`, true);
            showToast(`${labels[action]}失败：${error.message}`, true);
        }
    }

    async function showApplicationDetails(app) {
        selectedPackage = app.packageName;
        renderApplications();
        appDetails.replaceChildren(makeElement("strong", "", app.packageName), makeElement("p", "", "正在读取详情"));
        try {
            const detail = await apiJson(`/local-api/apps/details?package=${encodeURIComponent(app.packageName)}`);
            const heading = makeElement("strong", "", detail.packageName);
            const grid = makeElement("div", "app-detail-grid");
            const fields = [
                ["版本", detail.versionName || "-"], ["版本代码", detail.versionCode || "-"],
                ["最低 SDK", detail.minSdk || "-"], ["目标 SDK", detail.targetSdk || "-"],
                ["首次安装", detail.firstInstallTime || "-"], ["最近更新", detail.lastUpdateTime || "-"]
            ];
            for (const [label, value] of fields) {
                grid.append(makeElement("span", "", label), makeElement("span", "", value));
            }
            const actions = makeElement("div", "command-row");
            actions.append(
                makeCommandButton("查看日志", () => {
                    document.getElementById("logcat-package").value = app.packageName;
                    selectWorkbenchTab("logcat");
                    loadLogcat();
                }, "primary-command"),
                makeCommandButton("清除数据", () => runApplicationAction("clearData", app)),
                makeCommandButton("卸载", () => runApplicationAction("uninstall", app), "danger")
            );
            if (app.system) {
                actions.lastElementChild.disabled = true;
                actions.lastElementChild.title = "系统应用不能在此卸载";
            }
            const permissionList = makeElement("div", "permission-list");
            permissionList.appendChild(makeElement("strong", "", `权限（${detail.permissions.length}）`));
            if (!detail.permissions.length) {
                permissionList.appendChild(makeElement("p", "", "没有可显示的权限"));
            }
            for (const permission of detail.permissions) {
                const row = makeElement("div", `permission-row${permission.granted ? " granted" : ""}`);
                row.append(makeElement("b", "", permission.granted ? "允许" : "拒绝"), makeElement("span", "", permission.name));
                permissionList.appendChild(row);
            }
            appDetails.replaceChildren(heading, grid, actions, permissionList);
            setWorkbenchStatus(`已读取 ${app.packageName}`);
        } catch (error) {
            appDetails.replaceChildren(makeElement("strong", "", app.packageName), makeElement("p", "", `读取失败：${error.message}`));
            setWorkbenchStatus(`读取详情失败：${error.message}`, true);
        }
    }

    function readShellHistory() {
        try {
            const value = JSON.parse(localStorage.getItem("android-shell-history") || "[]");
            return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 20) : [];
        } catch {
            return [];
        }
    }

    function updateShellHistory(command) {
        const history = [command, ...readShellHistory().filter(item => item !== command)].slice(0, 20);
        try {
            localStorage.setItem("android-shell-history", JSON.stringify(history));
        } catch {}
        renderShellHistory(history);
    }

    function renderShellHistory(history = readShellHistory()) {
        const select = document.getElementById("shell-history");
        select.replaceChildren(new Option("历史记录", ""));
        history.forEach(command => select.add(new Option(command.replace(/\s+/g, " ").slice(0, 80), command)));
    }

    async function runDeviceShell() {
        const command = shellCommand.value.trim();
        if (!command) {
            showToast("请输入 Shell 命令", true);
            return;
        }
        const button = document.getElementById("run-shell");
        button.disabled = true;
        document.getElementById("shell-status").textContent = "正在执行";
        try {
            const body = await apiJson("/local-api/shell", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command })
            });
            shellOutput.textContent += `${shellOutput.textContent ? "\n" : ""}$ ${command}\n${body.output || "(无输出)"}\n`;
            shellOutput.scrollTop = shellOutput.scrollHeight;
            document.getElementById("shell-status").textContent = `完成 · ${body.durationMs} ms`;
            updateShellHistory(command);
        } catch (error) {
            shellOutput.textContent += `${shellOutput.textContent ? "\n" : ""}$ ${command}\n错误：${error.message}\n`;
            document.getElementById("shell-status").textContent = "执行失败";
        } finally {
            button.disabled = false;
        }
    }

    async function loadLogcat() {
        if (logcatRequestActive) {
            return;
        }
        logcatRequestActive = true;
        document.getElementById("logcat-status").textContent = "正在读取";
        const params = new URLSearchParams({
            level: document.getElementById("logcat-level").value,
            lines: document.getElementById("logcat-lines").value,
            search: document.getElementById("logcat-search").value.trim()
        });
        const packageName = document.getElementById("logcat-package").value.trim();
        if (packageName) {
            params.set("package", packageName);
        }
        try {
            const body = await apiJson(`/local-api/logcat?${params}`);
            logcatOutput.textContent = body.output || (body.running === false ? "应用当前未运行" : "暂无日志");
            logcatOutput.scrollTop = logcatOutput.scrollHeight;
            document.getElementById("logcat-status").textContent = `${body.lines} 行 · ${new Date().toLocaleTimeString("zh-CN")}`;
        } catch (error) {
            document.getElementById("logcat-status").textContent = `读取失败：${error.message}`;
        } finally {
            logcatRequestActive = false;
        }
    }

    function startLogcatTimer() {
        stopLogcatTimer();
        if (workbench.open && activeWorkbenchTab === "logcat" && document.getElementById("auto-logcat").checked) {
            logcatTimer = setInterval(loadLogcat, 2000);
        }
    }

    async function loadNetworkOverview() {
        const output = document.getElementById("network-overview");
        output.textContent = "正在读取";
        try {
            const body = await apiJson("/local-api/network/diagnostics");
            output.textContent = body.output;
        } catch (error) {
            output.textContent = `读取失败：${error.message}`;
        }
    }

    async function runDiagnostic(type) {
        const output = document.getElementById("diagnostic-output");
        const target = document.getElementById("diagnostic-target").value.trim();
        output.textContent = "正在诊断";
        setWorkbenchStatus(`正在执行 ${type}`);
        try {
            const body = await apiJson("/local-api/network/diagnostics", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type, target, port: document.getElementById("diagnostic-port").value })
            });
            output.textContent = `${body.output.trim()}\n\n耗时：${body.durationMs} ms`;
            setWorkbenchStatus(body.reachable ? "诊断完成" : "目标不可达", !body.reachable);
        } catch (error) {
            output.textContent = `诊断失败：${error.message}`;
            setWorkbenchStatus(`诊断失败：${error.message}`, true);
        }
    }

    function updateForwardDirection(direction) {
        forwardDirection = direction;
        document.querySelectorAll("[data-forward-direction]").forEach(button => {
            button.classList.toggle("active", button.dataset.forwardDirection === direction);
        });
        document.getElementById("forward-description").textContent = direction === "forward" ?
            "控制容器端口连接到 Android 端口" : "Android 端口连接到控制容器端口";
    }

    function renderForwards(forwards) {
        const list = document.getElementById("forward-list");
        list.replaceChildren();
        if (!forwards.length) {
            list.appendChild(makeElement("div", "workbench-empty", "没有 TCP 转发"));
            return;
        }
        for (const mapping of forwards) {
            const row = makeElement("div", "forward-row");
            row.setAttribute("role", "listitem");
            const remove = makeCommandButton("删除", () => removeForward(mapping));
            row.append(
                makeElement("span", "", mapping.direction === "forward" ? "正向" : "反向"),
                makeElement("span", "", String(mapping.localPort)),
                makeElement("span", "", String(mapping.remotePort)),
                remove
            );
            list.appendChild(row);
        }
    }

    async function loadForwards() {
        setWorkbenchStatus("正在读取端口转发");
        try {
            const body = await apiJson("/local-api/forwards");
            renderForwards(body.forwards);
            setWorkbenchStatus(`端口转发：${body.forwards.length} 条`);
        } catch (error) {
            setWorkbenchStatus(`读取转发失败：${error.message}`, true);
        }
    }

    async function addForward() {
        setWorkbenchStatus("正在添加端口转发");
        try {
            const body = await apiJson("/local-api/forwards", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "add",
                    direction: forwardDirection,
                    localPort: document.getElementById("forward-local-port").value,
                    remotePort: document.getElementById("forward-remote-port").value
                })
            });
            renderForwards(body.forwards);
            setWorkbenchStatus("端口转发已添加");
        } catch (error) {
            setWorkbenchStatus(`添加失败：${error.message}`, true);
        }
    }

    async function removeForward(mapping) {
        if (!window.confirm(`删除${mapping.direction === "forward" ? "正向" : "反向"}转发 tcp:${mapping.localPort} 吗？`)) {
            return;
        }
        try {
            const body = await apiJson("/local-api/forwards", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "remove", direction: mapping.direction, localPort: mapping.localPort })
            });
            renderForwards(body.forwards);
            setWorkbenchStatus("端口转发已删除");
        } catch (error) {
            setWorkbenchStatus(`删除失败：${error.message}`, true);
        }
    }

    document.getElementById("open-workbench").addEventListener("click", () => {
        if (!workbench.open) {
            workbench.showModal();
        }
        selectWorkbenchTab(activeWorkbenchTab);
    });
    document.getElementById("close-workbench").addEventListener("click", () => workbench.close());
    workbench.addEventListener("close", stopLogcatTimer);
    workbench.addEventListener("click", event => {
        if (event.target === workbench) {
            workbench.close();
        }
    });
    document.querySelectorAll("[data-workbench-tab]").forEach(button => {
        button.addEventListener("click", () => selectWorkbenchTab(button.dataset.workbenchTab));
    });
    document.getElementById("refresh-apps").addEventListener("click", loadApplications);
    document.getElementById("app-scope").addEventListener("change", () => {
        selectedPackage = "";
        applications = [];
        loadApplications();
    });
    document.getElementById("app-search").addEventListener("input", renderApplications);
    document.getElementById("shell-preset").addEventListener("change", event => {
        if (event.target.value) {
            shellCommand.value = event.target.value;
            shellCommand.focus();
        }
    });
    document.getElementById("shell-history").addEventListener("change", event => {
        if (event.target.value) {
            shellCommand.value = event.target.value;
            shellCommand.focus();
        }
    });
    document.getElementById("run-shell").addEventListener("click", runDeviceShell);
    document.getElementById("clear-shell-output").addEventListener("click", () => {
        shellOutput.textContent = "";
    });
    shellCommand.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            runDeviceShell();
        }
    });
    document.getElementById("refresh-logcat").addEventListener("click", loadLogcat);
    document.getElementById("auto-logcat").addEventListener("change", event => {
        if (event.target.checked) {
            loadLogcat();
            startLogcatTimer();
        } else {
            stopLogcatTimer();
        }
    });
    document.getElementById("clear-logcat").addEventListener("click", async () => {
        if (!window.confirm("确定清空设备当前 Logcat 缓冲区吗？")) {
            return;
        }
        try {
            await apiJson("/local-api/logcat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "clear" })
            });
            logcatOutput.textContent = "";
            document.getElementById("logcat-status").textContent = "设备日志已清空";
        } catch (error) {
            showToast(`清空日志失败：${error.message}`, true);
        }
    });
    document.getElementById("download-logcat").addEventListener("click", () => {
        const blob = new Blob([logcatOutput.textContent], { type: "text/plain;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `logcat-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    document.querySelectorAll("[data-diagnostic]").forEach(button => {
        button.addEventListener("click", () => runDiagnostic(button.dataset.diagnostic));
    });
    document.getElementById("refresh-network-overview").addEventListener("click", loadNetworkOverview);
    document.querySelectorAll("[data-forward-direction]").forEach(button => {
        button.addEventListener("click", () => updateForwardDirection(button.dataset.forwardDirection));
    });
    document.getElementById("add-forward").addEventListener("click", addForward);
    document.getElementById("refresh-forwards").addEventListener("click", loadForwards);
    renderShellHistory();

    window.addEventListener("beforeunload", () => {
        clearTimeout(reconnectTimer);
        clearInterval(resourceTimer);
        clearInterval(deviceRefreshTimer);
        stopLogcatTimer();
        if (socket) {
            socket.onclose = null;
            socket.close();
        }
    });

    syncRecording();
    refreshDevices(false);
    refreshResourceMonitor();
    resourceTimer = setInterval(refreshResourceMonitor, 2000);
    connect();
})();
