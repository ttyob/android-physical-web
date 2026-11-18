"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const { createIosAdapter, parseIosDevice, normalizeIosServer, parsePlist, screenshotCapability } = require("../ios");

const udid = "00008110-000A001122334455";
const localId = `ios://local/${udid}`;
const xml = value => `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${value}</plist>`;
const info = xml("<dict><key>DeviceName</key><string>My iPhone &amp; iPad</string><key>ProductType</key><string>iPhone14,5</string><key>ProductVersion</key><string>16.7</string></dict>");

function fixture(reply, extra = {}) {
    const calls = [];
    const adapter = createIosAdapter({
        toolsDir: "/test/ios", existsSync: () => true,
        execute(filename, args, options, callback) {
            const call = { tool: path.basename(filename), args, env: options.env };
            calls.push(call);
            try { const output = reply(call); queueMicrotask(() => callback(null, output || "", "")); }
            catch (error) { queueMicrotask(() => callback(error, "", "")); }
        }, ...extra
    });
    return { adapter, calls };
}

test("iOS IDs and service addresses isolate servers and reject command fragments", () => {
    assert.deepEqual(parseIosDevice(localId), { server: "", udid });
    assert.deepEqual(parseIosDevice(`ios://ios-one.test:27015/${udid}`), { server: "ios-one.test:27015", udid });
    assert.equal(normalizeIosServer(" [::1]:27015 "), "[::1]:27015");
    for (const address of ["--help", "host:0", "host:65536", "host:12;id", "host\n:12", "[::z]:12"]) {
        assert.throws(() => normalizeIosServer(address));
    }
    for (const id of [udid, "ios://local/--help", `ios://local/${udid}/shell`, `ios://local/${udid}\n`]) {
        assert.throws(() => parseIosDevice(id));
    }
});

test("plist decoding handles real tool output without resolving external entities or prototype keys", () => {
    const result = parsePlist(info);
    assert.equal(result.DeviceName, "My iPhone & iPad");
    assert.equal(Object.getPrototypeOf(result), null);
    const values = parsePlist(xml("<array><true/><false/><integer>42</integer><string/><dict><key>__proto__</key><string>value</string></dict></array>"));
    assert.deepEqual(values.slice(0, 4), [true, false, 42, ""]);
    assert.equal(values[4].__proto__, "value");
    assert.equal({}.polluted, undefined);
    assert.throws(() => parsePlist(xml("<dict><key>broken</key></dict>")), /plist/);
    assert.throws(() => parsePlist("ERROR: service unavailable"), /plist/);
});

test("iOS discovery reports untrusted devices without pairing them implicitly", async () => {
    const { adapter, calls } = fixture(({ tool }) => {
        if (tool === "idevice_id") { return `${udid}\n`; }
        if (tool === "idevicepair") { throw new Error("Device is not paired. Please pair."); }
        throw new Error("untrusted device must not reach a debugging service");
    });
    const devices = await adapter.listDevices();
    assert.equal(devices[0].state, "unauthorized");
    assert.match(devices[0].error, /信任/);
    assert.ok(calls.every(call => !call.args.includes("pair")));
    assert.ok(calls.every(call => call.env.USBMUXD_SOCKET_ADDRESS === "UNIX:/run/usbmuxd"));
});

test("manual pairing refreshes trust and cached device information", async () => {
    let paired = false;
    const { adapter, calls } = fixture(({ tool, args }) => {
        if (tool === "idevice_id") { return udid; }
        if (tool === "idevicepair") {
            if (args.includes("pair")) { paired = true; }
            if (!paired) { throw new Error("not paired"); }
            return "SUCCESS";
        }
        return info;
    });
    assert.equal((await adapter.listDevices())[0].state, "unauthorized");
    await adapter.pair(localId);
    const device = (await adapter.listDevices())[0];
    assert.equal(device.state, "device");
    assert.equal(device.name, "My iPhone & iPad");
    await adapter.listDevices();
    assert.equal(calls.filter(call => call.tool === "ideviceinfo").length, 1);
    assert.ok(calls.filter(call => call.tool !== "idevice_id").every(call => call.args[0] === "-u" && call.args[1] === udid));
});

test("unavailable iOS services stay within their provider and disabled tools execute no commands", async () => {
    const { adapter } = fixture(() => { throw new Error("connection refused"); }, { server: "ios-down.test:27015" });
    assert.deepEqual(await adapter.listDevices(), []);
    assert.match(adapter.status().error, /ios-down.test:27015.*connection refused/);
    for (const extra of [{ enabled: false }, { existsSync: () => false }]) {
        const { adapter: disabled, calls } = fixture(() => { throw new Error("must not execute"); }, extra);
        assert.deepEqual(await disabled.listDevices(), []);
        assert.equal(calls.length, 0);
    }
});

test("a failed device service is not offered as an untrusted phone and log errors do not suggest screenshot setup", async () => {
    const { adapter } = fixture(({ tool }) => {
        if (tool === "idevice_id") { return udid; }
        throw new Error("device disconnected");
    });
    assert.equal((await adapter.listDevices())[0].state, "offline");
    assert.equal(screenshotCapability("").supported, false);
    assert.match(screenshotCapability("").reason, /无法读取/);
    const unavailable = fixture(() => { throw new Error("ERROR: Could not start service com.apple.syslog_relay"); });
    await assert.rejects(unavailable.adapter.logs(localId), error => /iOS 服务不可用/.test(error.message) && !/截图/.test(error.message));
});

test("local and remote commands retain their own socket address even when inherited environment selects another service", async () => {
    const previous = process.env.USBMUXD_SOCKET_ADDRESS;
    process.env.USBMUXD_SOCKET_ADDRESS = "wrong.test:1234";
    try {
        const local = fixture(() => info);
        const remote = fixture(() => info, { server: "ios-one.test:27015" });
        await Promise.all([local.adapter.info(localId), remote.adapter.info(`ios://ios-one.test:27015/${udid}`)]);
        assert.ok(local.calls.every(call => call.env.USBMUXD_SOCKET_ADDRESS === "UNIX:/run/usbmuxd"));
        assert.ok(remote.calls.every(call => call.env.USBMUXD_SOCKET_ADDRESS === "ios-one.test:27015"));
        await assert.rejects(remote.adapter.info(localId), /服务不匹配/);
    } finally {
        if (previous === undefined) { delete process.env.USBMUXD_SOCKET_ADDRESS; }
        else { process.env.USBMUXD_SOCKET_ADDRESS = previous; }
    }
});

test("app management parses pinned installer XML and cannot uninstall apps absent from this device", async () => {
    const apps = xml("<array><dict><key>CFBundleIdentifier</key><string>com.example.ios</string><key>CFBundleDisplayName</key><string>Example</string><key>CFBundleShortVersionString</key><string>1.2</string></dict></array>");
    const { adapter, calls } = fixture(({ args }) => args.includes("list") ? apps : "Complete");
    assert.deepEqual(await adapter.applications(localId), [{ packageName: "com.example.ios", name: "Example", version: "1.2" }]);
    await adapter.uninstall(localId, "com.example.ios");
    await assert.rejects(adapter.uninstall(localId, "com.apple.Preferences"), /用户应用列表/);
    await assert.rejects(adapter.uninstall(localId, "--help"), /Bundle ID/);
    assert.equal(calls.filter(call => call.args.includes("uninstall")).length, 1);
    const failed = fixture(() => "ERROR: ApplicationVerificationFailed");
    await assert.rejects(failed.adapter.install(localId, "/tmp/test.ipa"), /ApplicationVerificationFailed/);
});

test("screenshots report modern iOS limitations and remove temporary files after capture", async () => {
    assert.equal(screenshotCapability("18.1").supported, false);
    const modern = fixture(({ tool }) => tool === "ideviceinfo" ? info.replace("16.7", "18.1") : "SUCCESS");
    await assert.rejects(modern.adapter.screenshot(localId), error => error.statusCode === 501);
    assert.ok(modern.calls.every(call => call.tool !== "idevicescreenshot"));
    let temporary;
    const legacy = fixture(({ tool, args }) => {
        if (tool === "ideviceinfo") { return info; }
        if (tool === "idevicescreenshot") {
            temporary = args.at(-1); fs.writeFileSync(temporary, Buffer.from("89504e470d0a1a0a", "hex"));
        }
        return "SUCCESS";
    });
    const screenshot = await legacy.adapter.screenshot(localId);
    assert.equal(screenshot.contentType, "image/png");
    assert.equal(fs.existsSync(path.dirname(temporary)), false);
});

function logProcess({ ignoreTerm = false, earlyError = false } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.signals = [];
    child.kill = signal => {
        child.signals.push(signal);
        if (!ignoreTerm || signal === "SIGKILL") {
            setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", null, signal); });
        }
        return true;
    };
    setImmediate(() => {
        if (earlyError) { child.stderr.write("ERROR: device disconnected"); child.emit("close", 1, null); }
        else { child.stdout.write("unrelated\niPhone sample message\n"); }
    });
    return child;
}

test("log capture is bounded, filters output and terminates its child process", async () => {
    const child = logProcess();
    const { adapter } = fixture(() => "SUCCESS", { launch: () => child });
    const result = await adapter.logs(localId, { durationMs: 1000, lines: 20, search: "iPhone" });
    assert.deepEqual(result, { output: "iPhone sample message", lines: 1, durationMs: 1000 });
    assert.deepEqual(child.signals, ["SIGTERM"]);
    await assert.rejects(adapter.logs(localId, { durationMs: 100000 }), /采集时间/);
});

test("cancelled log capture kills a stubborn child and releases the device for another capture", async () => {
    const controller = new AbortController();
    const child = logProcess({ ignoreTerm: true });
    const { adapter } = fixture(() => "SUCCESS", { launch: () => child });
    const capture = adapter.logs(localId, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(adapter.logs(localId), error => error.statusCode === 409);
    controller.abort();
    await assert.rejects(capture, /取消/);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    const failed = fixture(() => "SUCCESS", { launch: () => logProcess({ earlyError: true }) });
    await assert.rejects(failed.adapter.logs(localId), /disconnected/);
});
