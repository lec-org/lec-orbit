# 打包、上传与审核发布

Orbit 工坊目前**仅限 `lec-studio` 组织内部成员使用**。所有作品在客户端首次打开时下载、校验 SHA256 并持久化缓存到本地磁盘，**二次打开 0 流量秒开**。

## 1. 打包规范（`.zip` / `.lecapp`）

将构建输出目录打包为标准 ZIP 文件（扩展名 `.zip` 或 `.lecapp` 均可）。

### 目录结构要求
- 压缩包根目录需包含 `orbit.manifest.json` 与声明的 `entry` 入口文件（如 `index.html`）；
- **贴心兼容**：如果你在 macOS Finder 或 Windows 资源管理器中直接「右键压缩文件夹」产生了单层包装目录（例如 `my-app/orbit.manifest.json`），Orbit 客户端与服务端都会**自动识别并剥离单层目录**，不会报错；
- 系统会自动忽略 `__MACOSX/` 与 `.DS_Store` 噪声文件。

### 安全红线（触发即被拦截）
- 禁止包含 `../` 路径穿越或绝对路径；
- 禁止包含符号链接（Symlink）；
- 压缩包内文件总数不超过 **5,000** 个；
- 解压后总体积不超过 **250 MB**（RustFS 直传渠道）或 **800 MB**（GitHub Releases 大包渠道）。

### 推荐命令行打包方式

::: code-group

```sh [普通前端 / Cocos / Godot]
cd dist/
zip -r ../my-app-v1.0.0.zip . -x "*.DS_Store" "__MACOSX/*"
```

```sh [Unity WebGL（已含 .br / .gz，建议 -0 免二次压缩）]
cd UnityWebGLBuild/
zip -r -0 ../my-unity-game-v1.0.0.zip . -x "*.DS_Store" "__MACOSX/*"
```

:::

---

## 2. 两种上传与分发通道

### 通道 A：直接上传 ZIP（≤ 100 MB，推荐默认）

适合所有小程序与中小型游戏：

1. 打开 Orbit →「工坊」→ 右上角 **「上传 / 导入」**；
2. 切到 **「上传 ZIP / .lecapp（≤ 100MB）」**，点击「选择构建包」——客户端会立即离线预检 `orbit.manifest.json`、版本与体积；
3. 选择发布通道：
   - **仅体验版（`preview`）**：仅作者本人和队长可见，适合先验证线上云存档与下载链路；
   - **提交正式上架（`release`）**：上传后自动向队长推送 Orbit 审核通知；
4. 填写本次更新日志，点击 **「校验并上传」**，构建包将直传至校园统一 RustFS。

### 超大包体（> 100MB）：GitHub Releases 导入

考虑到校园生产服务器经过公网 FRP 隧道转发，为避免大型 3D 作品（例如 150~400MB 的 Unity/Godot 游戏）打满校园出口带宽，超过 100MB 的作品请走 **GitHub Releases 导入**：

1. 将打包好的 `.zip` 上传到你的 GitHub 仓库 Release 资产中，复制下载直链（格式如 `https://github.com/<org>/<repo>/releases/download/v1.0.0/game.zip`）；
2. 在终端计算该 ZIP 的 64 位 SHA256 校验值：

   ::: code-group
   ```sh [macOS / Linux]
   shasum -a 256 game.zip
   ```
   ```powershell [Windows PowerShell]
   Get-FileHash .\game.zip -Algorithm SHA256
   ```
   :::

3. 打开 Orbit →「工坊」→「上传 / 导入」→ 切到 **「GitHub Releases 导入（大包）」**；
4. 依次填入 **Release ZIP 直链**、**64 位 SHA256**、以及粘贴对应的 **`orbit.manifest.json`** 内容，提交即可！
5. 其他成员打开时，Orbit 会直连 GitHub Releases CDN 拉取并按 SHA256 严格验签后缓存到本地，**完全不走校园服务器带宽**。

---

## 3. 版本审核与更新治理

```text
上传/导入 ──▶ 体验版 (preview) ──▶ 提交正式上架 (pending) ──▶ 队长审核通过 (published)
                                          │
                                          └──▶ 驳回 (rejected) ──▶ 修改后重传新版本
```

- **归属权保护**：应用 `id` 首次创建后自动绑定作者账号，其他人不能覆盖你的 `id`（队长拥有兜底管理权限）。
- **队长审核**：队长可在「工坊 → 待审核」标签页先点击「打开」亲自试玩，再一键 **「批准上架」** 或 **「驳回」**，审核结果会通过 Orbit WebSocket 实时推送给作者。
- **静默缓存与版本升级**：当你发布 `1.1.0` 并审核通过后，成员再次点击打开时，Orbit 检测到版本号或 SHA256 变化会自动下载新包并清理旧版本目录；若版本号未变，直接本地秒开。
- **本地空间清理**：成员随时可在工坊顶部点击 **「清缓存」** 一键释放所有已下载的离线包空间。
