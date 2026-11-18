# Apple Root CA

Apple 个性化开发者镜像授权服务 `https://gs.apple.com/TSS/controller` 的证书链使用
Apple Root CA。Debian 的通用 CA 集合未包含这张根证书，因此项目在容器内安装此公开根证书，
保持 HTTPS 的证书和主机名校验。

- 官方来源：<https://www.apple.com/appleca/AppleIncRootCertificate.cer>
- Apple 证书列表：<https://www.apple.com/certificateauthority/>
- 证书 SHA256 指纹：`B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24`
- `AppleRootCA.crt` 是官网 DER 证书转换后的 PEM；构建时使用 `SHA256SUMS` 校验文件。

这是 Apple 的公开根证书，不包含用户签名证书或私钥。宿主机的 CA 信任库不会被修改。
