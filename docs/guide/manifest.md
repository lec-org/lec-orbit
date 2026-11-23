# `orbit.manifest.json` 完整规范

`orbit.manifest.json` 是每个工坊小程序与小游戏的唯一元数据清单，必须位于构建包（或本地调试目录）的根路径下。Orbit 客户端与服务端（`lec-orbit-server`）都会对其进行强 Schema 校验。

## 完整字段一览

| 字段路径 | 类型 | 必填 | 默认值 | 说明与校验规则 |
| --- | --- | --- | --- | --- |
| `schemaVersion` | `1` | 否 | `1` | 协议版本号，当前固定为 `1` |
| `id` | `string` | **是** | — | 全局唯一应用 ID（slug），正则 `^[a-z0-9][a-z0-9-]*[a-z0-9]$`，长度 `2~64` |
| `name` | `string` | **是** | — | 工坊大厅与窗口标题显示名称，长度 `1~48` 字 |
| `version` | `string` | **是** | — | 语义化版本号（SemVer），例如 `1.0.0`、`1.2.0-beta.1` |
| `type` | `'miniapp' \| 'minigame'` | 否 | `'miniapp'` | 应用类型：`miniapp`（效率小程序）或 `minigame`（创意小游戏） |
| `engine` | `'web' \| 'cocos' \| 'unity' \| 'godot' \| 'other'` | 否 | `'web'` | 渲染/构建引擎类型，用于大厅徽章与筛选 |
| `entry` | `string` | 否 | `'index.html'` | 入口 HTML 相对路径，禁止 `/` 开头或包含 `..` |
| `icon` | `string` | 否 | — | 图标相对路径（推荐 256×256 PNG/WEBP/SVG，≤ 2MB），上传 ZIP 时服务端会自动提取到 RustFS |
| `description` | `string` | 否 | `""` | 简介文案，最长 `400` 字 |
| `tags` | `string[]` | 否 | `[]` | 自定义标签，最多 `8` 个，每个不超过 `24` 字 |

### `window` 窗口形态配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `window.defaultMode` | `'sidepanel' \| 'workspace' \| 'standalone'` | `'workspace'`（小游戏建议 `'standalone'`） | 用户首次点击「打开」时的默认展示形态 |
| `window.supportedModes` | `Array<'sidepanel' \| 'workspace' \| 'standalone'>` | `["sidepanel", "workspace", "standalone"]` | 允许用户无损切换的目标形态列表，至少保留 1 项 |
| `window.sidepanelWidth` | `number` | `400` | 右侧伴随栏初始宽度（像素），范围 `320 ~ 640` |
| `window.width` | `number` | `1120` | 独立窗口初始内容宽度（像素），范围 `360 ~ 2560` |
| `window.height` | `number` | `720` | 独立窗口初始内容高度（不含 38px 顶栏），范围 `480 ~ 1600` |
| `window.resizable` | `boolean` | `true` | 独立窗口是否允许自由缩放 |
| `window.aspectRatio` | `string` | — | 可选纵横比标记，例如 `"16:9"`、`"9:16"` |
| `window.allowFullscreen` | `boolean` | `true` | 独立窗口是否允许进入全屏模式 |

### `runtime` 运行时与引擎能力配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `runtime.crossOriginIsolated` | `boolean` | `false` | **关键**：设为 `true` 时，Orbit 会自动为 `orbit-app://<id>/` 注入 `COOP` + `COEP` 响应头，开启 `SharedArrayBuffer`（**Godot 4 多线程 / Unity WebAssembly Threads 必开**） |
| `runtime.isolationPolicy` | `'credentialless' \| 'require-corp'` | `'credentialless'` | `COEP` 策略。推荐默认 `credentialless`，既支持 `SharedArrayBuffer` 又不易拦截第三方头像图 |
| `runtime.pointerLock` | `boolean` | `false` | 是否允许申请鼠标指针锁定（第一人称视角 3D 游戏常用） |
| `runtime.gamepad` | `boolean` | `true` | 是否使用标准 Gamepad API 手柄输入 |
| `runtime.minOrbitVersion` | `string` | — | 可选最低 Orbit 客户端版本要求 |

### `permissions` 沙箱权限声明

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `permissions.scopes` | `Array<'user.profile' \| 'storage.cloud' \| 'clipboard'>` | `["user.profile", "storage.cloud"]` | 声明需要调用的 `window.orbitSDK` 能力范围；未声明的敏感 API 会被主进程直接拒绝 |
| `permissions.networkDomains` | `string[]` | `[]` | 允许通过 `fetch` / `WebSocket` 访问的外部域名白名单（最多 16 个），例如 `["api.github.com"]` |

## 推荐配置模板

::: code-group

```json [手机宽度右侧栏小程序]
{
  "schemaVersion": 1,
  "id": "lec-dev-toolbox",
  "name": "乐程研发工具箱",
  "version": "1.0.0",
  "type": "miniapp",
  "engine": "web",
  "entry": "index.html",
  "icon": "assets/icon.png",
  "description": "贴靠在 Orbit 右侧的 JSON / JWT / 时间戳效率工具。",
  "tags": ["效率工具", "研发"],
  "window": {
    "defaultMode": "sidepanel",
    "supportedModes": ["sidepanel", "workspace", "standalone"],
    "sidepanelWidth": 390,
    "width": 440,
    "height": 720,
    "resizable": true,
    "allowFullscreen": false
  },
  "runtime": {
    "crossOriginIsolated": false
  },
  "permissions": {
    "scopes": ["user.profile", "storage.cloud", "clipboard"],
    "networkDomains": []
  }
}
```

```json [Godot / Unity 独立窗小游戏]
{
  "schemaVersion": 1,
  "id": "lec-star-survivor",
  "name": "星轨幸存者",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "godot",
  "entry": "index.html",
  "icon": "icon.png",
  "description": "Godot 4 多线程 WebGL 弹幕生存小游戏，支持手柄与云存档。",
  "tags": ["动作", "GameJam"],
  "window": {
    "defaultMode": "standalone",
    "supportedModes": ["standalone", "sidepanel", "workspace"],
    "sidepanelWidth": 420,
    "width": 1280,
    "height": 720,
    "resizable": true,
    "aspectRatio": "16:9",
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

:::
