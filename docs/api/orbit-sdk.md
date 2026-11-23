# `window.orbitSDK` API 参考

在 Orbit 工坊容器内运行时，沙箱 Preload 会自动向全局注入只读对象 `window.orbitSDK`（当前版本 `1.0.0`）。
如果你使用 TypeScript 或需要在普通浏览器中也能无报错预览，推荐直接引入 `apps/lec-orbit/sdk/orbit-sdk.ts` 的 `getOrbitSDK()`，它会在非 Orbit 环境下自动降级到 `localStorage` 与模拟用户。

## 基础属性

```ts
window.orbitSDK.sdkVersion // '1.0.0'
window.orbitSDK.isOrbit    // true（浏览器降级封装中为 false）
```

---

## `env` — 运行环境与主题/形态事件

### `env.getInfo()`
返回当前容器的完整运行时上下文。

```ts
const info = await window.orbitSDK.env.getInfo();
```

返回值类型 `OrbitEnvInfo`：

```ts
interface OrbitEnvInfo {
  appId: string;
  name: string;
  version: string;
  mode: 'sidepanel' | 'workspace' | 'standalone';
  platform: 'darwin' | 'win32' | 'linux' | string;
  theme: 'light' | 'dark';
  crossOriginIsolated: boolean;
  orbitVersion: string;
}
```

### `env.getTheme()`
获取当前解析后的有效外观主题（`'light' | 'dark'`）。

### `env.onThemeChange(listener)`
监听 Orbit 外观切换（含系统跟随深浅色变化），返回取消订阅函数：

```ts
const off = window.orbitSDK.env.onThemeChange((theme) => {
  document.documentElement.dataset.theme = theme;
});
// 组件卸载时调用 off()
```

### `env.onModeChange(listener)`
监听用户在「右侧伴随栏 / 主区全幅 / 独立窗口」之间无损切换，返回取消订阅函数：

```ts
const off = window.orbitSDK.env.onModeChange((mode) => {
  console.log('已无损切换至：', mode);
});
```

---

## `user` — 当前成员信息

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"user.profile"`。

### `user.getCurrent()`
获取当前已登录 LecSSO 成员的脱敏档案（未登录时返回 `null`）：

```ts
interface OrbitUserProfile {
  userId: string;      // LecSSO 唯一主体 ID（适合作为业务主键）
  username?: string;   // 账号 Handle
  displayName: string; // 工作室统一展示名
  avatar?: string;     // 头像 URL
  isAdmin: boolean;    // 是否为工作室队长
}

const user = await window.orbitSDK.user.getCurrent();
```

::: warning 安全约束
`user.getCurrent()` 仅返回展示所需的脱敏字段，**绝不暴露** LecSSO Refresh Token 或主应用 Access Token。
:::

---

## `storage` — 零运维托管云存档（KV）

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"storage.cloud"`。

每个应用在每个成员账号下拥有独立的键值存储空间：
- **线上已上架应用**：自动同步至 `lec-orbit-server`（PostgreSQL）并在本地 SQLite 缓存，换电脑登录自动漫游；断网时自动降级读写本地缓存。
- **本地调试 / 内置示例**：直接持久化到 Orbit 本地 SQLite（`mini_app_kv_cache`），开发联调零配置。
- **容量配额**：单条记录序列化后上限 **64 KB**；单应用单人总配额 **1 MB**。键名长度 `1~128` 字符。

### 方法列表

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `storage.get` | `<T = unknown>(key: string) => Promise<T \| null>` | 读取指定键对应的 JSON 值，不存在返回 `null` |
| `storage.set` | `(key: string, value: unknown) => Promise<void>` | 写入任意可 JSON 序列化的值（覆盖更新） |
| `storage.remove` | `(key: string) => Promise<void>` | 删除指定键 |
| `storage.keys` | `() => Promise<string[]>` | 列出当前用户在本应用下的全部已存键名（升序） |

### 示例

```ts
await window.orbitSDK.storage.set('save-slot-1', {
  stage: 4,
  hp: 85,
  inventory: ['shield', 'potion'],
});

const slot = await window.orbitSDK.storage.get<{ stage: number; hp: number }>('save-slot-1');
const allKeys = await window.orbitSDK.storage.keys();
await window.orbitSDK.storage.remove('save-slot-1');
```

---

## `ui` — 宿主界面交互

### `ui.toast(message, tone?)`
触发一条 Orbit 主壳原生的液态玻璃提示（自动避让右侧伴随栏）：

```ts
await window.orbitSDK.ui.toast('关卡数据已保存', 'success');
// tone 可选：'info' | 'success' | 'warning' | 'error'，默认 'info'
```

### `ui.requestMode(mode)`
主动请求宿主将当前容器切换至指定形态（仅当目标形态在 `manifest.window.supportedModes` 内时生效，返回 `boolean`）：

```ts
const ok = await window.orbitSDK.ui.requestMode('standalone');
```

---

## `clipboard` — 系统剪贴板

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"clipboard"`。

### `clipboard.writeText(text)`
将纯文本写入系统剪贴板（单次上限 `50,000` 字符）：

```ts
await window.orbitSDK.clipboard.writeText(formattedJson);
await window.orbitSDK.ui.toast('已复制到剪贴板', 'success');
```

---

## `lifecycle` — 窗口生命周期事件

### `lifecycle.onPause(listener)` / `lifecycle.onResume(listener)`
独立窗口最小化或恢复时触发，适合暂停游戏渲染循环与背景音乐：

```ts
const offPause = window.orbitSDK.lifecycle.onPause(() => pauseGame());
const offResume = window.orbitSDK.lifecycle.onResume(() => resumeGame());
```
