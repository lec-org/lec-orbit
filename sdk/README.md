# Orbit 工坊开发指南（小程序 & Cocos / Unity / Godot 小游戏）

## 1. 必备文件：`orbit.manifest.json`

在你的 Web 构建产物根目录放入 `orbit.manifest.json`（打包成 `.zip` 或 `.lecapp` 上传，或直接用 Orbit「工坊 → 本地调试」加载目录）：

```json
{
  "schemaVersion": 1,
  "id": "my-awesome-game",
  "name": "我的工坊作品",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "godot",
  "entry": "index.html",
  "description": "一句话简介",
  "tags": ["GameJam", "动作"],
  "window": {
    "defaultMode": "standalone",
    "supportedModes": ["standalone", "sidepanel", "workspace"],
    "sidepanelWidth": 400,
    "width": 1280,
    "height": 720,
    "resizable": true,
    "allowFullscreen": true
  },
  "runtime": {
    "crossOriginIsolated": true,
    "isolationPolicy": "credentialless",
    "pointerLock": false,
    "gamepad": true
  },
  "permissions": {
    "scopes": ["user.profile", "storage.cloud"],
    "networkDomains": []
  }
}
```

## 2. 三大游戏引擎接入要点

### Godot 4
1. 导出平台选择 **Web**；若开启了 **Thread Support**（多线程），务必将 `runtime.crossOriginIsolated` 设为 `true`，Orbit 会自动为 `orbit-app://` 注入 `COOP/COEP` 启用 `SharedArrayBuffer`。
2. 复制 `sdk/engines/godot/OrbitBridge.gd` 到工程并添加为 Autoload 单例即可调用成员信息与云存档。

### Unity（2022 LTS / Unity 6）
1. Build Platform 选择 **WebGL**，Compression Format 推荐 **Brotli（`.br`）** 或 **Gzip（`.gz`）**——Orbit 容器原生自动识别 `.wasm.br` / `.js.br` / `.data.br` 并注入 `Content-Encoding` 与 `application/wasm` 流式编译头。
2. 若启用了 WebAssembly Threads，将 `runtime.crossOriginIsolated` 设为 `true`。
3. 将 `sdk/engines/unity/OrbitBridge.jslib` 放进 `Assets/Plugins/WebGL/`，`OrbitSDK.cs` 放进 `Assets/Scripts/`。

### Cocos Creator 3.x
1. 构建平台选择 **Web Desktop**（固定比例）或 **Web Mobile**（竖屏可默认 `sidepanel` 贴在软件右侧！）。
2. 复制 `sdk/orbit-sdk.ts` 与 `sdk/engines/cocos/OrbitBridge.ts` 接入成员信息与云存档。

## 3. 体积与上传规则
- **≤ 100 MB**：直接在 Orbit「工坊 → 上传 / 导入」选择 ZIP 包，直传校园 RustFS，成员首次打开自动下载并本地缓存，二次启动 0 流量秒开。
- **> 100 MB**：将构建包发到你自己的 GitHub Releases，在 Orbit「工坊 → 上传 / 导入 → GitHub Releases 导入」填入直链与 SHA256，不占用校园 FRP 带宽。
