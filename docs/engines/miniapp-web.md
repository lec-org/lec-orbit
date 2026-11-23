# 小程序开发指南（Web / React / Vue / Liquid Glass）

Orbit 小程序本质上是运行在 `orbit-app://<appId>/` 沙箱中的现代 Web 应用，支持任意前端框架（React、Vue、Svelte、Solid 或原生 HTML/TS）。

## 1. 强烈推荐的视觉对齐方案

为了让你的小程序贴在 Orbit 右侧栏或主区时浑然一体，建议：
1. **接入工作室组件库**（React 工程）：安装 `@lec-space/liquidglass` 与 `@lec-space/icons`，与 Orbit 主壳保持一致的 Apple HIG 液态玻璃交互。
2. **同步 Orbit 明暗主题**：通过 `orbitSDK.env.getTheme()` 与 `onThemeChange` 实时切换浅色 / 深色模式。
3. **优先适配右侧栏窄屏（380~420px）**：先以移动端单列卡片布局为基线，在宽屏（`workspace` / `standalone`）下用 CSS Grid 自动展开为多列。

## 2. Vite 工程必备配置（避坑重点）

由于应用打包后运行在 `orbit-app://<appId>/` 下，**强烈建议配置 `base: './'`**（相对路径），避免静态资源引用路径在子路由或目录加载下出现 404：

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
```

同时，将 `orbit.manifest.json` 放在 `public/orbit.manifest.json`，这样每次执行 `vite build` 都会自动把它复制到 `dist/orbit.manifest.json`！

::: warning 路由模式建议
如果使用 `react-router` 或 `vue-router`，推荐使用 **Hash 路由（`createHashRouter` / `createWebHashHistory`）**；Orbit 协议层也支持无后缀路径的 SPA History 回退，但 Hash 路由在相对路径资源引用下更稳妥。
:::

## 3. React + `@lec-space/liquidglass` 完整接入示例

先将 `apps/lec-orbit/sdk/orbit-sdk.ts` 复制到你的项目 `src/orbit-sdk.ts`，然后编写主题与用户信息同步：

```tsx
import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Tag, zhCN } from '@lec-space/liquidglass';
import { getOrbitSDK, type OrbitDisplayMode, type OrbitTheme, type OrbitUserProfile } from './orbit-sdk';

export function App() {
  const sdk = getOrbitSDK();
  const [theme, setTheme] = useState<OrbitTheme>('light');
  const [mode, setMode] = useState<OrbitDisplayMode>('sidepanel');
  const [user, setUser] = useState<OrbitUserProfile | null>(null);

  useEffect(() => {
    void sdk.env.getInfo().then((info) => {
      setTheme(info.theme);
      setMode(info.mode);
    });
    void sdk.user.getCurrent().then(setUser);

    const offTheme = sdk.env.onThemeChange(setTheme);
    const offMode = sdk.env.onModeChange(setMode);
    return () => {
      offTheme();
      offMode();
    };
  }, [sdk]);

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{user ? `你好，${user.displayName}` : '工作室工具'}</strong>
          <Tag tone="info">{mode}</Tag>
        </div>

        <Button
          variant="filled"
          onClick={() => void sdk.ui.toast('已触发 Orbit 原生提示！', 'success')}
        >
          测试 Toast
        </Button>
      </div>
    </ConfigProvider>
  );
}
```

## 4. 本地热重载开发流

1. 在你的小程序仓库启动开发服务器：
   ```sh
   pnpm dev  # 假设监听 http://localhost:5173
   ```
2. 打开 Orbit → 左侧「工坊」→ 右上角 **「本地调试」→「Localhost 热重载」**；
3. 填入 `http://localhost:5173`、选择「右侧伴随栏」启动；
4. 改代码自动 HMR 热更新，且 `window.orbitSDK` 全量真实可用！
5. 联调完成后运行 `pnpm build`，用「本地构建目录」模式加载 `dist/` 做最终离线验收，再打包 ZIP 上传即可。
