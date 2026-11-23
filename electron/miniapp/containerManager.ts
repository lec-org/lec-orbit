/**
 * Orbit 工坊三态无损容器管理器（MiniAppContainerManager）：
 * - 独立会话分区：每个应用运行在 `persist:orbit-app-<appId>`，绝不共享 Orbit 主认证 Cookie
 * - 引擎级协议宿主：`orbit-app://<appId>/...` 自动处理 Unity `.br/.gz`、Godot 4 `SharedArrayBuffer` (COOP/COEP) 与 Cocos WebGL
 * - 三态无损切换：`sidepanel`（右侧伴随栏）↔ `workspace`（主区全幅）↔ `standalone`（独立窗口）
 *   基于 Electron 40 `WebContentsView` 跨窗迁宿（removeChildView -> addChildView），切换时零刷新、零进度丢失
 * - 基于 `event.sender.id` 的强隔离 SDK IPC 路由（防跨应用伪造 appId）
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell,
  WebContentsView,
} from 'electron';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { getOrbitEndpoints } from '../../src/shared/env';
import type { AuthState, ThemePreference } from '../../src/shared/ipc';
import {
  MiniAppDisplayModeSchema,
  OrbitAppManifestSchema,
  type MiniAppBounds,
  type MiniAppDisplayMode,
  type MiniAppLaunchDevUrlInput,
  type MiniAppLaunchInput,
  type MiniAppLaunchLocalDirInput,
  type MiniAppLaunchSource,
  type MiniAppRuntimeSnapshot,
  type OrbitAppManifest,
  type RunningMiniAppState,
} from '../../src/shared/miniapp';
import type { LocalDB } from '../storage/localDb';
import { safeSendToWindow } from '../windows/safeSend';
import type { MiniAppPackageManager } from './packageManager';
import {
  buildContainerSecurityHeaders,
  resolveAssetHeaders,
  resolveSafeBundleFile,
} from './protocolHeaders';

export const MINIAPP_PROTOCOL_SCHEME = 'orbit-app';
const STANDALONE_HEADER_HEIGHT = 38;

/** 必须在 app.whenReady() 之前调用，将 orbit-app:// 注册为安全标准协议以启用 WebGL/WASM/Fetch/SharedArrayBuffer。 */
export function registerMiniAppProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MINIAPP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: true,
      },
    },
  ]);
}

interface ActiveProtocolTarget {
  rootDir: string;
  manifest: OrbitAppManifest;
}

interface RunningMiniAppInstance {
  appId: string;
  manifest: OrbitAppManifest;
  source: MiniAppLaunchSource;
  mode: MiniAppDisplayMode;
  sidepanelWidth: number;
  iconUrl?: string;
  devUrl?: string;
  localDir?: string;
  view: WebContentsView;
  standaloneWindow: BrowserWindow | null;
  loading: boolean;
  error?: string;
}

export interface ContainerManagerDeps {
  packageManager: MiniAppPackageManager;
  localDb: LocalDB;
  getScopeKey: () => string;
  getAuthState: () => AuthState;
  getOrbitApiToken: () => Promise<string | null>;
  getMainWindow: () => BrowserWindow | null;
  showMainWindow: () => void;
  mainPreloadPath: string;
  miniAppPreloadPath: string;
  rendererEntry: { devUrl?: string; htmlPath: string; iconPath?: string };
  onToastRequested: (payload: {
    appId: string;
    appName: string;
    message: string;
    tone?: 'info' | 'success' | 'warning' | 'error';
  }) => void;
}

function isLocalhostDevUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

export class MiniAppContainerManager {
  private readonly instances = new Map<string, RunningMiniAppInstance>();
  private readonly webContentsToAppId = new Map<number, string>();
  private readonly protocolTargets = new Map<string, ActiveProtocolTarget>();
  private readonly registeredSessions = new Set<string>();
  private readonly devHeaderSessions = new Set<string>();
  private readonly runtimeListeners = new Set<(snapshot: MiniAppRuntimeSnapshot) => void>();
  private readonly closingForReparent = new WeakSet<BrowserWindow>();

  private sidepanelBounds: MiniAppBounds = { x: 0, y: 0, width: 0, height: 0 };
  private workspaceBounds: MiniAppBounds = { x: 0, y: 0, width: 0, height: 0 };
  private overlayHidden = false;
  private currentTheme: ThemePreference = 'system';
  private sdkIpcRegistered = false;

  constructor(private readonly deps: ContainerManagerDeps) {}

  private resolveEffectiveTheme(): 'light' | 'dark' {
    if (this.currentTheme === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    }
    return this.currentTheme;
  }

  onRuntimeChanged(listener: (snapshot: MiniAppRuntimeSnapshot) => void): () => void {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  }

  getRuntimeSnapshot(): MiniAppRuntimeSnapshot {
    return {
      apps: [...this.instances.values()].map((inst) => this.toState(inst)),
    };
  }

  private toState(inst: RunningMiniAppInstance): RunningMiniAppState {
    return {
      appId: inst.appId,
      name: inst.manifest.name,
      type: inst.manifest.type,
      engine: inst.manifest.engine,
      version: inst.manifest.version,
      mode: inst.mode,
      supportedModes: inst.manifest.window.supportedModes,
      sidepanelWidth: inst.sidepanelWidth,
      source: inst.source,
      crossOriginIsolated: inst.manifest.runtime.crossOriginIsolated,
      loading: inst.loading,
      error: inst.error,
      overlayHidden: this.overlayHidden,
      iconUrl: inst.iconUrl,
      devUrl: inst.devUrl,
      localDir: inst.localDir,
    };
  }

  private emitRuntimeChanged(): void {
    const snapshot = this.getRuntimeSnapshot();
    for (const listener of this.runtimeListeners) {
      listener(snapshot);
    }
    for (const inst of this.instances.values()) {
      if (inst.standaloneWindow && !inst.standaloneWindow.isDestroyed()) {
        safeSendToWindow(inst.standaloneWindow, 'orbit:hub:runtimeChanged', snapshot);
      }
    }
  }

  syncTheme(theme: ThemePreference): void {
    this.currentTheme = theme;
    const resolved = this.resolveEffectiveTheme();
    for (const inst of this.instances.values()) {
      if (!inst.view.webContents.isDestroyed()) {
        inst.view.webContents.send('orbit:sdk:event:themeChanged', resolved);
      }
      if (inst.standaloneWindow && !inst.standaloneWindow.isDestroyed()) {
        if (process.platform !== 'darwin' && typeof inst.standaloneWindow.setTitleBarOverlay === 'function') {
          inst.standaloneWindow.setTitleBarOverlay({
            color: '#00000000',
            symbolColor: resolved === 'dark' ? '#e2e8f0' : '#334155',
            height: STANDALONE_HEADER_HEIGHT,
          });
        }
      }
    }
  }

  setOverlayVisible(visible: boolean): void {
    this.overlayHidden = visible;
    this.syncMainWindowHostedViews();
    this.emitRuntimeChanged();
  }

  setSidepanelBounds(bounds: MiniAppBounds, width?: number): void {
    this.sidepanelBounds = bounds;
    if (typeof width === 'number' && width >= 320 && width <= 640) {
      const sideApp = this.findByMode('sidepanel');
      if (sideApp) {
        sideApp.sidepanelWidth = Math.round(width);
        this.deps.localDb.setAppPref(this.deps.getScopeKey(), sideApp.appId, {
          sidepanelWidth: sideApp.sidepanelWidth,
        });
      }
    }
    this.syncMainWindowHostedViews();
  }

  setWorkspaceBounds(bounds: MiniAppBounds): void {
    this.workspaceBounds = bounds;
    this.syncMainWindowHostedViews();
  }

  /** 在主进程启动后调用一次，注册面向隔离容器的受控 window.orbitSDK IPC。 */
  registerSdkIpcHandlers(): void {
    if (this.sdkIpcRegistered) return;
    this.sdkIpcRegistered = true;

    const resolveCaller = (senderId: number): RunningMiniAppInstance => {
      const appId = this.webContentsToAppId.get(senderId);
      if (!appId) {
        throw new Error('未授权的容器调用来源');
      }
      const inst = this.instances.get(appId);
      if (!inst) {
        throw new Error('容器实例已销毁');
      }
      return inst;
    };

    ipcMain.handle('orbit:sdk:env:getInfo', (event) => {
      const inst = resolveCaller(event.sender.id);
      return {
        appId: inst.appId,
        name: inst.manifest.name,
        version: inst.manifest.version,
        mode: inst.mode,
        platform: process.platform,
        theme: this.resolveEffectiveTheme(),
        crossOriginIsolated: inst.manifest.runtime.crossOriginIsolated,
        orbitVersion: app.getVersion(),
      };
    });

    ipcMain.handle('orbit:sdk:env:getTheme', (event) => {
      resolveCaller(event.sender.id);
      return this.resolveEffectiveTheme();
    });

    ipcMain.handle('orbit:sdk:user:getCurrent', (event) => {
      const inst = resolveCaller(event.sender.id);
      if (!inst.manifest.permissions.scopes.includes('user.profile')) {
        throw new Error('应用未在 manifest 中声明 user.profile 权限');
      }
      const auth = this.deps.getAuthState();
      if (!auth.authenticated || !auth.profile) return null;
      return {
        userId: auth.profile.subject,
        username: auth.profile.username,
        displayName: auth.profile.name || auth.profile.username || '工作室成员',
        avatar: auth.profile.avatar,
        isAdmin: auth.isAdmin,
      };
    });

    ipcMain.handle('orbit:sdk:storage:get', async (event, rawKey) => {
      const inst = resolveCaller(event.sender.id);
      if (!inst.manifest.permissions.scopes.includes('storage.cloud')) {
        throw new Error('应用未声明 storage.cloud 权限');
      }
      const key = z.string().trim().min(1).max(128).parse(rawKey);
      if (inst.source === 'installed') {
        const remote = await this.cloudKvGet(inst.appId, key);
        if (remote.ok) {
          if (remote.value !== null) {
            this.deps.localDb.setMiniAppKv(
              this.deps.getScopeKey(),
              inst.appId,
              key,
              JSON.stringify(remote.value),
            );
          }
          return remote.value;
        }
      }
      const cached = this.deps.localDb.getMiniAppKv(this.deps.getScopeKey(), inst.appId, key);
      if (cached === null) return null;
      try {
        return JSON.parse(cached) as unknown;
      } catch {
        return cached;
      }
    });

    ipcMain.handle('orbit:sdk:storage:set', async (event, raw) => {
      const inst = resolveCaller(event.sender.id);
      if (!inst.manifest.permissions.scopes.includes('storage.cloud')) {
        throw new Error('应用未声明 storage.cloud 权限');
      }
      const payload = z.object({ key: z.string().trim().min(1).max(128), value: z.unknown() }).parse(raw);
      const serialized = JSON.stringify(payload.value ?? null);
      if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
        throw new Error('单条存档大小不能超过 64 KB');
      }
      this.deps.localDb.setMiniAppKv(this.deps.getScopeKey(), inst.appId, payload.key, serialized);
      if (inst.source === 'installed') {
        await this.cloudKvSet(inst.appId, payload.key, payload.value);
      }
    });

    ipcMain.handle('orbit:sdk:storage:remove', async (event, rawKey) => {
      const inst = resolveCaller(event.sender.id);
      if (!inst.manifest.permissions.scopes.includes('storage.cloud')) {
        throw new Error('应用未声明 storage.cloud 权限');
      }
      const key = z.string().trim().min(1).max(128).parse(rawKey);
      this.deps.localDb.deleteMiniAppKv(this.deps.getScopeKey(), inst.appId, key);
      if (inst.source === 'installed') {
        await this.cloudKvDelete(inst.appId, key);
      }
    });

    ipcMain.handle('orbit:sdk:storage:keys', async (event) => {
      const inst = resolveCaller(event.sender.id);
      if (!inst.manifest.permissions.scopes.includes('storage.cloud')) {
        throw new Error('应用未声明 storage.cloud 权限');
      }
      if (inst.source === 'installed') {
        const remoteKeys = await this.cloudKvKeys(inst.appId);
        if (remoteKeys !== null) return remoteKeys;
      }
      return this.deps.localDb.listMiniAppKvKeys(this.deps.getScopeKey(), inst.appId);
    });

    ipcMain.handle('orbit:sdk:ui:toast', (event, raw) => {
      const inst = resolveCaller(event.sender.id);
      const payload = z
        .object({
          message: z.string().trim().min(1).max(160),
          tone: z.enum(['info', 'success', 'warning', 'error']).optional(),
        })
        .parse(raw);
      this.deps.onToastRequested({
        appId: inst.appId,
        appName: inst.manifest.name,
        message: payload.message,
        tone: payload.tone ?? 'info',
      });
    });

    ipcMain.handle('orbit:sdk:ui:requestMode', (event, rawMode) => {
      const inst = resolveCaller(event.sender.id);
      const targetMode = MiniAppDisplayModeSchema.parse(rawMode);
      if (!inst.manifest.window.supportedModes.includes(targetMode)) {
        return false;
      }
      this.switchMode(inst.appId, targetMode);
      return true;
    });

    ipcMain.handle('orbit:sdk:clipboard:writeText', (event, rawText) => {
      const inst = resolveCaller(event.sender.id);
      if (!inst.manifest.permissions.scopes.includes('clipboard')) {
        throw new Error('应用未在 manifest 中声明 clipboard 权限');
      }
      clipboard.writeText(z.string().max(50_000).parse(rawText));
    });
  }

  private async cloudKvGet(appId: string, key: string): Promise<{ ok: boolean; value: unknown }> {
    try {
      const token = await this.deps.getOrbitApiToken();
      if (!token) return { ok: false, value: null };
      const base = getOrbitEndpoints().orbitApiBase;
      const resp = await fetch(
        `${base}/api/v1/apps/${encodeURIComponent(appId)}/kv/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      );
      if (resp.status === 404) return { ok: true, value: null };
      if (!resp.ok) return { ok: false, value: null };
      const data = (await resp.json()) as { value?: unknown };
      return { ok: true, value: data.value ?? null };
    } catch {
      return { ok: false, value: null };
    }
  }

  private async cloudKvSet(appId: string, key: string, value: unknown): Promise<void> {
    try {
      const token = await this.deps.getOrbitApiToken();
      if (!token) return;
      const base = getOrbitEndpoints().orbitApiBase;
      await fetch(
        `${base}/api/v1/apps/${encodeURIComponent(appId)}/kv/${encodeURIComponent(key)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value }),
        },
      );
    } catch {
      // 离线静默降级为本地缓存
    }
  }

  private async cloudKvDelete(appId: string, key: string): Promise<void> {
    try {
      const token = await this.deps.getOrbitApiToken();
      if (!token) return;
      const base = getOrbitEndpoints().orbitApiBase;
      await fetch(
        `${base}/api/v1/apps/${encodeURIComponent(appId)}/kv/${encodeURIComponent(key)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch {
      // 忽略离线异常
    }
  }

  private async cloudKvKeys(appId: string): Promise<string[] | null> {
    try {
      const token = await this.deps.getOrbitApiToken();
      if (!token) return null;
      const base = getOrbitEndpoints().orbitApiBase;
      const resp = await fetch(`${base}/api/v1/apps/${encodeURIComponent(appId)}/kv`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { keys?: string[] };
      return Array.isArray(data.keys) ? data.keys : [];
    } catch {
      return null;
    }
  }

  private ensurePartitionProtocol(appId: string, partition: string): Electron.Session {
    const ses = session.fromPartition(partition);
    if (!this.registeredSessions.has(partition)) {
      this.registeredSessions.add(partition);

      // 精细化硬件权限：允许小游戏锁鼠标与全屏，默认拒绝麦克风/摄像头/定位等敏感权限
      ses.setPermissionRequestHandler((_wc, permission, callback) => {
        const allowed = permission === 'pointerLock' || permission === 'fullscreen';
        callback(allowed);
      });

      ses.protocol.handle(MINIAPP_PROTOCOL_SCHEME, async (request) => {
        try {
          const url = new URL(request.url);
          if (url.hostname !== appId) {
            return new Response('Forbidden cross-app host', { status: 403 });
          }
          const target = this.protocolTargets.get(appId);
          if (!target) {
            return new Response('Mini-app bundle not mounted', { status: 404 });
          }
          const filePath = resolveSafeBundleFile(target.rootDir, url.pathname, target.manifest.entry);
          if (!filePath) {
            return new Response('Not Found', { status: 404 });
          }

          const assetHeaders = resolveAssetHeaders(filePath);
          const isDocument = assetHeaders.contentType.startsWith('text/html');
          const securityHeaders = buildContainerSecurityHeaders(target.manifest, { isDocument });
          const headers = new Headers(securityHeaders);
          headers.set('Content-Type', assetHeaders.contentType);
          if (assetHeaders.contentEncoding) {
            headers.set('Content-Encoding', assetHeaders.contentEncoding);
          }
          headers.set('Cache-Control', 'no-cache');

          if (request.method === 'HEAD') {
            return new Response(null, { status: 200, headers });
          }

          const nodeStream = fs.createReadStream(filePath);
          const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
          return new Response(webStream, { status: 200, headers });
        } catch (err) {
          console.error(`[orbit:hub:protocol] failed for ${request.url}:`, err);
          return new Response('Internal Mini-App Protocol Error', { status: 500 });
        }
      });
    }
    return ses;
  }

  private ensureDevCrossOriginHeaders(partition: string, devOrigin: string, enabled: boolean): void {
    if (!enabled || this.devHeaderSessions.has(`${partition}::${devOrigin}`)) return;
    this.devHeaderSessions.add(`${partition}::${devOrigin}`);
    const ses = session.fromPartition(partition);
    ses.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Cross-Origin-Opener-Policy': ['same-origin'],
          'Cross-Origin-Embedder-Policy': ['credentialless'],
        },
      });
    });
  }

  private findByMode(mode: MiniAppDisplayMode): RunningMiniAppInstance | undefined {
    for (const inst of this.instances.values()) {
      if (inst.mode === mode) return inst;
    }
    return undefined;
  }

  private pickInitialMode(manifest: OrbitAppManifest, requested?: MiniAppDisplayMode): MiniAppDisplayMode {
    const supported = manifest.window.supportedModes;
    if (requested && supported.includes(requested)) return requested;
    const pref = this.deps.localDb.getAppPref(this.deps.getScopeKey(), manifest.id);
    if (pref.preferredMode && supported.includes(pref.preferredMode)) {
      return pref.preferredMode;
    }
    return supported.includes(manifest.window.defaultMode)
      ? manifest.window.defaultMode
      : supported[0] ?? 'workspace';
  }

  async launch(input: MiniAppLaunchInput): Promise<RunningMiniAppState> {
    const existing = this.instances.get(input.appId);
    if (existing && !input.remoteBundle) {
      if (input.mode && input.mode !== existing.mode) {
        this.switchMode(existing.appId, input.mode);
      } else {
        this.focusInstance(existing);
      }
      return this.toState(existing);
    }

    const builtin = this.deps.packageManager.findBuiltin(input.appId);
    if (builtin && !input.remoteBundle) {
      return this.mountBundle({
        manifest: builtin.manifest,
        rootDir: builtin.dirPath,
        source: 'builtin',
        requestedMode: input.mode,
      });
    }

    if (input.remoteBundle) {
      const token = await this.deps.getOrbitApiToken();
      const installed = await this.deps.packageManager.ensureRemoteInstalled({
        appId: input.appId,
        version: input.remoteBundle.version,
        bundleUrl: input.remoteBundle.bundleUrl,
        bundleSha256: input.remoteBundle.bundleSha256,
        authToken: token,
      });
      return this.mountBundle({
        manifest: installed.manifest,
        rootDir: installed.installDir,
        source: 'installed',
        requestedMode: input.mode,
        iconUrl: input.remoteBundle.iconUrl,
      });
    }

    const installed = this.deps.packageManager.getInstalled(input.appId);
    if (!installed) {
      throw new Error(`未找到已安装的应用：${input.appId}`);
    }
    return this.mountBundle({
      manifest: installed.manifest,
      rootDir: installed.installDir,
      source: 'installed',
      requestedMode: input.mode,
    });
  }

  async launchLocalDir(input: MiniAppLaunchLocalDirInput): Promise<RunningMiniAppState> {
    const manifest = this.deps.packageManager.readLocalDirManifest(input.dirPath);
    return this.mountBundle({
      manifest,
      rootDir: input.dirPath,
      source: 'local-dir',
      requestedMode: input.mode,
      localDir: input.dirPath,
    });
  }

  async launchDevUrl(input: MiniAppLaunchDevUrlInput): Promise<RunningMiniAppState> {
    if (!isLocalhostDevUrl(input.url)) {
      throw new Error('开发热重载仅允许连接本机 localhost / 127.0.0.1 地址');
    }
    const manifest = OrbitAppManifestSchema.parse({
      schemaVersion: 1,
      id: input.appId,
      name: input.name,
      version: '0.0.0-dev',
      type: input.type ?? 'miniapp',
      engine: input.engine ?? 'web',
      entry: 'index.html',
      description: `本地开发热重载 (${input.url})`,
      window: {
        defaultMode: input.mode ?? 'sidepanel',
        supportedModes: ['sidepanel', 'workspace', 'standalone'],
      },
      runtime: {
        crossOriginIsolated: Boolean(input.crossOriginIsolated),
      },
      permissions: {
        scopes: ['user.profile', 'storage.cloud', 'clipboard'],
        networkDomains: [],
      },
    });
    return this.mountBundle({
      manifest,
      devUrl: input.url,
      source: 'dev-url',
      requestedMode: input.mode,
    });
  }

  private mountBundle(params: {
    manifest: OrbitAppManifest;
    rootDir?: string;
    devUrl?: string;
    localDir?: string;
    iconUrl?: string;
    source: MiniAppLaunchSource;
    requestedMode?: MiniAppDisplayMode;
  }): RunningMiniAppState {
    const { manifest } = params;
    const appId = manifest.id;

    // 若已在运行且源路径/版本变动，先平滑关闭旧实例再重建
    if (this.instances.has(appId)) {
      this.close(appId);
    }

    const targetMode = this.pickInitialMode(manifest, params.requestedMode);
    this.evictConflictingHostSlot(targetMode, appId);

    const partition = `persist:orbit-app-${appId}`;
    this.ensurePartitionProtocol(appId, partition);
    if (params.rootDir) {
      this.protocolTargets.set(appId, { rootDir: params.rootDir, manifest });
    }
    if (params.devUrl && manifest.runtime.crossOriginIsolated) {
      this.ensureDevCrossOriginHeaders(partition, new URL(params.devUrl).origin, true);
    }

    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: this.deps.miniAppPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    const pref = this.deps.localDb.getAppPref(this.deps.getScopeKey(), appId);
    const sidepanelWidth = pref.sidepanelWidth ?? manifest.window.sidepanelWidth ?? 400;

    const instance: RunningMiniAppInstance = {
      appId,
      manifest,
      source: params.source,
      mode: targetMode,
      sidepanelWidth,
      iconUrl: params.iconUrl,
      devUrl: params.devUrl,
      localDir: params.localDir,
      view,
      standaloneWindow: null,
      loading: true,
    };

    const wc = view.webContents;
    this.instances.set(appId, instance);
    this.webContentsToAppId.set(wc.id, appId);

    this.deps.localDb.setAppPref(this.deps.getScopeKey(), appId, {
      lastOpenedAt: Date.now(),
    });

    // 安全隔离：阻止容器内部跳往未授权外域，外链走系统默认浏览器
    const allowedOrigin = params.devUrl
      ? new URL(params.devUrl).origin
      : `${MINIAPP_PROTOCOL_SCHEME}://${appId}`;

    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, navUrl) => {
      if (navUrl.startsWith(allowedOrigin)) return;
      event.preventDefault();
      if (navUrl.startsWith('https://') || navUrl.startsWith('http://')) {
        void shell.openExternal(navUrl);
      }
    });

    wc.on('did-start-loading', () => {
      instance.loading = true;
      instance.error = undefined;
      this.emitRuntimeChanged();
    });

    wc.on('did-stop-loading', () => {
      instance.loading = false;
      if (!wc.isDestroyed()) {
        wc.send('orbit:sdk:event:themeChanged', this.resolveEffectiveTheme());
        wc.send('orbit:sdk:event:modeChanged', instance.mode);
      }
      this.emitRuntimeChanged();
    });

    wc.on('did-fail-load', (_e, errorCode, errorDesc) => {
      if (errorCode === -3) return; // 忽略主动取消
      instance.loading = false;
      instance.error = `加载失败 (${errorCode}): ${errorDesc}`;
      this.emitRuntimeChanged();
    });

    const loadTarget =
      params.devUrl ??
      `${MINIAPP_PROTOCOL_SCHEME}://${appId}/${manifest.entry.replace(/^\/+/, '')}`;

    if (targetMode === 'standalone') {
      this.attachToStandaloneWindow(instance);
    } else {
      this.syncMainWindowHostedViews();
    }

    void wc.loadURL(loadTarget);
    this.emitRuntimeChanged();
    return this.toState(instance);
  }

  private evictConflictingHostSlot(targetMode: MiniAppDisplayMode, incomingAppId: string): void {
    if (targetMode === 'standalone') return;
    const conflict = this.findByMode(targetMode);
    if (conflict && conflict.appId !== incomingAppId) {
      this.close(conflict.appId);
    }
  }

  /**
   * 核心三态无损切换：同一 WebContentsView 在 主窗右侧栏 / 主窗主区 / 独立窗口 之间直接迁宿，零刷新！
   */
  switchMode(appId: string, nextMode: MiniAppDisplayMode): RunningMiniAppState | null {
    const inst = this.instances.get(appId);
    if (!inst) return null;
    if (inst.mode === nextMode) {
      this.focusInstance(inst);
      return this.toState(inst);
    }

    this.evictConflictingHostSlot(nextMode, appId);

    const prevMode = inst.mode;
    const mainWin = this.deps.getMainWindow();

    // 1. 从旧宿主摘下 WebContentsView（绝不销毁 webContents！）
    if (prevMode === 'standalone' && inst.standaloneWindow && !inst.standaloneWindow.isDestroyed()) {
      const oldWin = inst.standaloneWindow;
      inst.standaloneWindow = null;
      this.closingForReparent.add(oldWin);
      try {
        oldWin.contentView.removeChildView(inst.view);
      } catch {
        // 忽略重复移除
      }
      // 延后到下一个 tick 销毁旧独立窗，保证发起 switchMode 的 IPC 完整返回且不触发 on('closed') 销毁实例
      setImmediate(() => {
        if (!oldWin.isDestroyed()) {
          oldWin.destroy();
        }
      });
    } else if (mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.contentView.removeChildView(inst.view);
      } catch {
        // 忽略未挂载
      }
    }

    // 2. 更新模式并持久化用户偏好
    inst.mode = nextMode;
    this.deps.localDb.setAppPref(this.deps.getScopeKey(), appId, {
      preferredMode: nextMode,
    });

    // 3. 挂入新宿主
    if (nextMode === 'standalone') {
      this.attachToStandaloneWindow(inst);
    } else {
      this.deps.showMainWindow();
      this.syncMainWindowHostedViews();
    }

    if (!inst.view.webContents.isDestroyed()) {
      inst.view.webContents.send('orbit:sdk:event:modeChanged', nextMode);
    }

    this.emitRuntimeChanged();
    return this.toState(inst);
  }

  private attachToStandaloneWindow(inst: RunningMiniAppInstance): void {
    const isMac = process.platform === 'darwin';
    const resolvedTheme = this.resolveEffectiveTheme();
    const width = Math.max(380, inst.manifest.window.width);
    const height = Math.max(480, inst.manifest.window.height + STANDALONE_HEADER_HEIGHT);

    const win = new BrowserWindow({
      width,
      height,
      minWidth: 360,
      minHeight: 420,
      resizable: inst.manifest.window.resizable,
      fullscreenable: inst.manifest.window.allowFullscreen,
      title: `${inst.manifest.name} · Orbit 工坊`,
      icon: this.deps.rendererEntry.iconPath,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
      titleBarOverlay: !isMac
        ? {
            color: '#00000000',
            symbolColor: resolvedTheme === 'dark' ? '#e2e8f0' : '#334155',
            height: STANDALONE_HEADER_HEIGHT,
          }
        : undefined,
      backgroundColor: resolvedTheme === 'dark' ? '#0d1117' : '#f3f6fb',
      webPreferences: {
        preload: this.deps.mainPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    inst.standaloneWindow = win;

    const syncStandaloneViewBounds = () => {
      if (win.isDestroyed() || inst.view.webContents.isDestroyed()) return;
      const [cw, ch] = win.getContentSize();
      const topOffset = win.isFullScreen() ? 0 : STANDALONE_HEADER_HEIGHT;
      inst.view.setBounds({
        x: 0,
        y: topOffset,
        width: Math.max(0, cw),
        height: Math.max(0, ch - topOffset),
      });
    };

    const hash = `miniapp-window/${encodeURIComponent(inst.appId)}`;
    if (this.deps.rendererEntry.devUrl) {
      void win.loadURL(`${this.deps.rendererEntry.devUrl}#${hash}`);
    } else {
      void win.loadFile(this.deps.rendererEntry.htmlPath, { hash });
    }

    win.contentView.addChildView(inst.view);
    inst.view.setVisible(true);
    syncStandaloneViewBounds();

    win.once('ready-to-show', syncStandaloneViewBounds);
    win.on('resize', syncStandaloneViewBounds);
    win.on('enter-full-screen', syncStandaloneViewBounds);
    win.on('leave-full-screen', syncStandaloneViewBounds);

    win.on('minimize', () => {
      if (!inst.view.webContents.isDestroyed()) {
        inst.view.webContents.send('orbit:sdk:event:pause');
      }
    });
    win.on('restore', () => {
      if (!inst.view.webContents.isDestroyed()) {
        inst.view.webContents.send('orbit:sdk:event:resume');
      }
    });

    win.on('closed', () => {
      // 若正在无损迁回主窗口，绝不销毁实例
      if (this.closingForReparent.has(win)) return;
      if (inst.standaloneWindow === win) {
        inst.standaloneWindow = null;
        this.close(inst.appId);
      }
    });
  }

  private syncMainWindowHostedViews(): void {
    const mainWin = this.deps.getMainWindow();
    if (!mainWin || mainWin.isDestroyed()) return;

    for (const inst of this.instances.values()) {
      if (inst.mode === 'standalone') continue;
      if (inst.view.webContents.isDestroyed()) continue;

      const targetBounds =
        inst.mode === 'sidepanel' ? this.sidepanelBounds : this.workspaceBounds;
      const shouldShow =
        !this.overlayHidden && targetBounds.width > 0 && targetBounds.height > 0;
      const alreadyAttached = mainWin.contentView.children.includes(inst.view);

      if (shouldShow) {
        if (!alreadyAttached) {
          mainWin.contentView.addChildView(inst.view);
        }
        inst.view.setVisible(true);
        inst.view.setBounds(targetBounds);
      } else {
        inst.view.setVisible(false);
        if (alreadyAttached) {
          mainWin.contentView.removeChildView(inst.view);
        }
      }
    }
  }

  private focusInstance(inst: RunningMiniAppInstance): void {
    if (inst.mode === 'standalone' && inst.standaloneWindow && !inst.standaloneWindow.isDestroyed()) {
      if (inst.standaloneWindow.isMinimized()) inst.standaloneWindow.restore();
      inst.standaloneWindow.show();
      inst.standaloneWindow.focus();
    } else {
      this.deps.showMainWindow();
    }
  }

  reload(appId: string): void {
    const inst = this.instances.get(appId);
    if (!inst || inst.view.webContents.isDestroyed()) return;
    // 若为本地目录调试，刷新前顺便重读一次 manifest
    if (inst.source === 'local-dir' && inst.localDir) {
      try {
        const refreshed = this.deps.packageManager.readLocalDirManifest(inst.localDir);
        inst.manifest = refreshed;
        this.protocolTargets.set(appId, { rootDir: inst.localDir, manifest: refreshed });
      } catch {
        // 保留旧 manifest
      }
    }
    inst.view.webContents.reloadIgnoringCache();
  }

  openDevTools(appId: string): void {
    const inst = this.instances.get(appId);
    if (!inst || inst.view.webContents.isDestroyed()) return;
    inst.view.webContents.openDevTools({ mode: 'detach' });
  }

  toggleFullscreen(appId: string): void {
    const inst = this.instances.get(appId);
    if (!inst || !inst.standaloneWindow || inst.standaloneWindow.isDestroyed()) return;
    inst.standaloneWindow.setFullScreen(!inst.standaloneWindow.isFullScreen());
  }

  close(appId: string): void {
    const inst = this.instances.get(appId);
    if (!inst) return;
    this.instances.delete(appId);

    const wc = inst.view.webContents;
    if (!wc.isDestroyed()) {
      this.webContentsToAppId.delete(wc.id);
    }

    const mainWin = this.deps.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.contentView.removeChildView(inst.view);
      } catch {
        // 忽略
      }
    }

    if (inst.standaloneWindow && !inst.standaloneWindow.isDestroyed()) {
      const oldWin = inst.standaloneWindow;
      inst.standaloneWindow = null;
      this.closingForReparent.add(oldWin);
      try {
        oldWin.contentView.removeChildView(inst.view);
      } catch {
        // 忽略
      }
      oldWin.destroy();
    }

    try {
      if (!wc.isDestroyed()) {
        wc.close();
      }
    } catch {
      // 忽略关闭异常
    }

    this.emitRuntimeChanged();
  }

  /** 主窗口关闭时回收依附在主窗口上的小程序视图，保留或一并销毁全部容器。 */
  destroyMainWindowHostedApps(): void {
    for (const inst of [...this.instances.values()]) {
      if (inst.mode !== 'standalone') {
        this.close(inst.appId);
      }
    }
  }

  destroyAll(): void {
    for (const appId of [...this.instances.keys()]) {
      this.close(appId);
    }
  }
}
