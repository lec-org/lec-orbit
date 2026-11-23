# Godot 4 小游戏接入指南

Godot 4 对 Web / WebAssembly 导出非常友好，唯一让许多开发者头疼的门槛是 **多线程导出所需的 `SharedArrayBuffer` 与 `COOP/COEP` 隔离头**——Orbit 容器已经在 `orbit-app://` 协议层原生解决，一键开启即可流畅运行。

## 1. 导出预设配置（Export Preset）

打开 Godot 4 → **项目 → 导出（Project → Export）→ 添加 Web 预设**：

| 配置项 | 推荐值 | 说明 |
| --- | --- | --- |
| **渲染方式（Rendering Method）** | `gl_compatibility`（Compatibility） | Web 导出基于 WebGL 2.0，务必使用 Compatibility 渲染器（Forward+ / Mobile 不支持 Web） |
| **Thread Support（线程支持）** | 按需开启或关闭 | - **开启（Godot 4.0~4.4 多线程 / 高品质音频）**：需在 `orbit.manifest.json` 设置 `runtime.crossOriginIsolated: true`<br/>- **关闭（Godot 4.3+ 单线程模式）**：兼容性最好，是否开启 `crossOriginIsolated` 均可运行 |
| **Canvas Resize Policy** | `Adaptive`（2） | 确保在独立窗口、全屏与右侧栏之间无损切换时画面自动居中铺满 |
| **Focus Canvas on Start** | 勾选 | 启动后直接响应键盘方向键 / WASD，无需先点一下鼠标 |
| **导出主文件名** | `index.html` | 保持入口文件为 `index.html` |

::: tip 窗口拉伸推荐设置
在 **项目设置 → 显示 → 窗口（Display → Window）** 中，推荐将 `Stretch → Mode` 设为 `canvas_items`、`Aspect` 设为 `keep` 或 `expand`，这样即便用户把你的游戏「贴回 Orbit 右侧栏」也能保持清晰不形变。
:::

## 2. GDScript 接入 `OrbitBridge`（Autoload 单例）

从 `apps/lec-orbit/sdk/engines/godot/OrbitBridge.gd` 复制脚本到工程中，并在 **项目设置 → 全局（Autoload）** 中将其注册为单例 `OrbitBridge`：

```gdscript
# 在任意场景脚本中调用 OrbitBridge
extends Node2D

func _ready() -> void:
	if OrbitBridge.is_in_orbit():
		OrbitBridge.user_loaded.connect(_on_user_loaded)
		OrbitBridge.theme_changed.connect(_on_theme_changed)
		OrbitBridge.request_current_user()

func _on_user_loaded(user: Dictionary) -> void:
	var display_name: String = user.get("displayName", "玩家")
	$HUD/PlayerLabel.text = "欢迎，" + display_name

func _on_theme_changed(theme: String) -> void:
	print("Orbit 主题切换为：", theme)

func _on_game_over(score: int) -> void:
	OrbitBridge.save_cloud_kv("best_score", score)
	OrbitBridge.toast("本局得分 %d，已写入云存档！" % score, "success")
```

## 3. 配置 `orbit.manifest.json`

在 Godot 导出目录中（与 `index.html`、`index.wasm`、`index.pck` 同级）放置 `orbit.manifest.json`：

```text
GodotWebExport/
├── orbit.manifest.json
├── index.html
├── index.js
├── index.wasm
├── index.pck
├── index.audio.worklet.js
└── index.icon.png
```

```json
{
  "schemaVersion": 1,
  "id": "lec-godot-dungeon",
  "name": "像素地牢探险",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "godot",
  "entry": "index.html",
  "icon": "index.icon.png",
  "description": "Godot 4 制作的 Roguelike 像素地牢，支持手柄与多线程音频。",
  "tags": ["像素", "Godot", "手柄"],
  "window": {
    "defaultMode": "standalone",
    "supportedModes": ["standalone", "sidepanel", "workspace"],
    "sidepanelWidth": 420,
    "width": 1152,
    "height": 648,
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

## 4. 验证多线程 `SharedArrayBuffer` 是否生效

1. 在 Orbit「工坊 → 本地调试 → 本地构建目录」中选择 Godot 导出目录并启动；
2. 点击顶栏 **虫子图标（DevTools）**，在 Console 中输入：
   ```js
   window.crossOriginIsolated
   // 预期返回 true
   ```
3. 同时顶栏会出现绿色盾牌 **`SAB`** 标识，代表 `COOP/COEP` 已正确注入，Godot 4 多线程 Worker 与 AudioWorklet 均可满血运行。
