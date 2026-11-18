"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHdcAdapter, parseHdcTargets, targetKey, normalizeHdcAddress, normalizeHdcPath, parseHdcDevice } = require("../hdc");

const TEST_SERVER = "hdc.test:18710";
const deviceId = key => `hdc://${TEST_SERVER}/${key}`;

function fixture(reply, options = {}) {
    const calls = [];
    const adapter = createHdcAdapter({
        executable: __filename, server: TEST_SERVER,
        ...options,
        execute(filename, args, options, callback) {
            calls.push(args);
            try { const value = reply(args); queueMicrotask(() => callback(null, value, "")); }
            catch (error) { queueMicrotask(() => callback(error, "", "")); }
        }
    });
    return { adapter, calls };
}

test("HDC target parsing preserves transport and authorization, including IPv6 targets", () => {
    const output = "ConnectKey Type Status\r\nUSB1 USB Connected\r\nUSB2 USB Unauthorized\r\n192.168.1.2:10178 TCP Connected\r\nOFFLINE USB Offline\r\n[::1]:10178 TCP Connected\r\n";
    assert.deepEqual(parseHdcTargets(output).map(({ key, state, transport }) => [key, state, transport]), [
        ["USB1", "device", "usb"], ["USB2", "unauthorized", "usb"], ["192.168.1.2:10178", "device", "network"],
        ["OFFLINE", "offline", "usb"], ["[::1]:10178", "device", "network"]
    ]);
    assert.deepEqual(parseHdcTargets("[Empty]\r\n"), []);
});

test("HDC identities and addresses cannot become command options or shell fragments", () => {
    assert.equal(targetKey(deviceId("USB1")), "USB1");
    assert.equal(targetKey(deviceId("[::1]:10178")), "[::1]:10178");
    for (const value of ["USB1", "hdc://", deviceId("--help"), deviceId("USB1 shell id"), deviceId("USB1\n")]) {
        assert.throws(() => targetKey(value));
    }
    assert.equal(normalizeHdcAddress(" localhost:10178 "), "127.0.0.1:10178");
    assert.equal(normalizeHdcAddress("[::1]:10178"), "[::1]:10178");
    for (const value of ["--help", "host:65536", "host:0", "host:123;id", "host\nname:123"]) {
        assert.throws(() => normalizeHdcAddress(value));
    }
});

test("HDC remote files stay within the debug directory and cannot delete its root", () => {
    assert.equal(normalizeHdcPath("example.txt"), "/data/local/tmp/example.txt");
    for (const value of ["/etc/passwd", "../passwd", "/data/local/tmp/../../etc", "bad\0name"]) {
        assert.throws(() => normalizeHdcPath(value));
    }
    assert.throws(() => normalizeHdcPath("/data/local/tmp", false));
});

test("HDC resolved symlinks outside the debug directory are rejected before transfer", async () => {
    const { adapter, calls } = fixture(() => "/data/local/tmp\n/etc/passwd\n");
    await assert.rejects(adapter.receiveFile(deviceId("USB1"), "/data/local/tmp/link", "/tmp/unused"), /真实路径/);
    assert.equal(calls.length, 1);
    assert.ok(calls.every(args => !args.includes("file")));
});

test("HDC discovery failure stays local to its provider and exposes a useful status", async () => {
    const { adapter } = fixture(() => { throw new Error("HDC service unavailable"); });
    assert.deepEqual(await adapter.listDevices(), []);
    assert.match(adapter.status().error, /unavailable/);
    await assert.rejects(adapter.assertConnected(deviceId("USB1")), /unavailable/);
});

test("HDC model lookups are cached and all commands select a server and target explicitly", async () => {
    const { adapter, calls } = fixture(args => args.includes("list") ? "USB1 USB Connected" : "Harmony Model");
    assert.equal((await adapter.listDevices())[0].model, "Harmony Model");
    await adapter.listDevices();
    assert.equal(calls.filter(args => args.includes("shell")).length, 1);
    assert.ok(calls.every(args => args[0] === "-s" && args[1] === TEST_SERVER));
    assert.ok(calls.filter(args => args.includes("shell")).every(args => args[2] === "-p" && args[3] === "-t" && args[4] === "USB1"));
});

test("HDC nonzero application failures reported with exit code zero are still rejected", async () => {
    const { adapter } = fixture(() => "[Fail] install bundle failed: signature mismatch");
    await assert.rejects(adapter.install(deviceId("USB1"), "/tmp/example.hap"), /signature mismatch/);
});

test("an empty HDC service never runs discovery or automatically connects a target", async () => {
    const { adapter, calls } = fixture(() => { throw new Error("unexpected native command"); }, { server: "" });
    assert.deepEqual(await adapter.listDevices(), []);
    assert.deepEqual(await adapter.listDevices(), []);
    assert.equal(adapter.status().server, null);
    assert.equal(adapter.status().configured, false);
    assert.equal(adapter.status().error, null);
    await assert.rejects(adapter.connect("127.0.0.1:5555"), /先填写 HDC 服务地址/);
    assert.equal(calls.length, 0);
});

test("an explicitly chosen remote server preserves its loopback target and coalesces discovery", async () => {
    const { adapter, calls } = fixture(args => args.includes("list") ? "127.0.0.1:5555 TCP Connected" : "Harmony Emulator");
    const [first, second] = await Promise.all([adapter.listDevices(), adapter.listDevices()]);
    assert.equal(first[0].serial, deviceId("127.0.0.1:5555"));
    assert.equal(first[0].connectKey, "127.0.0.1:5555");
    assert.equal(second[0].model, "Harmony Emulator");
    assert.equal(calls.filter(args => args.includes("list")).length, 1);
    assert.ok(calls.every(args => args[0] === "-s" && args[1] === TEST_SERVER && args[2] === "-p"));
    assert.ok(!calls.some(args => args.some(arg => ["tconn", "start", "kill"].includes(arg))));
});

test("normal discovery never dials a preset device even when the target list is empty", async () => {
    const { adapter, calls } = fixture(() => "[Empty]");
    assert.deepEqual(await adapter.listDevices(), []);
    assert.deepEqual(await adapter.listDevices(), []);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(args => args.slice(-3).join(" ") === "list targets -v"));
    assert.equal(adapter.status().error, null);
});

test("HDC device identities bind a target to its manually selected server", () => {
    const { adapter, calls } = fixture(() => "");
    assert.deepEqual(parseHdcDevice(deviceId("USB1")), { server: TEST_SERVER, key: "USB1" });
    assert.throws(() => adapter.shell("hdc://other.test:18710/USB1", "id"), /不匹配/);
    assert.equal(calls.length, 0);
    for (const server of ["--help", "host:65536", "host:0"]) {
        assert.throws(() => fixture(() => "", { server }));
    }
    assert.equal(fixture(() => "[Empty]", { server: "[::1]:18710" }).adapter.status().server, "[::1]:18710");
});
