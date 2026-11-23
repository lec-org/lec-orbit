# 安全沙箱与权限边界

Orbit 客户端保存着工作室成员的 **LecSSO 刷新令牌、全机免密授权能力与本地密钥库**。为了既让成员自由创作、又守住平台安全底线，工坊容器对所有小程序与小游戏强制实施多层隔离。

## 五层安全防线

### 1. 独立存储分区（Session Partition）
- Orbit 主工作台与 LecDoc 使用共享分区 `persist:lec-orbit`。
- **每个工坊应用强制运行在独占分区 `persist:orbit-app-<appId>`**。
- 应用内的 `localStorage`、`IndexedDB`、Cache Storage 与 Cookie 相互完全隔离，且**永远无法读取** Orbit / LecSSO / LecDoc / LecPunch 的任何会话 Cookie。

### 2. 最小权限沙箱 Preload
- 所有容器视图固定开启：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- 仅注入极简 `miniAppPreload.js`，只暴露白名单 `window.orbitSDK`。
- 主进程在响应所有 `orbit:sdk:*` IPC 时，**不信任渲染层传参**，而是直接通过 `event.sender.id` 反查真实绑定的 `appId`，彻底杜绝跨应用伪造身份读写他人云存档。

### 3. 声明式权限校验
- 敏感能力必须在 `orbit.manifest.json` 的 `permissions.scopes` 中显式声明：
  - `user.profile`：读取当前成员脱敏档案（仅 `userId / username / displayName / avatar / isAdmin`，绝不下发任何主 Access Token）。
  - `storage.cloud`：读写当前应用专属的云端 KV 存档。
  - `clipboard`：写入系统剪贴板。
- 浏览器硬件权限默认只放行游戏必需的 `pointerLock` 与 `fullscreen`，默认拒绝摄像头、麦克风与精确地理位置请求。

### 4. 内容安全策略（CSP）与外域拦截
`orbit-app://<appId>/` 文档默认注入以下引擎友好的严格 CSP：

```http
default-src 'self' data: blob:;
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:;
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline' blob:;
img-src 'self' data: blob: https:;
media-src 'self' data: blob:;
font-src 'self' data: blob:;
connect-src 'self' data: blob: <manifest.permissions.networkDomains>;
object-src 'none';
base-uri 'self';
```

::: warning 注意外部网络请求
如果你的小程序需要通过 `fetch` 或 `WebSocket` 请求某个外部接口，必须把该域名登记在 `permissions.networkDomains` 中（例如 `["api.example.com"]`），否则会被浏览器 CSP 拦截！审核上架时队长也会核对声明的外域清单。
:::

### 5. 导航与外链安全
- 容器内禁止顶层导航跳出 `orbit-app://<appId>` 源（防止恶意重定向钓鱼页）。
- 点击 `<a target="_blank">` 或调用 `window.open()` 时，Orbit 会拦截并统一交由系统默认浏览器打开。

## 跨源隔离（COOP / COEP）与 `SharedArrayBuffer`

Godot 4 多线程 Web 导出与 Unity WebAssembly Threads 强依赖浏览器的 `SharedArrayBuffer`。根据 Chromium 安全规范，只有满足 `window.crossOriginIsolated === true` 才允许使用。

在 `orbit.manifest.json` 中开启：

```json
"runtime": {
  "crossOriginIsolated": true,
  "isolationPolicy": "credentialless"
}
```

Orbit 协议层会自动附加以下响应头：
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`（或你指定的 `require-corp`）
- `Cross-Origin-Resource-Policy: same-origin`

::: tip 为什么推荐 `credentialless` 而非 `require-corp`？
`require-corp` 要求页面加载的**每一张外部图片**（例如成员的 LecSSO 头像 URL）都带有 `Cross-Origin-Resource-Policy: cross-origin` 响应头，否则图片会加载失败；而 Chromium 96+ 原生支持的 `credentialless` 在**同样完整开启 `SharedArrayBuffer`** 的前提下，能自动以无凭据模式放行第三方头像与静态图，兼容性好得多。
:::
