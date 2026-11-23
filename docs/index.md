---
layout: home

hero:
  name: Orbit 工坊
  text: 乐程工作室小程序与小游戏容器
  tagline: 一次标准 Web / WebGL 构建，原生运行于 macOS 与 Windows 的 Orbit 桌面工作台。支持 React、Vue、Cocos、Unity 与 Godot 4。
  image:
    src: /orbit-icon.png
    alt: Orbit 图标
  actions:
    - theme: brand
      text: 10 分钟快速开始
      link: /guide/getting-started
    - theme: alt
      text: 游戏引擎接入指南
      link: /engines/godot
    - theme: alt
      text: SDK API 参考
      link: /api/orbit-sdk

features:
  - icon: 🪟
    title: 三态无损切换容器
    details: 支持「右侧伴随栏 ↔ 主区全幅 ↔ 独立窗口」一键互切，底层复用同一 WebContentsView，切换时不刷新页面、不丢失游戏进度或表单输入。
  - icon: 🎮
    title: 原生兼容三大游戏引擎
    details: 协议层自动识别 Unity Brotli/Gzip 预压缩资源、按需注入 COOP/COEP 启用 Godot 4 多线程 SharedArrayBuffer，并完整支持 WebGL2、WASM 与手柄。
  - icon: 🛡️
    title: 强隔离安全沙箱
    details: 每个应用独占 persist:orbit-app-<appId> 存储分区与最小权限 Preload，绝不共享 Orbit 主认证 Cookie，同时提供严格 CSP 与外链拦截。
  - icon: ☁️
    title: 零运维托管云存档
    details: 通过 window.orbitSDK.storage 一行代码读写跨设备漫游的云端 KV 存档（单应用单人 1MB 配额），开发工具与小游戏无需自建后端。
  - icon: 🚀
    title: 本地热重载调试台
    details: 在 Orbit「工坊 → 本地调试」直接挂载本地构建目录（Cocos/Unity/Godot）或 localhost 开发服务器，附带独立 Chromium DevTools。
  - icon: 📦
    title: 双源离线秒开分发
    details: ≤100MB 构建包直传校园 RustFS，超大作品支持 GitHub Releases 链接导入；客户端首次下载 SHA256 校验后本地缓存，二次启动 0 流量秒开。
---
