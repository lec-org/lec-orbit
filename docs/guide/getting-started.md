# 10 分钟快速开始

Orbit 工坊是乐程软件工作室（LEC）内置在 Orbit 桌面工作台中的**内部小程序与小游戏运行容器**。只要你的项目能导出为标准 Web 静态产物（HTML + JS + CSS + WASM/WebGL），无需任何原生 C++ 交叉编译，即可在 macOS（Apple Silicon / Intel）和 Windows 的 Orbit 中一键运行。

## 前置准备

1. 安装并登录最新版 **Orbit 桌面客户端**（仅限 `lec-studio` 组织正式成员）。
2. 确认你的项目可构建为静态 Web 目录（前端框架 React/Vue/Vite、原生 HTML，或 Cocos / Unity / Godot 的 Web 导出）。

## 第一步：创建最小工程结构

新建一个目录（例如 `hello-orbit/`），只需两个文件即可在 Orbit 中运行：

```text
hello-orbit/
├── orbit.manifest.json   # 必备：应用元数据、窗口形态与权限声明
└── index.html            # 必备：应用入口页面
```

### 1. 编写 `orbit.manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "lec-hello-demo",
  "name": "你好 Orbit",
  "version": "1.0.0",
  "type": "miniapp",
  "engine": "web",
  "entry": "index.html",
  "description": "我的第一个 Orbit 右侧伴随栏小程序",
  "tags": ["入门示例"],
  "window": {
    "defaultMode": "sidepanel",
    "supportedModes": ["sidepanel", "workspace", "standalone"],
    "sidepanelWidth": 390,
    "width": 480,
    "height": 720,
    "resizable": true,
    "allowFullscreen": false
  },
  "runtime": {
    "crossOriginIsolated": false,
    "isolationPolicy": "credentialless",
    "pointerLock": false,
    "gamepad": false
  },
  "permissions": {
    "scopes": ["user.profile", "storage.cloud"],
    "networkDomains": []
  }
}
```

### 2. 编写 `index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>你好 Orbit</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      }
      html[data-theme="dark"] body {
        background: #0d1117;
        color: #f1f5f9;
      }
      button {
        padding: 8px 14px;
        border-radius: 10px;
        border: none;
        background: #0a84ff;
        color: #fff;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <h2 id="greeting">正在连接 Orbit 容器…</h2>
    <p id="modeText"></p>
    <button id="saveBtn">点击计数 +1（云存档）</button>

    <script>
      const sdk = window.orbitSDK;
      let count = 0;

      async function main() {
        const [info, user, saved] = await Promise.all([
          sdk.env.getInfo(),
          sdk.user.getCurrent(),
          sdk.storage.get('clicks'),
        ]);
        document.documentElement.dataset.theme = info.theme;
        document.getElementById('greeting').textContent = `你好，${user?.displayName ?? '游客'}！`;
        document.getElementById('modeText').textContent = `当前容器形态：${info.mode}`;

        count = typeof saved === 'number' ? saved : 0;
        const btn = document.getElementById('saveBtn');
        btn.textContent = `点击计数：${count}`;
        btn.onclick = async () => {
          count += 1;
          btn.textContent = `点击计数：${count}`;
          await sdk.storage.set('clicks', count);
          await sdk.ui.toast(`已保存到云端：${count}`, 'success');
        };

        sdk.env.onThemeChange((t) => (document.documentElement.dataset.theme = t));
        sdk.env.onModeChange((m) => (document.getElementById('modeText').textContent = `当前容器形态：${m}`));
      }

      if (sdk) void main();
    </script>
  </body>
</html>
```

## 第二步：在 Orbit 中本地加载调试

1. 打开 Orbit，点击左侧导航栏 **「工坊」**；
2. 点击右上角 **「本地调试」**：
   - **静态构建目录模式（推荐给 Cocos / Unity / Godot）**：点击「选择应用目录」选中 `hello-orbit/`，选择启动形态后点击「在容器中运行」。之后每次重新导出构建，点容器顶栏的 **刷新按钮** 即可立刻重载。
   - **Localhost 热重载模式（推荐给 React / Vue / Vite）**：先启动本地 `vite dev`，填入 `http://localhost:5173`，即可享受完整 HMR 与 `window.orbitSDK` 真实环境联调。
3. 点击容器顶栏的 **虫子图标（DevTools）** 可打开独立的 Chromium 开发者工具查看 Console / Network / Memory。

## 第三步：验证三态无损切换

应用运行后，点击顶栏的 **「弹出独立窗口」** 或 **「贴回右侧」** 按钮：
- 观察你刚点的计数按钮：**数值原封不动保留**，页面不会刷新！
- 试着切换 Orbit 左侧的「今日专注」「团队文档」，右侧伴随栏会持续保持存活。

::: tip 接下来看什么？
- 查阅完整的 [`orbit.manifest.json` 规范](/guide/manifest)
- 根据你使用的技术栈直接跳转：
  - [小程序（Web / React / Liquid Glass）](/engines/miniapp-web)
  - [Cocos Creator 3.x 接入指南](/engines/cocos)
  - [Unity WebGL / WebGPU 接入指南](/engines/unity)
  - [Godot 4 接入指南](/engines/godot)
:::
