"use strict";

const net = require("node:net");

function parseAdbDevices(output) {
    return output.split("\n").map(line => line.trim()).filter(line => line &&
        !line.startsWith("List of devices") && !line.startsWith("*"))
        .map(line => {
            const fields = line.split(/\s+/);
            const properties = {};
            for (const field of fields.slice(2)) {
                const separator = field.indexOf(":");
                if (separator > 0) {
                    properties[field.slice(0, separator)] = field.slice(separator + 1);
                }
            }
            return { serial: fields[0], state: fields[1] || "unknown", properties };
        });
}

function deviceTransport(device) {
    if (/^emulator-\d+$/.test(device.serial)) {
        return "emulator";
    }
    if (device.properties.usb) {
        return "usb";
    }
    return device.serial.includes(":") || /\._adb(?:-tls-connect)?\._tcp\.?$/.test(device.serial) ? "network" : "usb";
}

function normalizeAdbAddress(value) {
    const address = typeof value === "string" ? value.trim() : "";
    const match = address.match(/^(\[[^\]]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}):(\d{1,5})$/);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 ||
        (match[1].startsWith("[") && net.isIP(match[1].slice(1, -1)) !== 6)) {
        throw new Error("请输入有效的 ADB 地址，例如 127.0.0.1:5555 或 [::1]:5555");
    }
    const host = match[1].toLowerCase() === "localhost" ? "127.0.0.1" : match[1].toLowerCase();
    return `${host}:${Number(match[2])}`;
}

function localEmulatorAddress(serial) {
    const match = serial.match(/^emulator-(\d+)$/);
    const port = match ? Number(match[1]) + 1 : 0;
    return port > 1 && port <= 65535 ? `127.0.0.1:${port}` : null;
}

function createEmulatorDiscovery({ execAdb, execAdbAtPort, isTcpPortOpen, adbServerPort, emulatorServerPort = 5037 }) {
    const localEmulators = new Set();
    const typeCache = new Map();
    let bridgePromise = null;

    async function connectLocalEmulators() {
        if (!emulatorServerPort || emulatorServerPort === adbServerPort) {
            return;
        }
        if (bridgePromise) {
            return bridgePromise;
        }
        bridgePromise = (async () => {
            if (!await isTcpPortOpen(emulatorServerPort)) {
                return;
            }
            const output = await execAdbAtPort(emulatorServerPort, ["devices", "-l"], { timeout: 3000 }).catch(() => "");
            const emulators = parseAdbDevices(output).filter(device =>
                deviceTransport(device) === "emulator" && device.state === "device");
            if (!emulators.length) {
                return;
            }
            const connected = parseAdbDevices(await execAdb(["devices", "-l"], { timeout: 3000 }));
            await Promise.all(emulators.map(async device => {
                const address = localEmulatorAddress(device.serial);
                if (!address || connected.some(item => item.serial === device.serial)) {
                    return;
                }
                localEmulators.add(address);
                if (!connected.some(item => item.serial === address && item.state === "device")) {
                    await execAdb(["connect", address], { timeout: 3000 }).catch(() => {});
                }
            }));
        })().finally(() => {
            bridgePromise = null;
        });
        return bridgePromise;
    }

    async function deviceType(device) {
        const transport = deviceTransport(device);
        if (transport === "emulator") {
            return "emulator";
        }
        if (transport !== "network" || device.state !== "device") {
            return localEmulators.has(device.serial) ? "emulator" : transport;
        }
        const key = `${device.serial}:${device.properties.transport_id || ""}`;
        const cached = typeCache.get(key);
        if (cached && Date.now() - cached.time < 30000) {
            return cached.type;
        }
        try {
            const output = await execAdb(["-s", device.serial, "exec-out", "getprop ro.kernel.qemu; getprop ro.boot.qemu"], { timeout: 3000 });
            const type = output.split(/\s+/).includes("1") ? "emulator" : "network";
            typeCache.set(key, { type, time: Date.now() });
            if (typeCache.size > 200) {
                typeCache.delete(typeCache.keys().next().value);
            }
            return type;
        } catch {
            return localEmulators.has(device.serial) ? "emulator" : "network";
        }
    }

    return { connectLocalEmulators, deviceType };
}

module.exports = { parseAdbDevices, deviceTransport, normalizeAdbAddress, createEmulatorDiscovery };
