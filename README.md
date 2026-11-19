# lec-orbit（Orbit · 伴程）

LEC（乐程）软件工作室统一桌面工作台与 LecSSO 原生桌面认证器。

## 技术栈

- **包管理与脚本**：Bun（`bun install`、`bun run`、`bun test`）
- **构建与热重载**：`electron-vite`（渲染进程 HMR + 主进程与 Preload 自动热重载）
- **桌面宿主与更新**：Electron 40+（`WebContentsView`、`safeStorage`、系统托盘、`lec-orbit://` 协议）、`electron-builder`、`electron-updater`（OTA 自动更新）
- **界面层**：React 19、TypeScript、CSS Modules、Zustand、Axios、Zod、`@lec-space/liquidglass`、`@lec-space/icons`
- **三层本地存储**：`safeStorage` 密文凭据 + 原子写入 JSON 配置 + 内置 `node:sqlite`（WAL 模式）

## 本地开发

```sh
cd apps/lec-orbit
bun install
bun run typecheck
bun test
bun run build
bun run dev
```

也可从平台根目录执行转发命令：`pnpm lec-orbit:typecheck`、`pnpm lec-orbit:test`、`pnpm lec-orbit:build`、`pnpm lec-orbit:dev`。

## 打包与分发

```sh
bun run pack:dir     # 快速验证打包目录完整性
bun run package:mac  # 生成 macOS arm64 / x64 dmg & zip
bun run package:win  # 生成 Windows x64 NSIS 安装包
```

安装包默认不自动上传；正式发布通过 `lec-org/lec-orbit` 的 GitHub Actions Tag 工作流发布至 Releases，并由 `electron-updater` 向桌面端推送 OTA 更新（可通过环境变量 `ORBIT_UPDATE_FEED_URL` 切换校内静态镜像源）。
