# 常见问题排错手册（FAQ）

## 1. Godot 4 / Unity 报错 `SharedArrayBuffer is not defined`

**原因**：游戏开启了 Web 多线程支持，但未在 Manifest 中开启跨源隔离。

**排查与解决**：
1. 打开 `orbit.manifest.json`，确认配置了：
   ```json
   "runtime": {
     "crossOriginIsolated": true,
     "isolationPolicy": "credentialless"
   }
   ```
2. 如果是 **Localhost 热重载调试**，勾选「本地调试 → Localhost 热重载」弹窗里的 **「注入 COOP/COEP 响应头」**。
3. 打开容器顶栏的 DevTools，在 Console 输入 `window.crossOriginIsolated`，确认返回 `true`。

---

## 2. Unity WebGL 加载 `.wasm.br` 或 `.framework.js.br` 报语法错误 / 解压失败

**原因**：
- 检查是否开启了 Unity 的 `Decompression Fallback` 导致文件被改名或双层解压；
- 检查 `index.html` 中引用的相对路径是否和 `Build/` 目录内实际文件名一致。

**排查与解决**：
1. Unity Player Settings → Publishing Settings 中：**Compression Format 选 `Brotli`（或 `Gzip`），关闭 `Decompression Fallback`**。
2. 在 DevTools → Network 面板查看 `.wasm.br` 的响应头，正常应看到：
   - `Content-Type: application/wasm`
   - `Content-Encoding: br`
3. 若仍异常，尝试用 `zip -r -0` 重新打包并清除 Orbit 工坊缓存后重试。

---

## 3. React / Vue 小程序打包后打开白屏，资源 404

**原因**：Vite / Webpack 默认将资源根路径设为绝对路径 `/assets/...` 或配置了子路径 `base`。

**解决**：
- 在 `vite.config.ts` 中将 `base` 设为 `'./'`；
- 确认 `orbit.manifest.json` 位于 `dist/` 根目录（把它放进 `public/orbit.manifest.json` 最省心）；
- 在 DevTools → Console 与 Network 面板确认 `index.html` 与 JS/CSS 是否全部返回 `200`。

---

## 4. `fetch()` 请求外部接口被浏览器拦截（Refused to connect）

**原因**：Orbit 容器默认启用了严格 CSP，未声明的外部域名禁止直接发起请求。

**解决**：
在 `orbit.manifest.json` 中显式声明目标域名：
```json
"permissions": {
  "scopes": ["user.profile", "storage.cloud"],
  "networkDomains": ["api.your-service.com"]
}
```

---

## 5. 调用 `orbitSDK.user.getCurrent()` 或 `clipboard.writeText()` 抛出权限错误

**原因**：对应能力未在 `orbit.manifest.json` 的 `permissions.scopes` 中声明。

**解决**：检查并补齐对应 scope：
- `user.profile` → `orbitSDK.user.getCurrent()`
- `storage.cloud` → `orbitSDK.storage.*`
- `clipboard` → `orbitSDK.clipboard.writeText()`

---

## 6. 在普通浏览器里预览时报错 `Cannot read properties of undefined (reading 'env')`

**原因**：直接访问了 `window.orbitSDK`，而在普通 Chrome/Safari 中没有 Orbit Preload 注入。

**解决**：引入 `apps/lec-orbit/sdk/orbit-sdk.ts` 并统一通过 `getOrbitSDK()` 访问，或先判断 `if (window.orbitSDK)`。

---

## 7. 上传 ZIP 时提示「超过 100MB」或「路径穿越」

- **体积超过 100MB**：请改用「上传 / 导入 → GitHub Releases 导入」通道（详见 [大包导入说明](/publish/packaging-and-upload#超大包体-100mb-github-releases-导入)）。
- **路径穿越 / 符号链接报错**：切勿在父级目录使用 `zip -r app.zip ../dist` 这类带 `..` 的相对路径命令，应先 `cd dist` 再执行 `zip -r ../app.zip .`；同时确保包内不含软链接（如 `node_modules` 里的符号链接）。
