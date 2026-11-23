# 三态窗口与无损切换

Orbit 工坊最核心的体验设计是 **「应用声明默认形态 + 用户自由无损互切」**。无论小程序还是小游戏，都可以在以下三种形态之间无缝流转：

| 形态 | 典型尺寸 | 最佳适用场景 | 生命周期特点 |
| --- | --- | --- | --- |
| **右侧伴随栏（`sidepanel`）** | 宽 `320~640px`（默认 `400px`），高随主窗 | 手机比例小程序、番茄钟、翻译、研发工具箱、竖屏休闲小游戏 | 固定在 Orbit 主窗最右侧，切换左侧「今日专注 / 团队文档 / 通知中心」时**持续存活不中断** |
| **主区全幅（`workspace`）** | 占满主窗内容区 | 算法可视化、复杂表单、调试面板、团队协作看板 | 类似内嵌 LecDoc 的沉浸体验，适合大视野交互 |
| **独立窗口（`standalone`）** | 按 `window.width × height` 初始化，可全屏 | 横屏 / 3D 小游戏（Cocos / Unity / Godot）、需拖到副屏多开的工具 | 独立 `BrowserWindow` + 38px 液态玻璃顶栏，支持全屏与同时多开多个独立窗口 |

## 无损切换是如何实现的？

在 Electron 40 底层，同一应用在 `sidepanel`、`workspace` 和 `standalone` 下使用的是**同一个 `WebContentsView` 实例**。当用户点击顶栏「弹出独立窗」或「贴回右侧」时：

1. 主进程把该 `WebContentsView` 从旧窗口的 `contentView` 摘下，直接挂入新宿主的 `contentView`；
2. 仅触发标准的 `window.resize` 事件，并向应用推送 `orbitSDK.env.onModeChange(nextMode)`；
3. **不刷新页面、不重新加载 WASM / 纹理、不丢失当前关卡进度或表单输入**；
4. 自动按 `appId` 记住用户的个人形态偏好与右侧栏拖拽宽度。

## 开发者适配最佳实践

### 1. 监听形态变化微调布局

如果你的小程序同时支持 `sidepanel`（窄屏）和 `workspace`（宽屏），建议同时利用 **CSS 响应式断点** 和 **`onModeChange`** 回调：

```ts
import { getOrbitSDK } from './orbit-sdk';

const sdk = getOrbitSDK();

function applyLayout(mode: 'sidepanel' | 'workspace' | 'standalone') {
  document.documentElement.dataset.orbitMode = mode;
}

sdk.env.getInfo().then((info) => applyLayout(info.mode));
sdk.env.onModeChange(applyLayout);
```

### 2. 游戏画布必须响应 `resize`

小游戏从 `1280×720` 独立窗口切到 `420px` 右侧栏（或进入全屏）时，视口宽高会瞬间变化：
- **Canvas / Three.js**：监听 `window.addEventListener('resize', ...)` 重算 `canvas.width/height` 与 `devicePixelRatio`。
- **Cocos / Unity / Godot**：确保工程启用了自适应缩放策略（例如 Godot 的 `Stretch Mode: canvas_items` + `Aspect: keep`，Cocos 的 `Fit Width / Fit Height` 或 `Show All`）。

### 3. 限制不支持的形态

如果一款重型横屏 3D FPS 游戏在 `400px` 窄侧栏里完全没法操作，可在 `orbit.manifest.json` 中显式收窄 `supportedModes`：

```json
"window": {
  "defaultMode": "standalone",
  "supportedModes": ["standalone", "workspace"],
  "width": 1280,
  "height": 720
}
```

配置后，Orbit 界面上将自动隐藏该应用的「贴回右侧」入口。

### 4. 处理最小化暂停（省电护航）

当用户最小化独立游戏窗口时，Orbit 会自动触发 `lifecycle.onPause`，恢复时触发 `lifecycle.onResume`。建议在游戏主循环中接入暂停逻辑与静音：

```ts
sdk.lifecycle.onPause(() => {
  gameLoop.pause();
  audioEngine.muteAll();
});

sdk.lifecycle.onResume(() => {
  gameLoop.resume();
  audioEngine.unmuteAll();
});
```
