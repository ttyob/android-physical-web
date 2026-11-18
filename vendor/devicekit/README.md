# DeviceKit iOS

固定 **0.0.18** 真机 Runner，提供 USB JSON-RPC 控制及 H.264 / MJPEG 视频流。

- 上游：<https://github.com/mobile-next/devicekit-ios>
- 发行版：<https://github.com/mobile-next/devicekit-ios/releases/tag/0.0.18>
- `0.0.18/devicekit-ios-runner-0.0.18.ipa` 保留原始发行包，已匹配 GitHub Release 的 SHA256 digest。
- `0.0.18/PROVENANCE.json` 记录来源及派生包的处理方式，`SHA256SUMS` 校验两个安装包。
- `LICENSE` 保留 **0.0.18 标签对应的 Apache-2.0** 许可证。

## 当前系统的测试运行库

原始 IPA 自带 Xcode 16.4 的 XCTest 库。在本项目的 iOS 27.2 真机上，进程获得测试授权后
立即退出，系统日志显示 `Failed to establish connection to the IDE` 及无效的 `_inFD` / `_outFD`。

`prepare-system-xctest.py` 移除应用根目录的内置 Apple 测试库和旧签名，生成
`devicekit-ios-runner-0.0.18-system-xctest-unsigned.ipa`。Runner 原有的动态库搜索路径会使用
已挂载开发者镜像中的 XCTest。
不修改 Runner 和 DeviceKit 测试插件的二进制，也不复制或分发开发者镜像中的库。

可从固化的原始包重复生成派生包：

```bash
python3 vendor/devicekit/prepare-system-xctest.py
```

Docker 构建验证两个包，将派生的未签名 IPA 和许可证放到 `/ios-tools/`。
该派生包依赖设备已挂载匹配的开发者镜像，不应作为无需开发环境的普通应用使用。

## 签名与启动

用适用于所选 iPhone 的证书和描述文件签名派生 IPA，并保留内部的
`PlugIns/devicekit-iosUITests.xctest`。项目不保存签名私钥、密码、描述文件或个人签名包。

完成 USB 配对、开发者模式、RemoteXPC 隧道和开发者镜像挂载后，以实际签名后的 Bundle ID
启动测试服务。例如签名时使用 `com.deviceboxhq.goios.devicekit.runner`：

```bash
docker exec -it android-physical-web /app/vendor/go-ios/linux-x64/ios \
  --udid="手机UDID" --tunnel-info-port=28100 runtest \
  --bundle-id=com.deviceboxhq.goios.devicekit.runner \
  --test-runner-bundle-id=com.deviceboxhq.goios.devicekit.runner \
  --xctest-config=devicekit-iosUITests.xctest
```

本版本的 `ios ui` 发行版未接通 `ui run` / `ui install`，使用上面的通用 `runtest` 启动。
服务启动后，在网页 iPhone 控制页点击“连接画面”。网页按选定设备的 USB 通道访问手机
12004 端口，不需要公开宿主机端口。

网页按固化版本的实际 JSON-RPC 协议发送请求。0.0.18 的 `device.io.swipe` 使用
`x1/y1/x2/y2`，滑动时长固定为 0.1 秒；go-ios 的 `ui swipe` 实现使用不同参数，不能直接
用于此 Runner。截图响应是带 `format` 和 `data` 的对象，`data` 包含 base64 data URL。

## 实测

已在 USB 直通的 iPhone 12 / iOS 27.2 上验证签名安装、XCTest 启动、JSON-RPC、屏幕尺寸、
Home 按键、点击和可解码的真实桌面 H.264 画面。一次 6 秒采样解码 166 帧（约 28 FPS），
分辨率 584 × 1266，服务器收到首帧约 165 ms。Home / 点击请求约 0.5–0.7 秒；这些数据
不是端到端交互延迟承诺，其他系统、设备和负载需另行验证。

锁屏密码页在当前 iOS 27.2 设备的原始 JPEG 中缺失键盘，仅显示壁纸。切换视频显示方式不能补回采集源中缺少的内容。网页右侧的“密码”工具可以在输入第一位前
固定当前可见键盘，保留点按操作；输入完成后点“恢复”查看实时结果，也可在手机本机完成认证。
