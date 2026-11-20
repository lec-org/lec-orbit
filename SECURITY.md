# 安全策略与代码签名说明 (Security & Code Signing Policy)

## 漏洞反馈

如在使用 **Orbit（伴程）** 桌面端或服务端过程中发现任何安全问题，请勿直接提交公开 Issue，请通过 GitHub Security Advisories（`lec-org/lec-orbit`）或联系 LEC 软件工作室负责人私下反馈。

## 代码签名与分发策略 (Code Signing Policy)

- **源码透明**：所有正式发布版（GitHub Releases）均由 `lec-org/lec-orbit` 公开仓库中的 `.github/workflows/release.yml` 在 GitHub Actions 托管构建机自动编译并附带 `SHA256SUMS.txt` 校验清单，杜绝本地手工构建产物上传。
- **成员身份与团队审查**：仅 `lec-org` 组织维护者有权推送受保护的发布标签（`v*`）。
- **Windows 代码签名**：计划接入 [SignPath Foundation](https://signpath.org/) 面向开源项目的免费代码签名服务（Free code signing provided by SignPath.io, certificate by SignPath Foundation）。
- **macOS 分发与校验**：提供开源一键安装脚本（`https://lec-org.github.io/lec-orbit/install.sh`，自动核对 `SHA256SUMS.txt`）与官方 Homebrew Tap（`lec-org/homebrew-tap`）。
- **隐私承诺**：Orbit 不采集任何广告遥测数据；认证凭据仅通过系统钥匙串（macOS Keychain / Windows DPAPI `safeStorage`）加密存储于本地。
