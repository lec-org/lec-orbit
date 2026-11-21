/** Orbit（伴程）Electron 主进程入口：单实例锁、协议注册、三层存储、窗口管理与 IPC 编排。 */
import { app, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ChangePasswordInputSchema,
  DocBoundsSchema,
  MfaVerifyInputSchema,
  OrbitConfigPatchSchema,
  PasswordSignInInputSchema,
  UpdateAvatarUrlInputSchema,
} from '../src/shared/ipc';
import { AuthService } from './auth/authService';
import { parseOrbitProtocolUrl } from './auth/protocol';
import { LocalDocHost } from './doc/localDocHost';
import { scanNearbyWifi } from './network/wifiScanner';
import { ConfigStore } from './storage/configStore';
import { LocalDB } from './storage/localDb';
import { SecretStore } from './storage/secretStore';
import { TrayManager } from './tray/trayManager';
import { OrbitUpdater } from './updater/releaseUpdater';
import { WindowManager } from './windows/windowManager';

// 单实例锁：重复启动或 Windows 通过 lec-orbit:// 唤醒时交由已有主实例处理
app.setName('Orbit');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function resolveAppIconPath(filename: string): string | undefined {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icons', filename) : undefined,
    path.resolve(__dirname, '../../resources/icons', filename),
    path.resolve(app.getAppPath(), 'resources/icons', filename),
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const PROTOCOL_SCHEME = 'lec-orbit';
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1]!)]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

let configStore: ConfigStore;
let secretStore: SecretStore;
let localDb: LocalDB;
let localDocHost: LocalDocHost;
let authService: AuthService;
let windowManager: WindowManager;
let trayManager: TrayManager;
let updater: OrbitUpdater;

function currentScopeKey(): string {
  const sub = authService?.getState().profile?.subject || 'anonymous';
  return `campus:${sub}`;
}

function handleProtocolUrl(rawUrl: string): void {
  const parsed = parseOrbitProtocolUrl(rawUrl);
  if (!parsed) return;
  windowManager?.showApproveChallengeWindow({
    challengeId: parsed.challengeId,
    receivedAt: Date.now(),
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('orbit:auth:getState', () => authService.getState());
  ipcMain.handle('orbit:auth:signInWithPassword', (_e, raw) =>
    authService.signInWithPassword(PasswordSignInInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:auth:verifyMfa', (_e, raw) =>
    authService.verifyMfa(MfaVerifyInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:auth:signInWithEmbeddedWindow', () =>
    authService.signInWithEmbeddedWindow(windowManager.getMainWindow()),
  );
  ipcMain.handle('orbit:auth:getApiToken', (_e, rawTarget) => {
    const target = z.enum(['punch', 'orbit']).parse(rawTarget);
    return authService.getApiToken(target);
  });
  ipcMain.handle('orbit:auth:pickAndUploadAvatar', async () => {
    const win = windowManager.getMainWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: '选择新头像',
          properties: ['openFile'],
          filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        })
      : await dialog.showOpenDialog({
          title: '选择新头像',
          properties: ['openFile'],
          filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    return authService.uploadAvatarFromFile(picked.filePaths[0]);
  });
  ipcMain.handle('orbit:auth:updateAvatarUrl', (_e, raw) =>
    authService.updateAvatarUrl(UpdateAvatarUrlInputSchema.parse(raw).avatarUrl),
  );
  ipcMain.handle('orbit:auth:changePassword', (_e, raw) =>
    authService.changePassword(ChangePasswordInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:auth:signOut', async () => {
    const scope = currentScopeKey();
    const state = await authService.signOut();
    localDb.clearScope(scope);
    return state;
  });

  ipcMain.handle('orbit:doc:activate', (_e, raw) => {
    const payload = z.object({ bounds: DocBoundsSchema, url: z.string().url().optional() }).parse(raw);
    return windowManager.activateDoc(payload.bounds, payload.url);
  });
  ipcMain.handle('orbit:doc:deactivate', () => windowManager.deactivateDoc());
  ipcMain.handle('orbit:doc:setBounds', (_e, raw) =>
    windowManager.setDocBounds(DocBoundsSchema.parse(raw)),
  );
  ipcMain.handle('orbit:doc:setOverlayVisible', (_e, raw) =>
    windowManager.setOverlayVisible(z.boolean().parse(raw)),
  );
  ipcMain.handle('orbit:doc:navigate', (_e, raw) =>
    windowManager.navigateDoc(z.string().url().parse(raw)),
  );
  ipcMain.handle('orbit:doc:goBack', () => windowManager.docGoBack());
  ipcMain.handle('orbit:doc:goForward', () => windowManager.docGoForward());
  ipcMain.handle('orbit:doc:reload', () => windowManager.docReload());
  ipcMain.handle('orbit:doc:openExternal', () => windowManager.openDocExternal());
  ipcMain.handle('orbit:doc:getState', () => windowManager.getDocState());
  ipcMain.handle('orbit:doc:listRecents', (_e, rawQuery) =>
    localDb.listDocRecents(currentScopeKey(), z.string().optional().parse(rawQuery)),
  );

  ipcMain.handle('orbit:storage:getCache', (_e, rawKey) =>
    localDb.getCache(currentScopeKey(), z.string().min(1).max(120).parse(rawKey)),
  );
  ipcMain.handle('orbit:storage:setCache', (_e, raw) => {
    const payload = z.object({ key: z.string().min(1).max(120), value: z.unknown() }).parse(raw);
    localDb.setCache(currentScopeKey(), payload.key, payload.value);
  });
  ipcMain.handle('orbit:storage:getWeeklyDraft', (_e, rawWeek) =>
    localDb.getWeeklyDraft(currentScopeKey(), z.string().regex(/^\d{4}-W\d{2}$/).parse(rawWeek)),
  );
  ipcMain.handle('orbit:storage:saveWeeklyDraft', (_e, raw) => {
    const payload = z
      .object({ week: z.string().regex(/^\d{4}-W\d{2}$/), content: z.string().max(100_000) })
      .parse(raw);
    return localDb.saveWeeklyDraft(currentScopeKey(), payload.week, payload.content);
  });
  ipcMain.handle('orbit:storage:clearUserCache', () => {
    localDb.clearScope(currentScopeKey());
  });

  ipcMain.handle('orbit:system:getConfig', () => configStore.get());
  ipcMain.handle('orbit:system:updateConfig', (_e, rawPatch) => {
    const prev = configStore.get();
    const next = configStore.update(OrbitConfigPatchSchema.parse(rawPatch));
    if (prev.theme !== next.theme) {
      windowManager.syncTheme(next.theme);
    }
    if (prev.globalShortcut !== next.globalShortcut) {
      trayManager.registerShortcut(next.globalShortcut);
    }
    if (prev.floatingBallEnabled !== next.floatingBallEnabled) {
      windowManager.syncFloatingBallEnabled(next.floatingBallEnabled);
      trayManager.setFloatingBallEnabled(next.floatingBallEnabled);
    }
    if (prev.autoLaunch !== next.autoLaunch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch });
    }
    return next;
  });
  ipcMain.handle('orbit:system:openExternal', (_e, rawUrl) => {
    const url = z.string().url().parse(rawUrl);
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      throw new Error('仅允许打开 HTTP/HTTPS 链接。');
    }
    return shell.openExternal(url);
  });
  ipcMain.handle('orbit:system:copyText', (_e, rawText) => {
    clipboard.writeText(z.string().max(50_000).parse(rawText));
  });
  ipcMain.handle('orbit:system:notify', (_e, raw) => {
    const payload = z.object({ title: z.string().min(1).max(120), body: z.string().max(400) }).parse(raw);
    if (Notification.isSupported()) {
      const notif = new Notification({ title: payload.title, body: payload.body });
      notif.on('click', () => {
        windowManager.showMainWindow();
      });
      notif.show();
    }
  });
  ipcMain.handle('orbit:system:updateTrayPunch', (_e, raw) => {
    const summary = z
      .object({
        checkedIn: z.boolean(),
        elapsedSeconds: z.number().min(0),
        todaySeconds: z.number().min(0).optional(),
        weekSeconds: z.number().min(0).optional(),
        weekTargetSeconds: z.number().min(0).optional(),
        networkAllowed: z.boolean().optional(),
        authenticated: z.boolean().optional(),
        statusLabel: z.string().max(60),
      })
      .parse(raw);
    trayManager.updatePunchSummary(summary);
    windowManager.updateFloatingPunchSummary(summary);
  });
  ipcMain.handle('orbit:system:scanWifi', (_e, raw) => {
    const options = z
      .object({
        samples: z.number().int().min(1).max(5).optional(),
        force: z.boolean().optional(),
      })
      .optional()
      .parse(raw);
    return scanNearbyWifi(options);
  });
  ipcMain.handle('orbit:system:getUpdateState', () => updater.getState());
  ipcMain.handle('orbit:system:checkUpdate', () => updater.check());
  ipcMain.handle('orbit:system:downloadUpdate', () => updater.download());
  ipcMain.handle('orbit:system:installUpdate', () => updater.installAndRestart());

  // 来自内嵌 LecDoc 的极简只读桥接事件（同步页面上下文 & 触发原生申请编辑权弹窗）
  ipcMain.on('orbit:doc-bridge:pageContext', (_e, raw) => {
    const parsed = z
      .object({
        pageId: z.string().max(128).optional(),
        pageSlug: z.string().max(256).optional(),
        pageTitle: z.string().max(256).optional(),
        canEdit: z.boolean().optional(),
        spaceName: z.string().max(128).optional(),
      })
      .safeParse(raw);
    if (parsed.success) {
      windowManager.updateDocPageContext(parsed.data);
    }
  });

  ipcMain.on('orbit:doc-bridge:requestEdit', (_e, raw) => {
    const parsed = z
      .object({
        pageId: z.string().max(128).optional(),
        pageSlug: z.string().max(256).optional(),
        pageTitle: z.string().max(256).optional(),
        reason: z.string().max(500).optional(),
      })
      .safeParse(raw);
    if (parsed.success) {
      windowManager.getMainWindow()?.webContents.send('orbit:doc:editRequestTriggered', parsed.data);
    }
  });

  ipcMain.handle('orbit:approve:getChallenge', (_e, rawId) =>
    authService.fetchApproveChallenge(z.string().min(16).max(128).parse(rawId)),
  );
  ipcMain.handle('orbit:approve:decide', (_e, raw) => {
    const payload = z
      .object({
        challengeId: z.string().min(16).max(128),
        action: z.enum(['approve', 'deny']),
      })
      .parse(raw);
    return authService.submitApproveDecision(payload.challengeId, payload.action);
  });
  ipcMain.handle('orbit:approve:closeWindow', () => windowManager.closeApproveWindow());
  ipcMain.handle('orbit:approve:promptBiometric', async (_e, rawReason) => {
    const reason = z.string().min(1).max(120).parse(rawReason);
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  });

  ipcMain.handle('orbit:floating:getState', () => windowManager.getFloatingState());
  ipcMain.handle('orbit:floating:setExpanded', (_e, raw) =>
    windowManager.setFloatingBallExpanded(z.boolean().parse(raw)),
  );
  ipcMain.handle('orbit:floating:moveTo', (_e, raw) => {
    const pos = z.object({ x: z.number(), y: z.number() }).parse(raw);
    windowManager.moveFloatingBall(pos.x, pos.y);
  });
  ipcMain.handle('orbit:floating:snapToEdge', () => windowManager.snapFloatingBallToEdge());
  ipcMain.handle('orbit:floating:togglePunch', () => {
    windowManager.getMainWindow()?.webContents.send('orbit:system:quickPunch');
  });
  ipcMain.handle('orbit:floating:openMain', () => {
    windowManager.setFloatingBallExpanded(false);
    windowManager.showMainWindow();
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.on('second-instance', (_event, argv) => {
  const protocolArg = argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
  if (protocolArg) {
    handleProtocolUrl(protocolArg);
    return;
  }
  windowManager?.showMainWindow();
});

let cleanedUp = false;
function cleanupBeforeQuit(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // 退出阶段忽略单步清理异常，避免 Electron 弹出未捕获异常框
    }
  };
  safe(() => windowManager?.markQuitting());
  safe(() => windowManager?.destroyFloatingBallWindow());
  safe(() => updater?.stopAutoCheck());
  safe(() => localDocHost?.stop());
  safe(() => authService?.dispose());
  safe(() => trayManager?.dispose());
  safe(() => localDb?.close());
}

app.on('before-quit', () => {
  cleanupBeforeQuit();
});

app.on('activate', () => {
  windowManager?.showMainWindow();
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  // macOS Dock 图标与原生应用菜单栏（保证 Dock 图标常驻、Cmd+Tab 可见、聚焦窗口时左上角显示 Orbit）
  if (process.platform === 'darwin') {
    if (app.dock) {
      const dockIconPath = resolveAppIconPath('dock-icon.png') ?? resolveAppIconPath('icon.png');
      if (dockIconPath) {
        const dockImage = nativeImage.createFromPath(dockIconPath);
        if (!dockImage.isEmpty()) {
          app.dock.setIcon(dockImage);
        }
      }
      void app.dock.show();
    }
    const macMenu = Menu.buildFromTemplate([
      {
        label: 'Orbit',
        submenu: [
          { role: 'about', label: '关于 Orbit' },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏 Orbit' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          {
            label: '退出 Orbit',
            accelerator: 'Command+Q',
            click: () => {
              windowManager?.markQuitting();
              app.quit();
            },
          },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'forceReload', label: '强制重新加载' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '进入全屏幕' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' },
          { role: 'close', label: '关闭窗口' },
        ],
      },
    ]);
    Menu.setApplicationMenu(macMenu);
  }

  // 按环境配置渲染进程 CSP：放行 blob:（卡牌鉴权图片）与 orbit.lecspace.top（Go 后端与 WS）
  const isDevRenderer = Boolean(process.env.ELECTRON_RENDERER_URL);
  const cspHeader = isDevRenderer
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://sso.lecspace.top https://punch.lecspace.top https://doc.lecspace.top https://orbit.lecspace.top wss://orbit.lecspace.top http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://sso.lecspace.top https://punch.lecspace.top https://doc.lecspace.top https://orbit.lecspace.top wss://orbit.lecspace.top;";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspHeader],
      },
    });
  });

  const userDataDir = app.getPath('userData');
  configStore = new ConfigStore(userDataDir);
  secretStore = new SecretStore(userDataDir);
  localDb = new LocalDB(userDataDir);
  localDocHost = new LocalDocHost();
  await localDocHost.start();
  authService = new AuthService(secretStore, configStore);
  updater = new OrbitUpdater({
    onBeforeInstall: () => {
      cleanupBeforeQuit();
    },
  });

  // electron-vite 输出结构：out/main/index.js、out/preload/index.js、out/preload/docPreload.js、out/renderer/index.html
  const preloadPath = path.join(__dirname, '../preload/index.js');
  const docPreloadPath = path.join(__dirname, '../preload/docPreload.js');
  const htmlPath = path.join(__dirname, '../renderer/index.html');
  const appIconPath = resolveAppIconPath('icon.png');
  windowManager = new WindowManager(
    configStore,
    localDb,
    currentScopeKey,
    () => authService.getState().authenticated,
    preloadPath,
    docPreloadPath,
    localDocHost,
    {
      devUrl: process.env.ELECTRON_RENDERER_URL,
      htmlPath,
      iconPath: appIconPath,
    },
    async (challengeId) => {
      try {
        await authService.submitApproveDecision(challengeId, 'approve');
        return true;
      } catch (err) {
        console.error('[orbit:main] silent approveInternalDocSignIn failed:', err);
        return false;
      }
    },
  );

  trayManager = new TrayManager({
    onShowMain: () => windowManager.showMainWindow(),
    onQuickPunch: () => windowManager.getMainWindow()?.webContents.send('orbit:system:quickPunch'),
    onToggleFloatingBall: () => {
      const next = configStore.update({
        floatingBallEnabled: !configStore.get().floatingBallEnabled,
      });
      windowManager.syncFloatingBallEnabled(next.floatingBallEnabled);
      trayManager.setFloatingBallEnabled(next.floatingBallEnabled);
    },
    onQuit: () => {
      windowManager.markQuitting();
      app.quit();
    },
  });

  registerIpcHandlers();

  authService.onStateChanged((state) => {
    windowManager.onAuthSessionUpdated(state.authenticated);
    windowManager.updateFloatingPunchSummary({
      ...windowManager.getFloatingState(),
      authenticated: state.authenticated,
    });
    windowManager.getMainWindow()?.webContents.send('orbit:auth:stateChanged', state);
  });
  windowManager.onDocStateChanged((state) => {
    windowManager.getMainWindow()?.webContents.send('orbit:doc:stateChanged', state);
  });
  updater.onStateChanged((state) => {
    windowManager.getMainWindow()?.webContents.send('orbit:system:updateState', state);
  });

  const initialCfg = configStore.get();
  windowManager.syncTheme(initialCfg.theme);
  windowManager.createMainWindow();
  trayManager.init(initialCfg.globalShortcut);
  trayManager.setFloatingBallEnabled(initialCfg.floatingBallEnabled);
  windowManager.syncFloatingBallEnabled(initialCfg.floatingBallEnabled);
  updater.startAutoCheck();
  await authService.restoreSession();
});
