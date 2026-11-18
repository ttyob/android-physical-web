# go-ios

固定版本 **v1.3.2**，用于 Linux 上的 iOS 开发者通道、开发者镜像、应用文件传输及 DeviceKit 启动。
不替代 `vendor/ios` 中用于基础配对、设备发现和应用管理的 libimobiledevice 工具。

- 上游：[danielpaulus/go-ios](https://github.com/danielpaulus/go-ios)
- 原始发行包：<https://github.com/danielpaulus/go-ios/releases/download/v1.3.2/go-ios-linux.zip>
- `linux-x64/ios` 是发行包中的 `ios-amd64`，原件使用 GitHub Release 的 SHA256 digest 校验。
- `PROVENANCE.json` 记录来源，`SHA256SUMS` 校验固化的二进制，`LICENSE` 保留 MIT 许可证。

`certs/` 固化 Apple 官网的公开 Apple Root CA，用于验证开发者镜像个性化授权服务的 HTTPS
证书链；Docker 构建时校验并加入容器的信任库。

Docker 构建时校验二进制并运行 `ios version`。容器内路径由 `GO_IOS_PATH` 指定，默认
`/app/vendor/go-ios/linux-x64/ios`。使用时始终传入所选设备的 `--udid`。

基础 USB 文件传输不需要开发者镜像。iOS 17 以上的调试服务通常需要 RemoteXPC tunnel、
个性化开发者镜像及适用的签名；可通过 `ios tunnel start --userspace` 建立用户态隧道，
避免更改宿主机路由。隧道和测试服务不随项目启动自动开启，真实设备兼容性需逐台验证。

例如，在已配对的本机 USB 设备上查看 XCTest 启动参数：

```bash
docker exec android-physical-web /app/vendor/go-ios/linux-x64/ios runtest --help
```

签名私钥、密码、描述文件及签名后的个人安装包不应放入此目录或公开下载目录。
