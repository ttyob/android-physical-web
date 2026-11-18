# 固定的 iOS 真机工具（Linux x86_64）

`linux-x64/packages/` 保存实际 Debian 二进制安装包及本镜像新增的依赖，约 4.8 MB。
构建直接校验并安装这些本地 `.deb`，不会在线获取另一个版本的 iOS 工具，也不依赖
宿主机安装的 iTunes、Xcode 或 libimobiledevice。

| 工具包 | 固定版本 | 主要命令 |
| --- | --- | --- |
| libimobiledevice-utils | 1.3.0+git20250228-2 | idevice_id、ideviceinfo、idevicepair、idevicesyslog、idevicescreenshot |
| ideviceinstaller | 1.1.1+git20240518-1+b1 | 用户应用列表、IPA 安装、卸载 |
| usbmuxd | 1.1.1-6+deb13u1 | 本机 USB 多路复用服务 |
| libusbmuxd-tools | 2.1.0-1+b1 | iproxy、inetcat（随工具包提供，暂未接入页面） |

下载时间：2026-10-29。来源为 Debian 13 trixie、trixie-security 的官方仓库
`https://deb.debian.org/debian` 和 `https://deb.debian.org/debian-security`，通过
Debian 签名软件包索引解析依赖并下载。适用于项目当前 Debian 13 amd64 基础镜像；
不适用于直接在 Rocky Linux 宿主机或 ARM 机器上安装。

- [`linux-x64/VERSIONS.tsv`](./linux-x64/VERSIONS.tsv)：全部 30 个包的名称、版本、架构。
- [`linux-x64/SHA256SUMS`](./linux-x64/SHA256SUMS)：原始二进制包 SHA-256。
- [`linux-x64/licenses/`](./linux-x64/licenses/)：各包原始版权与许可证说明；完整文档也保留在安装包内。
- 上游与源码：<https://github.com/libimobiledevice/libimobiledevice>、
  <https://github.com/libimobiledevice/ideviceinstaller>、
  <https://github.com/libimobiledevice/usbmuxd>、
  <https://github.com/libimobiledevice/libusbmuxd>。
  Debian 对应源码可按各包版权声明中的 Source 和 `VERSIONS.tsv` 的版本从
  <https://sources.debian.org/> / <https://snapshot.debian.org/> 查找。

校验：

```bash
cd vendor/ios/linux-x64
sha256sum -c SHA256SUMS
```

安装后工具位于容器 `/usr/bin/`，原始安装包保留在
`/app/vendor/ios/linux-x64/packages/`。例如：

```bash
docker compose exec physical-web idevice_id -l
docker compose exec physical-web ideviceinfo -u '<UDID>'
docker compose exec physical-web idevicepair -u '<UDID>' pair
```

工具支持基本设备协议，不等于支持全部系统版本的开发者服务。`idevicescreenshot`
需要已挂载的开发者镜像，本次未接入 iOS 17 及以上的截图通道，也未提供开发者镜像下载、
挂载或 CoreDevice 隧道。页面不会宣称此类设备可以截图。
