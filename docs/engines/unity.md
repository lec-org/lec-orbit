# Unity WebGL / WebGPU 小游戏接入指南

Orbit 容器底层针对 **Unity 2022 LTS / Unity 6 WebGL** 做了深度协议适配，开箱即用支持 **Brotli（`.br`）**、**Gzip（`.gz`）** 预压缩流式编译与 **WebAssembly Threads（`SharedArrayBuffer`）**。

## 1. 推荐 Player Settings 构建配置

打开 **File → Build Settings → WebGL → Player Settings → Publishing Settings**：

| 配置项 | 推荐值 | 说明 |
| --- | --- | --- |
| **Compression Format** | **Brotli**（首选）或 **Gzip** | Orbit `orbit-app://` 协议处理器会自动识别 `*.wasm.br` / `*.framework.js.br` / `*.data.br` 并返回精准 `Content-Type: application/wasm` + `Content-Encoding: br`，同时大幅缩小上传包体 |
| **Decompression Fallback** | **关闭（推荐）** | 因为 Orbit 协议层已原生支持标准 `Content-Encoding`，关闭可省去冗余 JS 解压器体积与启动耗时 |
| **Name Files As Hashes** | 可开启或关闭 | 两种命名方式均完全兼容 |
| **Data Caching** | 可关闭 | Orbit 已将整包持久化缓存在本地硬盘，无需浏览器二次 IndexedDB 缓存 |
| **Enable Exceptions** | `Explicitly Thrown Exceptions Only`（发布时） | 显著减小 `.wasm` 体积并提升帧率 |
| **WebGL Template** | 推荐 `Minimal` 或自定义全屏模板 | 去掉 Unity 默认页脚 Logo 栏，让 Canvas 100% 铺满 Orbit 窗口 |

### 如果启用了多线程（WebAssembly Threads）或 WebGPU
- 若在 Unity 6 / C# Jobs 中启用了多线程（需要 `SharedArrayBuffer`），务必在 `orbit.manifest.json` 中设置：
  ```json
  "runtime": {
    "crossOriginIsolated": true,
    "isolationPolicy": "credentialless"
  }
  ```
- 如果你的游戏需要 FPS 锁鼠标视角，开启 `"pointerLock": true`。

## 2. C# 接入 Orbit SDK（`.jslib` + `OrbitSDK.cs`）

仓库已为你准备好可直接拖入 Unity 工程的两份桥接脚本（位于 `apps/lec-orbit/sdk/engines/unity/`）：

1. 将 **`OrbitBridge.jslib`** 放入 `Assets/Plugins/WebGL/OrbitBridge.jslib`；
2. 将 **`OrbitSDK.cs`** 放入 `Assets/Scripts/OrbitSDK.cs`；
3. 在初始场景中创建一个空物体挂载 `OrbitSDK` 组件，在你的业务脚本中调用：

```csharp
using UnityEngine;
using LecOrbit;

public class GameManager : MonoBehaviour
{
    public OrbitSDK orbit;

    void Start()
    {
        if (OrbitSDK.IsRunningInOrbit)
        {
            orbit.RequestCurrentUser(userJson =>
            {
                Debug.Log("当前工作室成员: " + userJson);
            });

            orbit.LoadCloudData("save_v1", saveJson =>
            {
                if (!string.IsNullOrEmpty(saveJson))
                {
                    Debug.Log("恢复云存档: " + saveJson);
                }
            });
        }
    }

    public void OnWin(int score)
    {
        orbit.SaveCloudData("save_v1", $"{{\"bestScore\":{score}}}");
        orbit.ShowToast($"恭喜通关！最高分 {score} 已同步至云端", "success");
    }
}
```

## 3. 配置 `orbit.manifest.json`

在 Unity WebGL 输出目录根目录（与 `index.html`、`Build/` 同级）放入 `orbit.manifest.json`：

```text
UnityWebGLBuild/
├── orbit.manifest.json
├── index.html
├── TemplateData/
└── Build/
    ├── game.loader.js
    ├── game.framework.js.br
    ├── game.wasm.br
    └── game.data.br
```

```json
{
  "schemaVersion": 1,
  "id": "lec-unity-racer",
  "name": "乐程极速飞车",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "unity",
  "entry": "index.html",
  "description": "Unity WebGL 3D 竞速作品，采用 Brotli 压缩与云端存档。",
  "tags": ["3D", "竞速", "Unity"],
  "window": {
    "defaultMode": "standalone",
    "supportedModes": ["standalone", "workspace"],
    "width": 1280,
    "height": 720,
    "resizable": true,
    "allowFullscreen": true
  },
  "runtime": {
    "crossOriginIsolated": false,
    "pointerLock": false,
    "gamepad": true
  },
  "permissions": {
    "scopes": ["user.profile", "storage.cloud"],
    "networkDomains": []
  }
}
```

## 4. 包体优化与大包分发建议

- 优先清理 `Resources/` 目录中的未用贴图、启用贴图压缩（Crunch / ASTC / DXT）与代码裁剪（`Managed Stripping Level: Medium/High`）。
- 打包成 ZIP 时，因为 `.br` / `.gz` 文件已经高度压缩，使用 `-0`（Store 仅打包）能大幅加快解压速度：
  ```sh
  zip -r -0 ../lec-unity-racer-v1.0.0.zip .
  ```
- 若最终包体 **≤ 100 MB**：直接在 Orbit「工坊 → 上传 / 导入」上传。
- 若大型 3D 作品 **> 100 MB**：发布到你自己的 GitHub Releases，再在 Orbit 工坊通过 **「GitHub Releases 导入」** 登记直链与 SHA256，零校园带宽压力！
