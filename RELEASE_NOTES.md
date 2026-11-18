# Android Physical Web v1.0.1

1.0.1，补强公开镜像入口，汇总 Android、HarmonyOS HDC 与 iPhone 的统一 Web 工作台。

## HarmonyOS

- 保留原有 HDC JPEG 截图、点击、滑动、按键和文字输入路径。
- HAP 已安装时自动探测并启动设备端视频服务，浏览器通过反向网关接收 H.264、RAW RGBA 或 JPEG。
- HAP 未安装、启动失败或 8 秒内没有首帧时，画面自动回退到原有 JPEG 截图。
- 当前 HarmonyOS x86_64 模拟器没有可用的 AVC/H.264 编码器，屏幕采集在 RGBA 与 YUV 模式下也都没有产生视频回调，因此该模拟器会稳定回退到截图预览。控制仍可正常使用。
- Release 附带 `OHScrcpyServer-x86_64-v1.0.1.hap`，面向 HarmonyOS x86_64 模拟器实验环境；安装后 Web 页面会自动检测并尝试启动。
- HAP SHA256：`b7fa42fe53fe50f8da47e411f2c80c0cdf0e9468d9e3f1f22aad1be1dfa58b8c`

## Android 与 iPhone

- Android 保留真机、网络调试、模拟器和 scrcpy 控制能力。
- iPhone 保留 USB/远程连接、DeviceKit 画面、输入、应用、日志、信息和截图工具。

## Docker

Release 同时提供 `android-physical-web-v1.0.1.tar.gz`。离线主机可先下载该文件并执行：

```bash
gzip -dc android-physical-web-v1.0.1.tar.gz | docker load
```

在线主机可以直接拉取镜像：

```bash
docker pull ttyob/android-physical-web:v1.0.1
```

直接运行：

```bash
docker run -d \
  --name android-physical-web \
  --restart unless-stopped \
  --network host \
  -e GATEWAY_PORT=8000 \
  -e HAP_BRIDGE_PORT=8090 \
  -v "$PWD/data:/data" \
  -v "$PWD/adb-keys:/root/.android" \
  -v "$PWD/hdc-keys:/root/.harmony" \
  -v "$PWD/ios-pairing:/var/lib/lockdown" \
  -v /dev/bus/usb:/dev/bus/usb \
  -v /run/udev:/run/udev:ro \
  --device-cgroup-rule='c 189:* rmw' \
  ttyob/android-physical-web:v1.0.1
```

基本校验：

```bash
node --test test/*.test.js
```

当前自动化测试共 67 项，覆盖网关、HDC、HAP 流解析和 iOS 控制路径。
