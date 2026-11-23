# Cocos Creator 3.x 小游戏接入指南

Orbit 容器基于 Chromium 内核（Electron 40）提供完整 WebGL2、WASM 物理引擎（Bullet / PhysX / Box2D）与标准音频/手柄能力，**无需安装任何定制小游戏插件**，使用 Cocos Creator 官方自带的 Web 构建即可直接运行。

## 1. 推荐构建配置

打开 Cocos Creator 3.8+ → **项目 → 构建发布（Project → Build）**：

| 配置项 | 横屏桌面小游戏推荐值 | 竖屏右侧栏小游戏推荐值 |
| --- | --- | --- |
| **发布平台（Platform）** | `Web Desktop` | `Web Mobile` |
| **设计分辨率适配** | 勾选 `Fit Width` 或 `Fit Height`（保持 Canvas 随窗口自适应） | 勾选 `Fit Width` |
| **内联所有 SpriteFrame** | 建议勾选（减少零碎 JSON 请求，加快首屏） | 建议勾选 |
| **合并所有 JSON** | 建议勾选 | 建议勾选 |
| **MD5 缓存** | 可关闭（Orbit 离线包按版本整体 SHA256 校验与本地缓存） | 可关闭 |
| **Source Maps** | 正式发布关闭，减小包体 | 正式发布关闭 |

点击 **构建（Build）** 后，产物通常位于 `build/web-desktop/` 或 `build/web-mobile/`。

## 2. 接入 `OrbitBridge`（身份、云存档、Toast）

从 `apps/lec-orbit/sdk/` 复制 `orbit-sdk.ts` 与 `engines/cocos/OrbitBridge.ts` 到你的 Cocos 工程 `assets/scripts/` 目录，即可在任意组件脚本中直接调用：

```ts
import { _decorator, Component, Label } from 'cc';
import { CocosOrbitBridge } from './OrbitBridge';

const { ccclass, property } = _decorator;

@ccclass('GameBootstrap')
export class GameBootstrap extends Component {
  @property(Label)
  playerLabel: Label | null = null;

  async start() {
    // 1. 读取工作室成员信息（自动免登，无需自建登录页）
    const user = await CocosOrbitBridge.getUser();
    if (this.playerLabel && user) {
      this.playerLabel.string = `玩家：${user.displayName}`;
    }

    // 2. 读取跨设备云存档
    const progress = await CocosOrbitBridge.loadData<{ level: number; bestScore: number }>('progress');
    console.log('恢复云存档:', progress);

    // 3. 监听容器形态变化（独立窗口 <-> 右侧栏无损切换）
    CocosOrbitBridge.onModeChange((mode) => {
      console.log('容器形态已切换为:', mode);
    });
  }

  async onStageCleared(level: number, score: number) {
    await CocosOrbitBridge.saveData('progress', { level, bestScore: score });
    CocosOrbitBridge.toast(`第 ${level} 关已通关，进度已同步云端！`, 'success');
  }
}
```

## 3. 添加 `orbit.manifest.json`

在构建输出目录（如 `build/web-desktop/`）根目录放入 `orbit.manifest.json`（推荐放在 Cocos 的 `build-templates/web-desktop/orbit.manifest.json`，这样每次构建会自动拷贝进去，免手动复制！）：

```json
{
  "schemaVersion": 1,
  "id": "lec-cocos-demo",
  "name": "乐程星际塔防",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "cocos",
  "entry": "index.html",
  "icon": "favicon.ico",
  "description": "使用 Cocos Creator 3.8 构建的塔防小游戏。",
  "tags": ["塔防", "Cocos"],
  "window": {
    "defaultMode": "standalone",
    "supportedModes": ["standalone", "workspace"],
    "width": 1280,
    "height": 720,
    "resizable": true,
    "aspectRatio": "16:9",
    "allowFullscreen": true
  },
  "runtime": {
    "crossOriginIsolated": false,
    "gamepad": true
  },
  "permissions": {
    "scopes": ["user.profile", "storage.cloud"],
    "networkDomains": []
  }
}
```

::: tip 小技巧：去掉 Web Desktop 顶部默认灰色标题条
Cocos `Web Desktop` 默认模板会在画面上方多画一条带标题和分辨率下拉框的网页工具栏，而在 Orbit 独立窗口中已经自带 38px 液态玻璃顶栏。你可以在 `build-templates/web-desktop/index.html` 中把默认外框删掉，让 `#GameDiv` 占满 `100vw × 100vh`，视觉会非常原生！
:::

## 4. 本地调试与打包

1. 打开 Orbit →「工坊」→「本地调试」→「本地构建目录」，直接选择 `build/web-desktop/`；
2. 每次在 Cocos 中重新 Build 后，点击 Orbit 窗口顶栏的 **刷新按钮** 即可立即生效；
3. 验收无误后，将 `build/web-desktop/` 目录整体压缩为 `.zip` 上传至工坊即可（若包体 > 100MB，参见 [GitHub Releases 导入](/publish/packaging-and-upload#超大包体-100mb-github-releases-导入)）。
