"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseAdbDevices, deviceTransport, normalizeAdbAddress, createEmulatorDiscovery } = require("../adb-devices");

const adbList = (...lines) => `List of devices attached\n${lines.join("\n")}\n`;
const device = (serial, state = "device", properties = {}) => ({ serial, state, properties });

test("mixed ADB devices preserve USB, local emulator, wireless and authorization state", () => {
    const devices = parseAdbDevices(adbList(
        "PHONE device usb:1-2 model:Pixel_8 transport_id:1",
        "emulator-5554 device model:sdk_gphone64_x86_64 transport_id:2",
        "adb-PHONE-key._adb-tls-connect._tcp device model:Pixel_8 transport_id:3",
        "192.168.1.12:5555 unauthorized transport_id:4"
    ));
    assert.deepEqual(devices.map(deviceTransport), ["usb", "emulator", "network", "network"]);
    assert.equal(devices[1].properties.model, "sdk_gphone64_x86_64");
    assert.equal(devices[3].state, "unauthorized");
    assert.deepEqual(parseAdbDevices(""), []);
});

test("manual ADB addresses accept hostname and IPv6, normalize localhost, and reject invalid arguments", () => {
    assert.equal(normalizeAdbAddress(" localhost:05555 "), "127.0.0.1:5555");
    assert.equal(normalizeAdbAddress("android-emulator:5555"), "android-emulator:5555");
    assert.equal(normalizeAdbAddress("[::1]:5555"), "[::1]:5555");
    for (const input of [undefined, "", "--help", "host", "host:0", "host:65536", "host:abc", "host:5555;id", "host\nname:5555", "[hostname]:5555"]) {
        assert.throws(() => normalizeAdbAddress(input), /ADB 地址/);
    }
});

function discoveryFixture({ hostDevices = [], connectedDevices = [], serverPort = 5038, hostPort = 5037, open = true, properties = "1\n1\n" } = {}) {
    const calls = [];
    const connected = [...connectedDevices];
    const discovery = createEmulatorDiscovery({
        adbServerPort: serverPort,
        emulatorServerPort: hostPort,
        isTcpPortOpen: async port => { calls.push(["port", port]); return open; },
        execAdbAtPort: async (port, args) => {
            calls.push(["host", port, ...args]);
            return adbList(...hostDevices);
        },
        execAdb: async args => {
            calls.push(["adb", ...args]);
            if (args[0] === "devices") {
                return adbList(...connected);
            }
            if (args[0] === "connect") {
                connected.push(`${args[1]} device model:sdk_gphone64_x86_64`);
                return `connected to ${args[1]}`;
            }
            if (args[0] === "-s") {
                if (properties instanceof Error) {
                    throw properties;
                }
                return properties;
            }
            throw new Error(`unexpected ADB command: ${args.join(" ")}`);
        }
    });
    return { discovery, calls };
}

test("host emulators join the independent ADB server without stopping either server or importing phones", async () => {
    const { discovery, calls } = discoveryFixture({ hostDevices: [
        "emulator-5554 device model:sdk_gphone64_x86_64",
        "emulator-5556 device model:sdk_gphone64_x86_64",
        "emulator-5558 offline",
        "PHONE device usb:1-2",
        "192.168.1.12:5555 device"
    ] });
    await discovery.connectLocalEmulators();
    assert.deepEqual(calls.filter(call => call[1] === "connect"), [
        ["adb", "connect", "127.0.0.1:5555"],
        ["adb", "connect", "127.0.0.1:5557"]
    ]);
    assert.ok(calls.every(call => !call.includes("kill-server") && !call.includes("start-server")));
});

test("simultaneous discovery requests share the same bridge and existing connections are reused", async () => {
    const { discovery, calls } = discoveryFixture({ hostDevices: ["emulator-5554 device"] });
    await Promise.all([discovery.connectLocalEmulators(), discovery.connectLocalEmulators()]);
    await discovery.connectLocalEmulators();
    assert.equal(calls.filter(call => call[1] === "connect").length, 1);
    assert.equal(calls.filter(call => call[0] === "host").length, 2);
});

test("an emulator already registered directly is not added a second time by TCP", async () => {
    const { discovery, calls } = discoveryFixture({
        hostDevices: ["emulator-5554 device"], connectedDevices: ["emulator-5554 device"]
    });
    await discovery.connectLocalEmulators();
    assert.equal(calls.filter(call => call[1] === "connect").length, 0);
});

test("sharing or disabling the host ADB server skips the bridge", async () => {
    for (const hostPort of [5038, 0]) {
        const { discovery, calls } = discoveryFixture({ hostPort });
        await discovery.connectLocalEmulators();
        assert.deepEqual(calls, []);
    }
});

test("an absent host ADB server is not started during discovery", async () => {
    const { discovery, calls } = discoveryFixture({ open: false });
    await discovery.connectLocalEmulators();
    assert.deepEqual(calls, [["port", 5037]]);
});

test("TCP emulator properties distinguish emulators from wireless phones and are cached per transport", async () => {
    const { discovery, calls } = discoveryFixture();
    const emulator = device("127.0.0.1:5555", "device", { transport_id: "1" });
    assert.equal(await discovery.deviceType(emulator), "emulator");
    assert.equal(await discovery.deviceType(emulator), "emulator");
    assert.equal(calls.length, 1);
    assert.equal(await discovery.deviceType({ ...emulator, properties: { transport_id: "2" } }), "emulator");
    assert.equal(calls.length, 2);
    const phone = discoveryFixture({ properties: "\n\n" }).discovery;
    assert.equal(await phone.deviceType(device("adb-phone._adb-tls-connect._tcp")), "network");
    assert.equal(await phone.deviceType(device("USB-PHONE")), "usb");
    assert.equal(await phone.deviceType(device("emulator-5554")), "emulator");
});

test("offline devices and unsupported emulator properties remain discoverable", async () => {
    const { discovery, calls } = discoveryFixture({ properties: new Error("property lookup unavailable"), hostDevices: ["emulator-5554 device"] });
    assert.equal(await discovery.deviceType(device("192.168.1.12:5555", "unauthorized")), "network");
    assert.deepEqual(calls, []);
    assert.equal(await discovery.deviceType(device("192.168.1.12:5555")), "network");
    await discovery.connectLocalEmulators();
    assert.equal(await discovery.deviceType(device("127.0.0.1:5555")), "emulator");
});
