# 多设备 Web 工作台

在同一个 Web 工作台中发现、添加并同时使用 Android 真机、Android 模拟器、HarmonyOS HDC
设备和 iPhone 真机。Android 支持 USB、无线调试、本机 Android Emulator 和 TCP ADB；鸿蒙提供设备
发现、Shell、HiLog、文件管理及 HAP/HSP 安装和应用卸载。iPhone 提供信任配对、设备信息、
系统日志、用户应用管理和有条件截图，并通过 DeviceKit 接入画面与触控。鸿蒙提供约每 0.8–1 秒一帧
的截图预览，可在画面中点击、滑动、发送常用按键和文字输入。
该目录可以独立复制和部署，不依赖父目录或其他 Web 控制项目。正式版本从
[Releases](https://github.com/ttyob/android-physical-web/releases) 下载；镜像和版本记录见发布页。

## Docker

使用预构建镜像：

```bash
docker pull ghcr.io/ttyob/android-physical-web:v1.0.0
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
  ghcr.io/ttyob/android-physical-web:v1.0.0
```

Release 另提供 `android-physical-web-v1.0.0.tar.gz`，离线环境可执行
`gzip -dc <文件> | docker load` 后按相同参数启动。仓库源码构建仍使用 `docker compose build`。
Release 同时附带 `OHScrcpyServer-x86_64-v1.0.0.hap`，供受支持的 HarmonyOS x86_64 调试环境
尝试实时画面；未经适配的设备仍自动使用截图回退。

## 启动

服务默认使用独立的 `5038` ADB Server：

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

修改源码后可先标记当前完整镜像，再重建应用层：

```bash
docker tag android-physical-web:local android-physical-web:base
docker build --build-arg BASE_IMAGE=android-physical-web:base -t android-physical-web:local .
docker compose up -d --no-deps --force-recreate physical-web
```

默认访问 `http://服务器IP:8000/`。服务未添加设备时也会正常启动，页面自动打开设备列表。
“添加设备”按“Android 真机”“Android 模拟器”“鸿蒙 HDC”“iPhone”四个标签页分组，并显示各组数量。
真机页区分 USB 和无线连接；各页的手动地址连接默认折叠，可点击展开。窗口会记住上次选择的
分组，HDC 服务地址及连接错误只在鸿蒙页显示。
初始化配置时复制 `.env.example` 为 `.env`，已有配置直接修改后执行 `docker compose up -d`。
HDC 服务及设备地址由页面手动填写，启动时不连接任何 HDC 服务。
远程 usbmuxd 地址同样由页面手动填写，不保存为默认连接。
手机重新插入后，
如果宿主机标准 `5037` ADB Server 抢先占用了物理 USB 设备，发现接口会自动释放该竞争服务
并由独立 ADB Server 重新枚举。只有 `5037` 仅持有 USB 设备时才会执行恢复；同时存在模拟器
或网络设备时会保留宿主机 ADB，避免中断这些连接。需要复用宿主机的全部设备时，可将
`ADB_SERVER_PORT` 设置为 `5037`。

## 模拟器

先启动模拟器，再在“添加设备”中的“模拟器”列表添加到工作台：

- 本机 Google Android Emulator：自动从宿主机 `5037` ADB Server 发现，并将其本机 ADB
  端口连接到控制服务的独立 ADB Server；无需停止宿主机 ADB。
- Docker、其他主机或第三方模拟器：在“通过 ADB 地址连接”输入可达的 `IP:端口`，例如
  `127.0.0.1:5555`，连接成功后会加入工作台。Docker 模拟器需要将 ADB 端口发布到宿主机。
- 已连接到控制服务 ADB Server 的 `emulator-*` 设备也会直接显示。

TCP 设备会根据 Android 的模拟器属性识别；未提供该属性的第三方模拟器显示在“网络”列表，
仍可正常控制。设备要求与 scrcpy 一致，需要 Android 5.0 或以上版本并开启 ADB。
`EMULATOR_ADB_SERVER_PORT` 可修改本机模拟器发现使用的 ADB Server 端口，设置为 `0` 可关闭
自动接入。此服务负责控制已运行的模拟器，不负责创建、启动或停止 Android 虚拟机。

## USB 设备

在手机“开发者选项”中开启“USB 调试”并连接数据线。首次连接时在手机上确认“允许 USB
调试”，然后在页面的 USB 列表将设备添加到工作台。

## 网络设备

服务器与手机需要位于允许 mDNS 组播的同一局域网。Android 11 及以上开启“无线调试”后：

- 已配对设备会显示“连接”按钮。
- 手机打开“使用配对码配对设备”时，页面会显示配对项；输入六位配对码即可配对。
- 已通过其他方式连接的网络 ADB 设备会直接显示在列表中。

工作台可以同时打开多个真机和模拟器，每台设备都有独立的视频流、控制状态、资源信息、
文件管理、录屏和调试工具。关闭某个设备面板不会影响其他面板，也不会主动断开 ADB。已打开
的 Android 设备列表及用户自定义的设备显示名称保存在浏览器本地。ADB 密钥持久化在 `./adb-keys`，
自动发现的设备不需要配置 IP、无线调试端口或 `ADB_SERIAL`。

## HarmonyOS / HDC

“添加设备”中的“鸿蒙 · HDC”显示当前 HDC 服务管理的设备。HDC 设备使用独立标识，
可以与相同编号的 Android 设备同时打开。鸿蒙设备打开专用管理页，不调用 Android scrcpy。

### 手动连接

HDC 服务地址和设备地址初始均为空，也不会从环境变量或浏览器历史中恢复。

1. 在“鸿蒙 HDC”页填写 **HDC 服务地址**（主机 IP:端口），点击“连接服务”。
2. 已连接到该服务的 USB 设备和模拟器会显示在列表中，点击“添加”加入工作台。
3. 如果服务尚未连接目标设备，可展开“通过 HDC 地址连接设备”，手动填写 **设备地址**。
4. 点击当前服务旁的“断开”可清空本页连接及已打开的鸿蒙面板。

输入的地址仅在当前页面使用，刷新页面后需要重新填写。鸿蒙面板不会写入自动恢复的
设备列表；旧版本保存的鸿蒙面板也会在加载页面时移除。自动扫描仅查询手动连接的服务，
不会拨号连接任何预设模拟器。

Windows 远程模式下，服务地址是 Windows 上 HDC 服务的监听地址；设备地址由 Windows
服务解析，因此模拟器的回环地址也指向 Windows。先启动模拟器和可从开发服务器访问的
HDC 服务。连接异常时检查服务监听地址、端口及 Windows 防火墙。项目使用单客户端模式
访问远程 HDC，沿用 Windows 服务端已有的设备授权。

使用开发服务器本机的 USB 设备时，填写本机 HDC 服务地址，并在设备上允许 HDC 调试。
本机调试密钥保存在 `./hdc-keys`。`HDC_ENABLED=false` 可在部署配置中关闭 HDC 功能。

### 文件与应用

文件管理限定在设备的 `/data/local/tmp` 目录内，提供浏览、上传、下载、新建文件夹及删除，
并检查真实路径，避免通过符号链接访问目录外。Shell 可以执行调试账户权限内的命令；
每次限时 30 秒。HiLog 支持搜索、行数限制和定时刷新。

应用管理使用 Bundle Manager 列表与 HDC 安装/卸载，接收 `.hap`、`.hsp`，不接收 Android APK。
实际安装仍需满足设备的签名和调试授权要求。

### 画面与操作

鸿蒙专用页默认使用设备自带的 `snapshot_display` 取 JPEG 画面，经 HDC 下载后由浏览器轮询显示，
典型帧耗时约 0.5–1 秒。预览会自动读取设备原生显示尺寸，把点击和拖动坐标换算回设备坐标，
再通过 `uitest uiInput` 执行。页面支持点击、拖动、主屏幕、返回和文字输入，这条原有路径不需要
安装设备端服务或桌面客户端。

设备已安装 `com.ohos.scrcpy.server` 时，网页会自动启动 HAP 并等待 `53535` 视频服务，通过反向桥接
接收 H.264、RAW RGBA 或 JPEG。HAP 未安装、启动失败或 8 秒内没有首帧时，页面自动关闭流连接并
恢复 JPEG 截图。输入仍走原有 HDC 接口，不依赖 HAP 是否成功产出视频。

当前 HarmonyOS x86_64 模拟器没有可用的 AVC/H.264 编码器；屏幕采集在 RGBA 和 YUV 模式下均未
产生视频回调，因此该设备会显示“截图回退 · JPEG”。实时视频能力取决于设备编码器和屏幕采集
实现，不具备实时帧的设备不会卡住页面。

HDC `3.2.0b` 可执行文件、配套 `libusb_shared.so`、SDK 版本和原始声明一起保存在
[`vendor/hdc/linux-x64/`](./vendor/hdc/README.md)。Docker 构建会校验 `SHA256SUMS`、验证工具版本，
并安装所需 `libatomic1`，不依赖宿主机上的 HarmonyOS SDK。

## iPhone 真机 / iOS

### USB 与信任配对

1. 使用数据线将 iPhone 连接到开发服务器，保持手机已解锁。
2. 打开“添加设备 → iPhone”。未信任的设备会显示“配对”，点击后在手机上选择
   “信任此电脑”并输入手机密码；若工具先返回等待信任的提示，确认后再点一次配对。
3. 已信任的设备点击“添加”，打开专用 iPhone 调试面板。

Compose 已挂载 USB 总线及只读的 `/run/udev` 设备事件数据，以支持运行中插拔设备，
并在容器内启动独立的 `usbmuxd`，不占用宿主机的 UNIX socket。
本机配对记录保存在 `./ios-pairing`，重建容器后继续保留。此目录含设备信任凭据，
已加入忽略规则。`IOS_ENABLED=false` 可关闭 iOS 发现和容器内的 usbmuxd。

Linux 宿主机若也安装了 usbmuxd，插入 iPhone 时系统可能自动启动它并抢占 USB，
出现“系统看得到 iPhone，但工作台没有设备”。由本项目独立管理 USB 时，在宿主机执行一次：

```bash
sudo sh scripts/configure-ios-usb.sh
docker compose up -d --force-recreate physical-web
```

脚本会停止并屏蔽宿主机 `usbmuxd.service`，在 `/etc/udev/rules.d/39-usbmuxd.rules`
添加指向 `/dev/null` 的覆盖，避免系统再次重置 USB 配置并拉起另一个服务。遇到同名
自定义规则时会保留它并退出。本次 PVE 直通环境已应用此配置。
后续如要改回宿主机管理，先停止项目容器，再移除该规则覆盖，执行
`sudo systemctl unmask usbmuxd.service`、`sudo udevadm control --reload-rules`，随后重新插拔设备。

### 远程主机上的 iPhone

手机接在另一台 Mac、Linux 或 Windows 主机时，展开“连接其他主机上的 iPhone”，填写
开发服务器可访问的 **usbmuxd 兼容服务地址（主机 IP:端口）**。该主机需具备可用的苹果
设备驱动、USB 复用服务和设备信任配对；如果服务仅监听回环地址，需先自行提供端口隧道。
这里填写服务地址，不是手机 Wi-Fi IP，也不使用 ADB 或 HDC 协议。
本版本不自动发现或配置 Windows 的苹果设备服务。

远程模式使用 `USBMUXD_SOCKET_ADDRESS`，每条命令均单独指定服务与 UDID，相同 UDID 在
不同服务上使用不同的设备标识。远程配对记录由兼容服务管理。地址只在当前页面内存中使用，
刷新后清空；iPhone 面板也不会写入自动恢复列表。点击“返回本机 USB”清空远程连接并
关闭当前 iPhone 面板，恢复扫描服务器本机 USB。

### 画面与设备工具

iPhone 控制页沿用安卓的布局：手机画面居中，右侧为连接、截图、输入、应用、日志、信息和
设置工具；底部提供唤醒、主屏幕和画面刷新；右侧“密码”提供固定键盘画面的输入模式。应用、日志等在弹窗中操作，关闭后继续控制手机，
画面位置不随工具或状态文字改变。首次安装说明收在设置中。

- **画面**：手动连接已启动的 DeviceKit，优先 H.264；不支持时回退 MJPEG 和逐帧截图。
  设置中可手动选择 MJPEG 或逐帧截图。支持点击、长按、滑动、唤醒、主屏幕和文字输入。
  每个手势使用按下时的坐标变换，连续点击按顺序执行，最多排队 8 次。隐藏页面或关闭窗口
  会释放视频连接；打开工具窗口保留画面。
- **输入**：先点击手机输入框，再在工具窗口中输入文字，支持多行和 Ctrl / ⌘ + Enter 发送。
- **日志**：采集未来 1–10 秒的系统日志，支持关键词、连续分段采集和下载，最多保留 2000 行。
  切换工具、关闭弹窗、取消请求或隐藏页面会结束连续采集。
- **应用**：列出用户应用，安装适用于当前设备的已签名 IPA，卸载用户应用。
- **截图**：连接画面后使用 DeviceKit 截图并预览、下载 JPEG / PNG；未连接时，iOS 16 及以下
  仍可通过 `idevicescreenshot` 截图，需要已挂载匹配的开发者镜像。
- **信息**：名称、型号、iOS 版本、构建号、序列号、UDID、连接方式及配对重试。

iPhone 使用 `ios://服务/UDID` 独立通道，每条 USB 连接都指定设备和服务，不调用 Android
Shell、scrcpy 或 HDC。未接入 iOS 模拟器、通用 Shell 和直接 Wi-Fi 配对。

### 锁屏密码键盘

当前 iPhone 12 / iOS 27.2 的 DeviceKit 采集通道中，锁屏密码键盘可能在输入第一位后消失，
原始 JPEG 也可能只返回壁纸。网页解码无法补回采集源缺少的内容。

可以使用右侧的“密码”工具继续点按：

1. 取消当前输入，重新调出完整的锁屏密码键盘。
2. 在输入第一位之前，点击右侧“密码”，固定当前可见的键盘画面。
3. 点击画面上的数字按键；点按仍按原坐标发送到手机，密码圆点不会实时更新。
4. 输入完成后点击右侧“恢复”，查看手机的实时画面和解锁结果。

固定期间会停止视频连接，页面始终显示“画面已固定”，不能据此判断密码正确或手机已解锁。
唤醒、主屏幕、刷新画面、重连、显示方式切换、页面隐藏或断开连接会退出此模式；画面仅在
当前页面内存中保存，退出后释放。手机布局发生变化时请先恢复实时画面。也可在本机完成认证。

### DeviceKit 签名与启动

项目固化 [DeviceKit 0.0.18](./vendor/devicekit/README.md) 和
[go-ios v1.3.2](./vendor/go-ios/README.md)，包含未签名 IPA、来源、SHA256、许可证及可重复
执行的打包脚本。项目不保存个人证书、密码或签名后的私人安装包。

用全能签等工具签名安装设置中提供的 DeviceKit IPA，保留 `devicekit-iosUITests.xctest` 测试
插件。派生包使用手机开发者镜像中的匹配 XCTest 运行库，原包内的旧运行库不适配当前系统。
安装完成后还需从服务器启动测试服务，点击手机上的应用图标不能代替这一步。

iOS 17 以上通常需 RemoteXPC 隧道及匹配的个性化开发者镜像。挂载镜像时请解锁手机并保持
亮屏；`DeviceLocked` 表示手机仍需解锁。镜像缓存在 `./data/ios-developer-images`，容器内
包含 Apple 官方公开 Root CA，用于验证个性化授权服务的 HTTPS 证书链。

将以下命令中的 `手机UDID` 替换为设备信息中的 UDID，Bundle ID 使用实际签名安装后的值。
第一条命令保持运行，后两条在另一终端执行；每台设备同一时间运行一个控制测试服务。
容器重建或手机重启后，需重新启动隧道和 DeviceKit。

```bash
docker exec -it android-physical-web /app/vendor/go-ios/linux-x64/ios \
  --udid="手机UDID" --tunnel-info-port=28100 tunnel start --userspace \
  --pair-record-path=/var/lib/lockdown/go-ios

docker exec android-physical-web /app/vendor/go-ios/linux-x64/ios \
  --udid="手机UDID" --tunnel-info-port=28100 image auto --basedir=/data/ios-developer-images

docker exec -it android-physical-web /app/vendor/go-ios/linux-x64/ios \
  --udid="手机UDID" --tunnel-info-port=28100 runtest \
  --bundle-id=com.deviceboxhq.goios.devicekit.runner \
  --test-runner-bundle-id=com.deviceboxhq.goios.devicekit.runner \
  --xctest-config=devicekit-iosUITests.xctest
```

服务启动后，点击“连接画面”。支持 WebCodecs 的浏览器在 HTTPS 或 `http://127.0.0.1` 等
安全上下文中使用 H.264；其他环境自动回退。视频播放与触控延迟分别受编码、网络及 iOS
测试服务影响。当前真机桌面 H.264 曾测得约 27.5 FPS，Home / 点击请求约 0.5–0.7 秒。

基础 iOS 工具及依赖包、版本、校验和及许可证在 [vendor/ios/](./vendor/ios/README.md)。
已在 PVE USB 直通环境验证设备识别、信任配对、信息、用户应用列表、系统日志及热插拔恢复，
并验证 DeviceKit 签名安装、用户态隧道、开发者镜像、测试服务、画面、触控与截图。

镜像默认基于公开的 `ttyob/android-emulator:scrcpy-web-20260729` Web 运行时构建；其中不
启动 Android 模拟器。需要替换基础镜像时可设置 `BASE_IMAGE` 构建参数。

独立镜像包含 Android 9/10 的 scrcpy 无音频连接兼容补丁，避免上游 reverse 通道持续等待
不存在的音频连接。

该 Web 入口默认没有登录认证，只应部署在可信局域网。跨网访问需要在前面增加 HTTPS 和
身份认证，或通过 VPN 访问。

## 验证

修改源码后先运行内置 Node.js 测试，再重建服务：

```bash
node --test test/*.test.js
docker compose build
docker compose up -d --no-deps physical-web
```

## 停止

```bash
docker compose down
```
