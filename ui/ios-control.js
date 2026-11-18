(() => {
    "use strict";

    window.createIphoneControl = ({ id, api, send, status, onState = () => {} }) => {
        const byId = name => document.getElementById(name);
        const image = byId("control-image"), canvas = byId("control-canvas"), frozenCanvas = byId("control-frozen-canvas");
        const workspace = document.querySelector(".ios-workspace");
        const formatSelect = byId("control-format");
        let ready = false, active = true, connected = false, attached = false, closed = false;
        let streamFormats = [], width = 0, height = 0, epoch = 0, sessionEpoch = 0;
        let frameTimer, imageSizeTimer, frameAbort, blobUrl, pointer, watchdog;
        let pending = 0, work = Promise.resolve();
        let videoKind = "", hasFrame = false, pinned = false;
        let layoutWidth = 0, layoutHeight = 0, hasFrameSize = false;
        const h264 = window.createIosH264Player({ canvas, onFrame({ width, height }) {
            clearTimeout(frameTimer);
            frameTimer = setTimeout(() => watchdog?.(), 6000);
            frameReady("H.264", width, height);
        } });

        function updateScreenSize(width, height, fromFrame = false) {
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || (!fromFrame && hasFrameSize)) { return; }
            hasFrameSize ||= fromFrame;
            if (layoutWidth === width && layoutHeight === height) { return; }
            layoutWidth = width; layoutHeight = height;
            workspace.style.setProperty("--screen-ratio", width / height);
            if (parent !== window) {
                parent.postMessage({ type: "physical-web:device-telemetry", device: id, screenWidth: width, screenHeight: height }, location.origin);
            }
        }

        function url(route) {
            const value = new URL(`/local-api/device/control${route}`, location.origin);
            value.searchParams.set("device", id);
            return value.pathname + value.search;
        }

        function note(message, error = false) {
            const node = byId("control-note");
            node.textContent = message; node.title = message;
            node.classList.toggle("error", error);
        }

        function render() {
            const busy = pending > 0;
            byId("connect-control").disabled = !ready || busy || connected;
            byId("reconnect-control").disabled = !ready || busy;
            byId("disconnect-control").disabled = busy || !connected;
            byId("check-control").disabled = !ready || busy;
            byId("connect-label").textContent = connected ? "重连" : "连接";
            byId("control-placeholder").hidden = hasFrame;
            byId("placeholder-message").textContent = connected ? "正在读取画面" : "iPhone 画面";
            byId("control-state").textContent = connected ? (pinned ? "锁屏输入" : videoKind || "连接中") : "画面未连接";
            byId("control-state").dataset.connected = String(connected);
            for (const name of ["control-wake", "control-home", "resize-control", "send-control-text"]) {
                byId(name).disabled = !ready || !connected || busy;
            }
            const pinButton = byId("control-pin-mode");
            pinButton.disabled = !ready || !connected || !hasFrame || busy;
            pinButton.setAttribute("aria-pressed", String(pinned));
            pinButton.setAttribute("aria-label", pinned ? "退出锁屏输入，恢复实时画面" : "进入锁屏输入模式");
            pinButton.title = pinned ? "退出锁屏输入，恢复实时画面" : "锁屏输入：固定当前密码键盘，点击仍发送到手机";
            byId("control-pin-label").textContent = pinned ? "恢复" : "密码";
            byId("control-pinned-notice").hidden = !pinned;
            if (pinned) { byId("send-control-text").disabled = true; }
            onState({ connected });
        }

        function stopView({ preservePinned = false } = {}) {
            epoch++; hasFrame = false; watchdog = null; pointer = null;
            if (!preservePinned) {
                pinned = false; frozenCanvas.hidden = true; frozenCanvas.width = 0; frozenCanvas.height = 0;
            }
            clearTimeout(frameTimer); clearInterval(imageSizeTimer); frameAbort?.abort(); frameAbort = null;
            h264.stop(); canvas.hidden = true; canvas.width = 0; canvas.height = 0;
            image.onload = null; image.onerror = null; image.removeAttribute("src"); image.hidden = true;
            if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
        }

        function frameReady(kind, width = image.naturalWidth, height = image.naturalHeight) {
            updateScreenSize(width, height, true);
            hasFrame = true; videoKind = kind;
            note("已连接 · 点击、长按或拖动操作"); render();
        }

        async function pollFrame(token) {
            if (token !== epoch || closed || !active || !connected || document.hidden) { return; }
            frameAbort = new AbortController();
            try {
                const response = await fetch(url("/frame"), { cache: "no-store", signal: frameAbort.signal });
                if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    throw Object.assign(new Error(body.error || "无法读取手机画面"), { code: body.code });
                }
                const blob = await response.blob();
                if (token !== epoch) { return; }
                const previous = blobUrl;
                blobUrl = URL.createObjectURL(blob);
                image.onload = () => { if (token === epoch) { frameReady("逐帧"); } };
                image.src = blobUrl; image.hidden = false;
                if (previous) { URL.revokeObjectURL(previous); }
                frameTimer = setTimeout(() => pollFrame(token), 500);
            } catch (error) {
                if (error.name === "AbortError" || token !== epoch) { return; }
                note(error.message, true);
                // Capture can be unavailable while locked. Keep the session so
                // waking or unlocking the phone can recover without reconnecting.
                frameTimer = setTimeout(() => pollFrame(token), 1500);
            }
        }

        function startMjpeg(token) {
            let fallbackStarted = false;
            function fallback() {
                if (token !== epoch || fallbackStarted) { return; }
                fallbackStarted = true; clearTimeout(frameTimer); clearInterval(imageSizeTimer);
                image.onload = null; image.onerror = null; image.removeAttribute("src");
                pollFrame(token);
            }
            image.onload = () => { if (token === epoch) { clearTimeout(frameTimer); frameReady("MJPEG"); } };
            image.onerror = fallback;
            image.hidden = false;
            image.src = `${url("/stream")}&format=mjpeg&t=${Date.now()}`;
            // Multipart images can change dimensions without another load event.
            imageSizeTimer = setInterval(() => {
                if (token === epoch) { updateScreenSize(image.naturalWidth, image.naturalHeight, true); }
            }, 250);
            frameTimer = setTimeout(() => { if (!image.naturalWidth) { fallback(); } }, 8000);
        }

        function startView() {
            stopView(); render();
            if (closed || !ready || !active || !connected || document.hidden) { return; }
            const token = epoch, format = formatSelect.value;
            if (format === "frame") { pollFrame(token); return; }
            if (format === "auto" && streamFormats.includes("h264") && typeof VideoDecoder === "function") {
                canvas.hidden = false;
                let switched = false;
                function fallback() {
                    if (token !== epoch || switched) { return; }
                    switched = true; clearTimeout(frameTimer); watchdog = null;
                    h264.stop(); canvas.hidden = true; hasFrame = false; render();
                    note("正在切换视频显示方式"); startMjpeg(token);
                }
                watchdog = fallback;
                frameTimer = setTimeout(fallback, 8000);
                h264.start(`${url("/stream")}&format=h264`).catch(fallback);
            } else { startMjpeg(token); }
        }

        function pinView() {
            if (pinned) { startView(); note("正在恢复实时画面"); return; }
            if (!ready || !connected || !hasFrame || pending) { return; }
            const source = canvas.hidden ? image : canvas;
            const w = source === image ? image.naturalWidth : canvas.width;
            const h = source === image ? image.naturalHeight : canvas.height;
            if (!w || !h) { return; }
            const context = frozenCanvas.getContext("2d", { alpha: false });
            if (!context) { note("浏览器无法固定当前画面", true); return; }
            frozenCanvas.width = w; frozenCanvas.height = h;
            context.drawImage(source, 0, 0, w, h);
            pinned = true;
            stopView({ preservePinned: true });
            frozenCanvas.hidden = false; hasFrame = true;
            note("锁屏输入 · 画面已固定，点击仍发送到手机"); render();
        }

        function applyState(state) {
            const next = Boolean(state.connected);
            if (next !== connected) { sessionEpoch++; }
            connected = next;
            width = state.width || 0; height = state.height || 0;
            updateScreenSize(width, height);
            streamFormats = state.streamFormats || [];
            if (!connected) { stopView(); }
            render();
        }

        function run(callback) {
            if (closed) { return Promise.resolve(); }
            pending++; render();
            const next = work.then(async () => {
                if (closed) { return; }
                try { await callback(); }
                catch (error) { note(error.message, true); status(error.message, true); }
            });
            work = next.finally(() => { pending--; render(); });
            return work;
        }

        async function inspect() {
            const state = await api("/local-api/device/control");
            const installed = state.installed || [];
            byId("control-component").textContent = installed.length ?
                "已安装 DeviceKit。连接时会检查手机上的控制服务是否就绪。" :
                "尚未发现 DeviceKit。签名安装后点击“检查安装状态”。";
            // Opening a page inspects the component; the user starts its viewer.
            applyState({ ...state, connected: attached && state.connected });
            if (!connected) { note(installed.length ? "点击“连接画面”开始操作" : "请在设置中查看首次连接帮助"); }
        }

        async function command(body) {
            if (!ready || !connected) { throw new Error("请先连接画面"); }
            const result = await send("/local-api/device/control", body);
            applyState(result);
            if (result.message) { note(result.message); status(result.message); }
        }

        async function connect() {
            note("正在连接 iPhone");
            const state = await send("/local-api/device/control", { action: "connect" });
            attached = true; sessionEpoch++;
            applyState(state); byId("control-setup").open = false;
            startView(); note("已连接，正在读取画面");
        }
        byId("check-control").addEventListener("click", () => run(inspect));
        byId("connect-control").addEventListener("click", () => run(connect));
        byId("reconnect-control").addEventListener("click", () => run(connect));
        byId("disconnect-control").addEventListener("click", () => run(async () => {
            attached = false; stopView();
            applyState(await send("/local-api/device/control", { action: "disconnect" }));
            note("画面已断开");
        }));
        byId("control-home").addEventListener("click", () => run(async () => { if (pinned) { startView(); } await command({ action: "home" }); }));
        byId("control-wake").addEventListener("click", () => run(async () => { if (pinned) { startView(); } await command({ action: "wake" }); }));
        byId("control-pin-mode").addEventListener("click", pinView);
        byId("resize-control").addEventListener("click", () => run(async () => { await command({ action: "resize" }); startView(); }));
        formatSelect.addEventListener("change", startView);
        byId("send-control-text").addEventListener("click", () => run(async () => {
            await command({ action: "text", text: byId("control-text").value });
            byId("control-text").value = ""; status("文字已发送");
        }));
        byId("control-text").addEventListener("keydown", event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault(); byId("send-control-text").click();
            }
        });

        function geometry(surface) {
            const nw = surface === image ? image.naturalWidth : surface.width;
            const nh = surface === image ? image.naturalHeight : surface.height;
            if (!nw || !nh || !width || !height) { return null; }
            const rect = surface.getBoundingClientRect();
            const scale = Math.min(rect.width / nw, rect.height / nh);
            return { left: rect.left + (rect.width - nw * scale) / 2, top: rect.top + (rect.height - nh * scale) / 2,
                width: nw * scale, height: nh * scale, deviceWidth: width, deviceHeight: height };
        }
        function position(event, bounds, clamp = false) {
            if (!bounds?.width || !bounds.height) { return null; }
            const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
            if (!clamp && (x < 0 || y < 0 || x > 1 || y > 1)) { return null; }
            return { x: Math.max(0, Math.min(bounds.deviceWidth - 1, x * bounds.deviceWidth)),
                y: Math.max(0, Math.min(bounds.deviceHeight - 1, y * bounds.deviceHeight)) };
        }
        for (const surface of [image, canvas, frozenCanvas]) {
            surface.addEventListener("pointerdown", event => {
                if (!ready || !connected || closed || pending >= 8 || event.button !== 0 || pointer || event.isPrimary === false) { return; }
                const bounds = geometry(surface), point = position(event, bounds);
                if (!point) { return; }
                event.preventDefault(); surface.setPointerCapture(event.pointerId);
                // Keep the same transform for the whole gesture, even if video
                // dimensions or the browser viewport change before pointerup.
                pointer = { ...point, bounds, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
                    started: performance.now(), session: sessionEpoch };
            });
            surface.addEventListener("pointerup", event => {
                if (!pointer || pointer.pointerId !== event.pointerId) { return; }
                const start = pointer; pointer = null;
                if (surface.hasPointerCapture(event.pointerId)) { surface.releasePointerCapture(event.pointerId); }
                const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
                const end = position(event, start.bounds, distance > 5);
                if (!end) { return; }
                const body = distance > 5 ? { action: "swipe", fromX: start.x, fromY: start.y, toX: end.x, toY: end.y } :
                    { action: performance.now() - start.started > 550 ? "hold" : "tap", x: start.x, y: start.y };
                run(async () => { if (connected && start.session === sessionEpoch) { await command(body); } });
            });
            surface.addEventListener("pointercancel", () => { pointer = null; });
            surface.addEventListener("lostpointercapture", () => { pointer = null; });
            surface.addEventListener("contextmenu", event => event.preventDefault());
        }
        document.addEventListener("visibilitychange", () => { if (document.hidden) { stopView(); render(); } else { startView(); } });
        render();
        return {
            setReady(value) {
                const changed = ready !== value; ready = value;
                if (!value) { connected = false; attached = false; sessionEpoch++; stopView(); }
                else if (changed && active) { run(inspect); }
                render();
            },
            setActive(value) { active = value; if (value) { startView(); } else { stopView(); } },
            close() { closed = true; sessionEpoch++; stopView(); }
        };
    };
})();
