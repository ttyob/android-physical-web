# HDC 工具

`linux-x64/` 固定保存本项目使用的 Linux x86_64 HDC 工具及配套 `libusb_shared.so`，
构建和运行不需要宿主机安装 HarmonyOS SDK。

- HDC 版本：`3.2.0b`
- 来源：HarmonyOS SDK API 20，Toolchains `6.0.0.47`（Beta1）
- 源目录：`/opt/harmony-sdk/sdk/20/toolchains`
- `oh-uni-package.json`：原始 SDK 组件版本信息
- `NOTICE.txt`：原始 SDK 声明
- `SHA256SUMS`：二进制、配套库及原始说明的 SHA-256 校验值

在工具目录中可验证文件完整性和版本：

```bash
cd linux-x64
sha256sum -c SHA256SUMS
./hdc -v
```

该工具使用 glibc、libstdc++ 和 libatomic；容器已安装所需运行库。HDC 使用的配套 USB
库和工具放在同一目录。更新工具时应一起更新库、SDK 版本信息、声明和校验值，并重新验证。
