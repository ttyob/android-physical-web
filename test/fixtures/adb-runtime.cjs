"use strict";

// Preloaded only by gateway.test.js: all native commands and upstream processes are simulated.
const http = require("node:http");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const IOS_PHONE = "00008110-000A001122334455";
const IOS_UNTRUSTED = "00008110-000B001122334455";
const IOS_MODERN = "00008120-000C001122334455";
const iosTrusted = new Set([IOS_PHONE, IOS_MODERN]);
const realExists = fs.existsSync;
fs.existsSync = file => String(file).startsWith("/test/ios/") || realExists(file);
const xml = value => `<?xml version="1.0"?><plist version="1.0">${value}</plist>`;

function iosService(options) {
    const service = options.env.USBMUXD_SOCKET_ADDRESS;
    if (!["UNIX:/run/usbmuxd", "ios-one.test:27015", "ios-two.test:27015", "ios-down.test:27015"].includes(service)) {
        throw new Error("every iOS command must explicitly choose its usbmuxd service");
    }
    return service;
}

function fakeIos(filename, args, options, callback) {
    const tool = path.basename(filename);
    const service = iosService(options);
    let output;
    let error = null;
    if (service === "ios-down.test:27015") { error = new Error("usbmuxd unavailable"); }
    else if (tool === "idevice_id") {
        if (args.join(" ") !== "-l") { throw new Error("unexpected iOS discovery command"); }
        output = [IOS_PHONE, IOS_UNTRUSTED, IOS_MODERN].join("\n");
    } else {
        const udid = args[1];
        if (args[0] !== "-u" || ![IOS_PHONE, IOS_UNTRUSTED, IOS_MODERN].includes(udid)) {
            throw new Error("iOS command must explicitly choose a valid connected UDID");
        }
        const command = args.slice(2);
        if (tool === "idevicepair") {
            if (command[0] === "pair") { iosTrusted.add(udid); }
            if (!iosTrusted.has(udid)) { error = new Error("Device is not paired. Please pair with the device."); }
            else { output = "SUCCESS: paired / validated"; }
        } else if (!iosTrusted.has(udid)) { throw new Error("untrusted iPhone cannot run debug commands"); }
        else if (tool === "ideviceinfo" && command.join(" ") === "-x") {
            output = xml(`<dict><key>DeviceName</key><string>iPhone ${service}</string><key>ProductType</key><string>iPhone14,5</string><key>ProductVersion</key><string>${udid === IOS_MODERN ? "18.1" : "16.7"}</string><key>SerialNumber</key><string>TEST-IPHONE</string></dict>`);
        } else if (tool === "ideviceinstaller" && command.join(" ") === "list --user --xml") {
            output = xml("<array><dict><key>CFBundleIdentifier</key><string>com.example.iphone</string><key>CFBundleDisplayName</key><string>Test iOS App</string><key>CFBundleShortVersionString</key><string>1.0</string></dict></array>");
        } else if (tool === "ideviceinstaller" && command[0] === "install") {
            fs.readFileSync(command[1]); output = "Install: Complete";
        } else if (tool === "ideviceinstaller" && command[0] === "uninstall" && command[1] === "com.example.iphone") {
            output = "Uninstall: Complete";
        } else if (tool === "idevicescreenshot") {
            fs.writeFileSync(command[0], Buffer.from("89504e470d0a1a0a", "hex")); output = "Screenshot saved";
        } else { throw new Error(`unexpected iOS command: ${tool} ${command.join(" ")}`); }
    }
    setTimeout(() => callback(error, output || "", ""), 3);
}

const harmonyDevices = new Map([["TEST-PHONE", "USB Connected"], ["HARMONY-OFFLINE", "USB Offline"], ["127.0.0.1:5555", "TCP Connected"]]);

function fakeHdc(args, callback) {
    const server = args[1];
    if (args[0] !== "-s" || ![process.env.HDC_TEST_SERVER, "second-hdc.test:18710"].includes(server)) {
        throw new Error("HDC server must be explicitly selected by the gateway");
    }
    if (args[2] !== "-p") { throw new Error("remote HDC must run in client mode"); }
    const device = args[3] === "-t" ? args[4] : null;
    const command = args.slice(device ? 5 : 3);
    let output;
    if (command[0] === "list") {
        output = [...harmonyDevices].map(([key, state]) => `${key} ${state}`).join("\n");
    } else if (command[0] === "tconn") {
        harmonyDevices.set(command[1], "TCP Connected");
        output = "Connect OK";
    } else if (!harmonyDevices.has(device) || !harmonyDevices.get(device).includes("Connected")) {
        throw new Error("HDC command attempted on a missing/offline device");
    } else if (command[0] === "shell") {
        const shell = command[1];
        if (shell === "param get const.product.model") { output = "Test Harmony"; }
        else if (shell.startsWith("realpath ")) {
            output = [...shell.matchAll(/realpath '([^']+)'/g)].map(match => match[1]).join("\n");
        } else if (shell.startsWith("find ")) { output = "regular file|8|1700000000|/data/local/tmp/example.txt\n"; }
        else if (shell.startsWith("stat ")) { output = "regular file"; }
        else if (shell.startsWith("if [ -e")) { output = ""; }
        else if (shell === "bm dump -a") { output = "bundle list:\ncom.example.harmony\ncom.example.tools\n"; }
        else if (shell === "hidumper -s RenderService -a screen") {
            output = "screen[0]: render resolution=1280x2832, physical resolution=1280x2832\nactiveMode: 1280x2832, refreshRate=60\n";
        }
        else if (shell.startsWith("snapshot_display ")) {
            const width = shell.match(/\s-w (\d+)/)?.[1] || "720";
            output = `fileType: jpeg\nprocess: display 0, file type: jpeg, width: 1280, height: 2832\nsuccess: snapshot display 0 as jpeg, width: ${width}, height: 2832\n`;
        }
        else if (shell.startsWith("uitest uiInput ")) { output = "No Error"; }
        else if (shell === "hilog -x") { output = "D test debug\nI test Harmony message\nW other log\n"; }
        else { output = `hdc://${server}/${device}\n`; }
    } else if (command[0] === "file") {
        if (command[1] === "recv") { fs.writeFileSync(command[3], "hdc-file"); }
        else if (command[1] === "send") { fs.readFileSync(command[2]); }
        output = "FileTransfer finish";
    } else if (command[0] === "install") {
        fs.readFileSync(command[2]); output = "install bundle successfully.";
    } else if (command[0] === "uninstall") { output = "uninstall bundle successfully."; }
    else { throw new Error(`unexpected HDC command: ${command.join(" ")}`); }
    setTimeout(() => callback(null, output, ""), 3);
}

const devices = new Map([
    ["TEST-PHONE", "device usb:1-2 model:Test_Phone transport_id:1"],
    ["emulator-5554", "device model:sdk_gphone64_x86_64 transport_id:2"],
    ["emulator-5556", "offline model:sdk_gphone64_x86_64 transport_id:3"]
]);

childProcess.execFile = (filename, args, options, callback) => {
    if (filename.startsWith("/test/ios/")) { return fakeIos(filename, args, options, callback); }
    if (filename === process.env.HDC_PATH) {
        return fakeHdc(args, callback);
    }
    if (filename !== "/test/fake-adb") {
        throw new Error(`real command blocked by test: ${filename}`);
    }
    let output;
    if (args[0] === "devices") {
        output = `List of devices attached\n${[...devices].map(([serial, properties]) => `${serial} ${properties}`).join("\n")}\n`;
    } else if (args[0] === "mdns") {
        output = "List of discovered mdns services\n";
    } else if (args[0] === "connect") {
        devices.set(args[1], "device model:sdk_gphone64_x86_64 transport_id:4");
        output = `connected to ${args[1]}`;
    } else if (args[0] === "disconnect") {
        devices.delete(args[1]);
        output = `disconnected ${args[1]}`;
    } else if (args[0] === "-s" && devices.has(args[1])) {
        output = args[2] === "exec-out" ? "1\n1\n" : `${args[1]}\n`;
    } else {
        setImmediate(() => callback(new Error(`unexpected ADB command: ${args.join(" ")}`), "", ""));
        return;
    }
    setTimeout(() => callback(null, output, ""), args[1] === "TEST-PHONE" ? 20 : 1);
};

childProcess.spawn = (filename, args, options) => {
    if (filename === "/test/ios/idevicesyslog") {
        const service = iosService(options);
        if (args[0] !== "-u" || !iosTrusted.has(args[1])) { throw new Error("syslog must choose a trusted iPhone"); }
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let closed = false;
        child.kill = signal => {
            if (!closed) {
                closed = true;
                setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", null, signal); });
            }
            return true;
        };
        setImmediate(() => child.stdout.write(`iPhone ${service} ${args[1]} sample log\nother line\n`));
        return child;
    }
    if (args[0] !== "/app/dist/index.js") {
        throw new Error(`real process blocked by test: ${filename}`);
    }
    const child = new EventEmitter();
    const server = http.createServer((request, response) => {
        response.writeHead(200, { "Set-Cookie": "ws_scrcpy_token=gateway-test-token; Path=/; HttpOnly" });
        response.end("test upstream");
    });
    server.on("upgrade", (request, socket) => {
        const serial = new URL(request.url, "http://localhost").searchParams.get("udid");
        const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Test-Device: ${serial}\r\n\r\n`);
    });
    server.listen(Number(process.env.UPSTREAM_PORT), "127.0.0.1");
    child.kill = () => server.close(() => child.emit("exit", 0));
    return child;
};
