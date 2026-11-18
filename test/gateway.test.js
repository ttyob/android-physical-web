"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

let gateway;
let base;
let cookie;
const HDC_SERVER = "hdc.test:18710";
const hdcId = key => `hdc://${HDC_SERVER}/${key}`;

async function unusedPort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

before(async () => {
    const port = await unusedPort();
    const upstreamPort = await unusedPort();
    base = `http://127.0.0.1:${port}`;
    gateway = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures/adb-runtime.cjs"), path.join(__dirname, "../gateway.js")], {
        env: { ...process.env, GATEWAY_PORT: String(port), UPSTREAM_PORT: String(upstreamPort), ADB_PATH: "/test/fake-adb", ANDROID_ADB_SERVER_PORT: "5038", EMULATOR_ADB_SERVER_PORT: "0", ADB_ENDPOINT: "",
            HDC_ENABLED: "true", HDC_TEST_SERVER: HDC_SERVER,
            IOS_ENABLED: "true", IOS_TOOLS_DIR: "/test/ios",
            HDC_PATH: path.join(__dirname, "../vendor/hdc/linux-x64/hdc") },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let logs = "";
    gateway.stdout.on("data", chunk => { logs += chunk; });
    gateway.stderr.on("data", chunk => { logs += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (gateway.exitCode !== null) {
            throw new Error(`gateway failed: ${logs}`);
        }
        try {
            const response = await fetch(base);
            if (response.ok) {
                cookie = response.headers.get("set-cookie").split(";")[0];
                await response.text();
                return;
            }
            await response.text();
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`gateway startup timed out: ${logs}`);
});

after(async () => {
    if (gateway && gateway.exitCode === null) {
        const exited = once(gateway, "exit");
        gateway.kill("SIGTERM");
        const timeout = setTimeout(() => gateway.kill("SIGKILL"), 1000);
        await exited;
        clearTimeout(timeout);
    }
});

function request(route, body) {
    return fetch(`${base}${route}`, { headers: { Cookie: cookie, "Content-Type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
}

test("the device list includes USB phones, online emulators and offline emulators", async () => {
    const response = await request("/local-api/devices");
    assert.equal(response.status, 200);
    const { devices } = await response.json();
    assert.equal(devices.find(item => item.serial === "TEST-PHONE").type, "usb");
    assert.equal(devices.find(item => item.serial === "emulator-5554").type, "emulator");
    assert.equal(devices.find(item => item.serial === "emulator-5556").state, "offline");
});

test("an emulator can be selected and concurrent phone/emulator API requests stay isolated", async () => {
    const selected = await request("/local-api/devices", { action: "select", serial: "emulator-5554" });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).selectedDevice, "emulator-5554");
    const config = await request("/local-api/device/config?device=emulator-5554");
    assert.equal((await config.json()).deviceId, "emulator-5554");
    const responses = await Promise.all(["TEST-PHONE", "emulator-5554"].map(async serial => {
        const response = await request(`/local-api/shell?device=${serial}`, { command: "echo device" });
        assert.equal(response.status, 200);
        return (await response.json()).output.trim();
    }));
    assert.deepEqual(responses, ["TEST-PHONE", "emulator-5554"]);
});

test("a TCP emulator can connect without mDNS discovery and invalid addresses are rejected", async () => {
    const response = await request("/local-api/devices", { action: "connect", address: "localhost:5557" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.selectedDevice, "127.0.0.1:5557");
    assert.equal(result.devices.find(item => item.serial === "127.0.0.1:5557").type, "emulator");
    const invalid = await request("/local-api/devices", { action: "connect", address: "--help" });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /ADB 地址/);
});

test("offline or missing emulators cannot execute device commands", async () => {
    for (const serial of ["emulator-5556", "emulator-9998"]) {
        const response = await request(`/local-api/device/config?device=${serial}`);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /未连接|未授权|尚未授权/);
    }
});

test("device APIs still require a valid page token", async () => {
    const response = await fetch(`${base}/local-api/device/config?device=emulator-5554`);
    assert.equal(response.status, 401);
    await response.json();
});

function upgrade(serial) {
    return new Promise((resolve, reject) => {
        const request = http.request(`${base}/?action=stream&udid=${encodeURIComponent(serial)}`, {
            headers: { Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" }
        });
        request.setTimeout(3000, () => request.destroy(new Error("WebSocket upgrade timed out")));
        request.on("error", reject);
        request.on("upgrade", (response, socket) => {
            resolve({ status: response.statusCode, serial: response.headers["x-test-device"] });
            socket.destroy();
        });
        request.on("response", response => {
            response.resume();
            resolve({ status: response.statusCode });
        });
        request.end();
    });
}

test("emulator and phone stream upgrades reach upstream, while offline emulators are rejected", async () => {
    for (const serial of ["TEST-PHONE", "emulator-5554", "127.0.0.1:5557"]) {
        assert.deepEqual(await upgrade(serial), { status: 101, serial });
    }
    assert.equal((await upgrade("emulator-5556")).status, 409);
});

test("HDC devices appear beside ADB devices with distinct identities even when their raw serials match", async () => {
    const response = await request(`/local-api/devices?hdcServer=${encodeURIComponent(HDC_SERVER)}`);
    const result = await response.json();
    assert.ok(result.devices.some(device => device.serial === "TEST-PHONE" && device.protocol === "adb"));
    const harmony = result.devices.find(device => device.serial === hdcId("TEST-PHONE"));
    assert.equal(harmony.protocol, "hdc");
    assert.equal(harmony.type, "harmony");
    assert.equal(harmony.model, "Test Harmony");
    assert.equal(result.providers.hdc.error, null);
    assert.equal(result.providers.hdc.server, HDC_SERVER);
    assert.equal(result.providers.hdc.configured, true);
    assert.equal("target" in result.providers.hdc, false);
});

test("a Windows-hosted Harmony emulator uses the remote server while keeping its loopback target", async () => {
    const serial = hdcId("127.0.0.1:5555");
    const selected = await request("/local-api/devices", { action: "select", serial });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).selectedDevice, serial);
    const response = await request(`/local-api/shell?device=${encodeURIComponent(serial)}`, { command: "echo transport" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output.trim(), serial);
});

test("HDC selection and concurrent mixed device commands use the correct transport", async () => {
    const selected = await request("/local-api/devices", { action: "select", serial: hdcId("TEST-PHONE") });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).selectedDevice, hdcId("TEST-PHONE"));
    const values = await Promise.all(["TEST-PHONE", hdcId("TEST-PHONE"), "emulator-5554"].map(async serial => {
        const response = await request(`/local-api/shell?device=${encodeURIComponent(serial)}`, { command: "echo transport" });
        assert.equal(response.status, 200);
        return (await response.json()).output.trim();
    }));
    assert.deepEqual(values, ["TEST-PHONE", hdcId("TEST-PHONE"), "emulator-5554"]);
});

test("HDC network connections validate their address and enter the shared workspace", async () => {
    const response = await request("/local-api/devices", { action: "connect", protocol: "hdc", hdcServer: HDC_SERVER, address: "192.168.1.20:10178" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selectedDevice, hdcId("192.168.1.20:10178"));
    const invalid = await request("/local-api/devices", { action: "connect", protocol: "hdc", hdcServer: HDC_SERVER, address: "--help" });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /HDC 地址/);
});

const hdcQuery = "device=" + encodeURIComponent(hdcId("TEST-PHONE"));

test("HDC capabilities expose its screenshot stream and input without leaking Android-only endpoints into ADB", async () => {
    const response = await request(`/local-api/device/config?${hdcQuery}`);
    const config = await response.json();
    assert.equal(config.protocol, "hdc");
    assert.equal(config.capabilities.stream, true);
    assert.equal(config.capabilities.input, true);
    assert.equal(config.capabilities.streamMode, "jpeg");
    assert.equal(config.fileRoot, "/data/local/tmp");
    const androidOnly = await request(`/local-api/device/screenshot?${hdcQuery}`);
    assert.equal(androidOnly.status, 501);
    await androidOnly.json();
    assert.equal((await upgrade(hdcId("TEST-PHONE"))).status, 501);
});

test("HDC screenshot frames and native-coordinate input use the device-specific API", async () => {
    const frame = await request(`/local-api/live?${hdcQuery}&width=540`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/jpeg");
    assert.equal(frame.headers.get("x-device-width"), "1280");
    assert.equal(frame.headers.get("x-device-height"), "2832");
    assert.equal(await frame.text(), "hdc-file");
    const input = await request(`/local-api/input?${hdcQuery}`, { action: "click", x: 640, y: 1416 });
    assert.equal(input.status, 200);
    assert.equal((await input.json()).ok, true);
    const text = await request(`/local-api/input?${hdcQuery}`, { action: "text", x: 640, y: 1416, text: "hello" });
    assert.equal(text.status, 200);
    assert.equal((await text.json()).ok, true);
});

test("HDC file operations enforce the remote boundary and transfer bytes via HDC", async () => {
    const list = await request(`/local-api/files?${hdcQuery}`);
    assert.equal(list.status, 200);
    const directory = await list.json();
    assert.equal(directory.path, "/data/local/tmp");
    assert.equal(directory.files[0].name, "example.txt");
    const invalid = await request(`/local-api/files?${hdcQuery}&path=${encodeURIComponent('/data/local/tmp/../../etc')}`);
    assert.equal(invalid.status, 400);
    await invalid.json();
    const download = await request(`/local-api/files/download?${hdcQuery}&path=${encodeURIComponent('/data/local/tmp/example.txt')}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "hdc-file");
    const upload = await fetch(`${base}/local-api/files/upload?${hdcQuery}&name=test.txt`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body: "file contents"
    });
    assert.equal(upload.status, 200);
    assert.equal((await upload.json()).size, 13);
});

test("HDC applications and bounded HiLog queries work through device-specific APIs", async () => {
    const apps = await request(`/local-api/apps?${hdcQuery}`);
    assert.deepEqual((await apps.json()).apps.map(app => app.packageName), ["com.example.harmony", "com.example.tools"]);
    const install = await fetch(`${base}/local-api/apps/install?${hdcQuery}&name=example.hap`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body: "fake hap fixture"
    });
    assert.equal(install.status, 200);
    assert.equal((await install.json()).ok, true);
    const invalid = await fetch(`${base}/local-api/apps/install?${hdcQuery}&name=example.apk`, {
        method: "POST", headers: { Cookie: cookie }, body: "fake apk fixture"
    });
    assert.equal(invalid.status, 400);
    await invalid.json();
    const logs = await request(`/local-api/logs?${hdcQuery}&lines=20&search=Harmony`);
    assert.equal(logs.status, 200);
    assert.deepEqual(await logs.json(), { output: "I test Harmony message", lines: 1 });
});

test("offline HDC devices and unauthenticated callers cannot execute commands", async () => {
    const offline = await request("/local-api/shell?device=" + encodeURIComponent(hdcId("HARMONY-OFFLINE")), { command: "echo test" });
    assert.equal(offline.status, 400);
    await offline.json();
    const anonymous = await fetch(`${base}/local-api/shell?${hdcQuery}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo test" })
    });
    assert.equal(anonymous.status, 401);
    await anonymous.json();
});


test("default discovery has no HDC service and does not reuse a previously entered address", async () => {
    const response = await request("/local-api/devices");
    const result = await response.json();
    assert.equal(result.providers.hdc.server, null);
    assert.equal(result.providers.hdc.configured, false);
    assert.equal(result.providers.hdc.error, null);
    assert.ok(!result.devices.some(device => device.protocol === "hdc"));
    assert.ok(result.devices.some(device => device.protocol === "adb"));
    const missing = await request("/local-api/devices", { action: "connect", protocol: "hdc", address: "127.0.0.1:5555" });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /先填写 HDC 服务地址/);
    const invalid = await request("/local-api/devices?hdcServer=--help");
    assert.equal(invalid.status, 400);
});

test("two manually chosen HDC servers keep identical target keys isolated", async () => {
    const otherServer = "second-hdc.test:18710";
    const ids = [hdcId("TEST-PHONE"), `hdc://${otherServer}/TEST-PHONE`];
    const values = await Promise.all(ids.map(async serial => {
        const response = await request(`/local-api/shell?device=${encodeURIComponent(serial)}`, { command: "echo server" });
        assert.equal(response.status, 200);
        return (await response.json()).output.trim();
    }));
    assert.deepEqual(values, ids);
});

const IOS_PHONE = "00008110-000A001122334455";
const IOS_UNTRUSTED = "00008110-000B001122334455";
const IOS_MODERN = "00008120-000C001122334455";
const iosId = (udid = IOS_PHONE, server = "local") => `ios://${server}/${udid}`;
const iosQuery = udid => "device=" + encodeURIComponent(iosId(udid));

test("iPhone control is opt-in, requires the page token and cannot operate without a control session", async () => {
    const state = await request(`/local-api/device/control?${iosQuery()}`);
    assert.equal(state.status, 200);
    const data = await state.json();
    assert.equal(data.connected, false);
    assert.equal(data.backend, "devicekit");
    assert.deepEqual(data.installed, []);
    assert.match(data.packageUrl, /^\/ios-tools\/.*-unsigned\.ipa$/);
    for (const suffix of ["", "/frame", "/stream"]) {
        const anonymous = await fetch(`${base}/local-api/device/control${suffix}?${iosQuery()}`);
        assert.equal(anonymous.status, 401);
        await anonymous.json();
    }
    for (const suffix of ["/frame", "/stream"]) {
        const result = await request(`/local-api/device/control${suffix}?${iosQuery()}`);
        assert.equal(result.status, 400);
        assert.match((await result.json()).error, /先安装/);
    }
    const tap = await request(`/local-api/device/control?${iosQuery()}`, { action: "tap", x: 1, y: 2 });
    assert.equal(tap.status, 400);
    assert.match((await tap.json()).error, /先安装/);
    const disconnect = await request(`/local-api/device/control?${iosQuery()}`, { action: "disconnect" });
    assert.equal((await disconnect.json()).connected, false);
    const harmony = await request(`/local-api/device/control?${hdcQuery}`);
    assert.equal(harmony.status, 501);
    await harmony.json();
});

test("iPhone discovery coexists with Android/HDC and exposes untrusted phones without pairing automatically", async () => {
    const response = await request(`/local-api/devices?hdcServer=${encodeURIComponent(HDC_SERVER)}`);
    const result = await response.json();
    assert.equal(result.providers.ios.available, true);
    assert.equal(result.providers.ios.server, null);
    assert.equal(result.providers.ios.error, null);
    assert.equal(result.devices.find(device => device.serial === iosId()).state, "device");
    assert.equal(result.devices.find(device => device.serial === iosId(IOS_UNTRUSTED)).state, "unauthorized");
    assert.ok(result.devices.some(device => device.protocol === "adb"));
    assert.ok(result.devices.some(device => device.protocol === "hdc"));
    const untrusted = await request(`/local-api/apps?${iosQuery(IOS_UNTRUSTED)}`);
    assert.equal(untrusted.status, 400);
    assert.match((await untrusted.json()).error, /信任/);
});

test("iPhone config uses its own adapter and Android-only APIs/streaming cannot fall through to ADB", async () => {
    const responses = await Promise.all([
        request(`/local-api/device/config?${iosQuery()}`),
        request(`/local-api/device/config?device=${encodeURIComponent(hdcId("TEST-PHONE"))}`),
        request("/local-api/device/config?device=TEST-PHONE")
    ]);
    const configs = await Promise.all(responses.map(response => response.json()));
    assert.equal(configs[0].protocol, "ios");
    assert.equal(configs[0].info.serialNumber, "TEST-IPHONE");
    assert.equal(configs[0].capabilities.shell, false);
    assert.equal(configs[1].protocol, "hdc");
    assert.equal(configs[2].deviceId, "TEST-PHONE");
    for (const route of ["/local-api/shell", "/local-api/files", "/local-api/device/resources"]) {
        const response = await request(`${route}?${iosQuery()}`);
        assert.equal(response.status, 501);
        await response.json();
    }
    assert.equal((await upgrade(iosId())).status, 501);
    const anonymous = await fetch(`${base}/local-api/device/config?${iosQuery()}`);
    assert.equal(anonymous.status, 401);
    await anonymous.json();
});

test("iPhone pairing requires an explicit action and enables the selected phone", async () => {
    const response = await request("/local-api/devices", { action: "pair", protocol: "ios", serial: iosId(IOS_UNTRUSTED) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.selectedDevice, iosId(IOS_UNTRUSTED));
    assert.equal(result.devices.find(device => device.serial === result.selectedDevice).state, "device");
    const config = await request(`/local-api/device/config?${iosQuery(IOS_UNTRUSTED)}`);
    assert.equal(config.status, 200);
    await config.json();
    const missing = await request(`/local-api/device/config?${iosQuery("00008110-000D001122334455")}`);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /未连接/);
});

test("manually entered remote usbmuxd services isolate identical UDIDs and never become discovery defaults", async () => {
    const servers = ["ios-one.test:27015", "ios-two.test:27015"];
    const names = await Promise.all(servers.map(async server => {
        const discovery = await request(`/local-api/devices?iosServer=${server}`);
        const list = await discovery.json();
        assert.equal(list.providers.ios.server, server);
        assert.ok(list.devices.some(device => device.serial === iosId(IOS_PHONE, server)));
        const config = await request(`/local-api/device/config?device=${encodeURIComponent(iosId(IOS_PHONE, server))}`);
        assert.equal(config.status, 200);
        return (await config.json()).info.deviceName;
    }));
    assert.deepEqual(names, servers.map(server => `iPhone ${server}`));
    const local = await request("/local-api/devices");
    const result = await local.json();
    assert.equal(result.providers.ios.server, null);
    assert.ok(result.devices.filter(device => device.protocol === "ios").every(device => device.serial.startsWith("ios://local/")));
    const down = await request("/local-api/devices?iosServer=ios-down.test:27015");
    const failed = await down.json();
    assert.match(failed.providers.ios.error, /unavailable/);
    assert.ok(failed.devices.some(device => device.protocol === "adb"));
    const invalid = await request("/local-api/devices?iosServer=--help");
    assert.equal(invalid.status, 400);
    await invalid.json();
});

test("iPhone user applications support IPA install and scoped uninstall while rejecting other package formats", async () => {
    const response = await request(`/local-api/apps?${iosQuery()}`);
    assert.deepEqual((await response.json()).apps, [{ packageName: "com.example.iphone", name: "Test iOS App", version: "1.0" }]);
    const install = await fetch(`${base}/local-api/apps/install?${iosQuery()}&name=example.ipa`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body: "fake signed ipa"
    });
    assert.equal(install.status, 200);
    assert.equal((await install.json()).size, 15);
    const invalid = await fetch(`${base}/local-api/apps/install?${iosQuery()}&name=example.apk`, {
        method: "POST", headers: { Cookie: cookie }, body: "fake apk"
    });
    assert.equal(invalid.status, 400);
    await invalid.json();
    const uninstall = await request(`/local-api/apps?${iosQuery()}`, { action: "uninstall", packageName: "com.example.iphone" });
    assert.equal(uninstall.status, 200);
    assert.equal((await uninstall.json()).ok, true);
    const absent = await request(`/local-api/apps?${iosQuery()}`, { action: "uninstall", packageName: "com.apple.Preferences" });
    assert.equal(absent.status, 400);
    await absent.json();
});

test("iPhone screenshot capabilities reflect iOS version and return image bytes only when supported", async () => {
    const config = await request(`/local-api/device/config?${iosQuery(IOS_MODERN)}`);
    assert.equal((await config.json()).capabilities.screenshot.supported, false);
    const modern = await request(`/local-api/device/screenshot?${iosQuery(IOS_MODERN)}`);
    assert.equal(modern.status, 501);
    await modern.json();
    const legacy = await request(`/local-api/device/screenshot?${iosQuery()}`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await legacy.arrayBuffer()).toString("hex"), "89504e470d0a1a0a");
});

test("iPhone logs are bounded and filtered and request cancellation releases the capture", async () => {
    const response = await request(`/local-api/logs?${iosQuery()}&durationMs=1000&lines=20&search=iPhone`);
    const logs = await response.json();
    assert.equal(response.status, 200);
    assert.equal(logs.lines, 1);
    assert.match(logs.output, new RegExp(IOS_PHONE));
    assert.equal(logs.durationMs, 1000);
    const invalid = await request(`/local-api/logs?${iosQuery()}&durationMs=9999999`);
    assert.equal(invalid.status, 400);
    await invalid.json();
    const controller = new AbortController();
    const capture = fetch(`${base}/local-api/logs?${iosQuery()}&durationMs=10000`, { headers: { Cookie: cookie }, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 60));
    controller.abort();
    await assert.rejects(capture, error => error.name === "AbortError");
    await new Promise(resolve => setTimeout(resolve, 60));
    const next = await request(`/local-api/logs?${iosQuery()}&durationMs=1000`);
    assert.equal(next.status, 200);
    await next.json();
});
