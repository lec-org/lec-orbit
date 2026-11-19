# Orbit（伴程）

Orbit 是 LEC（乐程）软件工作室的统一桌面工作台与 LecSSO 原生桌面认证阵地。

## 定位与边界

- **首期聚焦**：
  1. **LecPunch 原生桌面重构**：完整对齐现网 `LecPunch` API（打卡、网络白名单校验、在岗状态、记录热力图、周考核、积分卡牌、周报本地防丢草稿、团队动态与通知流），不复用 Web 端套壳。
  2. **LecDoc 内嵌工作区**：通过 Electron `WebContentsView` 内嵌 `doc.lecspace.top`，与 Orbit 原生登录共享 `persist:lec-orbit` 会话，零二次登录；支持闲置 15 分钟自动休眠与模态弹窗自动避让。
- **LecSSO 原生登录阵地**：
  - **Stage 1**：Orbit 内部直接通过 `apps/lec-sso` 内置的 Logto RFC 0004 Experience API 实现 Liquid Glass 原生弹窗登录（Handle + 密码 + TOTP），不跳外部浏览器，并同步 `sso.lecspace.top` 会话 Cookie 到共享分区。
  - **Stage 2**：注册 `lec-orbit://` 自定义协议，配合 `apps/lec-sso` 的 `LEC_ORBIT_AUTH_ENABLED` 特性开关，在外部浏览器触发登录时弹出独立预热确认窗（高敏应用可叠加 Touch ID / Windows Hello）。
- **分发与部署边界**：Orbit 属于桌面端应用，与 `LecPunch Desktop` 一致，**不触发校园 PVE K3s 自动部署**；由独立仓库 GitHub Actions 打包并发布至 Releases。

## 架构约定

- **交互体系**：以 Apple HIG + `@lec-space/liquidglass` 为主轴，表单状态清晰显式；macOS 使用原生 `hiddenInset` 左侧红绿灯，Windows 使用原生 `titleBarOverlay` 右侧窗口按钮。
- **三层存储**：
  1. `SecretStore`：Electron `safeStorage`（Keychain / DPAPI）加密保存 Refresh Token；
  2. `ConfigStore`：原子写入 JSON + Zod 校验（窗口位置、主题、提醒、环境）；
  3. `LocalDB`：内置 `node:sqlite`（WAL 模式 + 同步事务封装），保存 SWR 缓存、周报草稿、通知历史与 `LecDoc` 最近访问记录。
