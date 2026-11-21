/**
 * 集中式窗口管理器与布局协调器（借鉴 VS Code WindowsMainService + AFFiNE WebContentsView + Ferdium 休眠机制）：
 * - 管理主工作台窗口（自适应 macOS hiddenInset / Windows titleBarOverlay）
 * - 管理内嵌 LecDoc 的 WebContentsView（共享 persist:lec-orbit、闲置休眠、域名白名单）
 * - 解决 Electron 经典痛点：渲染层打开 Cmd+K / Dialog / Sheet 时自动隐藏 WebContentsView 避免层级遮挡
 * - 预热 Stage 2 独立全机 SSO 授权浮窗，做到光标所在显示器 <50ms 居中弹出
 */
import { app, BrowserWindow, nativeTheme, screen, shell, WebContentsView } from 'electron';
import path from 'node:path';
import { getOrbitEndpoints } from '../../src/shared/env';
import type {
  ApproveChallengeEvent,
  DocBounds,
  DocPageContext,
  DocViewState,
  FloatingBallState,
  ThemePreference,
  TrayPunchSummary,
} from '../../src/shared/ipc';
import { ORBIT_SHARED_PARTITION } from '../auth/authService';
import type { LocalDocHost } from '../doc/localDocHost';
import type { ConfigStore } from '../storage/configStore';
import type { LocalDB } from '../storage/localDb';
import { getAliveWindow, safeSendToWindow } from './safeSend';
import {
  centerOnDisplay,
  MIN_MAIN_HEIGHT,
  MIN_MAIN_WIDTH,
  resolveSafeWindowBounds,
} from './windowState';

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private mainWindowReady = false;
  private approveWindow: BrowserWindow | null = null;
  private floatingWindow: BrowserWindow | null = null;
  private floatingExpanded = false;
  private floatingSummary: TrayPunchSummary = {
    checkedIn: false,
    elapsedSeconds: 0,
    todaySeconds: 0,
    weekSeconds: 0,
    weekTargetSeconds: 18 * 3600,
    networkAllowed: true,
    authenticated: false,
    statusLabel: '未打卡',
  };
  private docView: WebContentsView | null = null;
  private docActive = false;
  private docOverlayHidden = false;
  private docBounds: DocBounds = { x: 0, y: 0, width: 0, height: 0 };
  private docLastUrl: string;
  private docTitle = 'LecDoc';
  private docLoading = false;
  private docHibernated = false;
  private docAutoSsoAttempted = false;
  private docOrbitBridgeAttempted = false;
  private docOrbitBridgeInFlight = false;
  private docPageContext: DocPageContext | null = null;
  private currentTheme: ThemePreference = 'system';
  private hibernateTimer: NodeJS.Timeout | null = null;
  private boundsSaveTimer: NodeJS.Timeout | null = null;
  private isQuitting = false;
  private readonly docStateListeners = new Set<(state: DocViewState) => void>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly localDb: LocalDB,
    private readonly getScopeKey: () => string,
    private readonly isAuthenticated: () => boolean,
    private readonly preloadPath: string,
    private readonly docPreloadPath: string,
    private readonly localDocHost: LocalDocHost,
    private readonly rendererEntry: { devUrl?: string; htmlPath: string; iconPath?: string },
    private readonly approveInternalDocSignIn?: (challengeId: string) => Promise<boolean>,
  ) {
    this.docLastUrl = getOrbitEndpoints().docWebUrl;
  }

  private getDocActiveOrigin(): string {
    return this.localDocHost.getLocalOrigin() || getOrbitEndpoints().docWebUrl;
  }

  private isDocAppOrigin(url: string): boolean {
    const localOrigin = this.localDocHost.getLocalOrigin();
    if (localOrigin && url.startsWith(localOrigin)) return true;
    return url.startsWith(getOrbitEndpoints().docWebUrl);
  }

  updateDocPageContext(ctx: DocPageContext | null): void {
    this.docPageContext = ctx;
    if (ctx?.pageTitle) {
      this.docTitle = ctx.pageTitle;
    }
    this.emitDocState();
  }

  onAuthSessionUpdated(authenticated: boolean): void {
    this.docAutoSsoAttempted = false;
    this.docOrbitBridgeAttempted = false;
    if (authenticated && this.docView && !this.docView.webContents.isDestroyed()) {
      const url = this.docView.webContents.getURL();
      const canonical = this.localDocHost.toCanonicalUrl(url);
      const endpoints = getOrbitEndpoints();
      if (canonical.startsWith(`${endpoints.docWebUrl}/login`)) {
        this.docAutoSsoAttempted = true;
        void this.docView.webContents.loadURL(
          `${endpoints.docWebUrl}/api/auth/lec-sso/login?redirect=/`,
        );
      } else if (url.startsWith(`${endpoints.ssoEndpoint}/sign-in`)) {
        void this.maybeAutoBridgeDocSignIn(this.docView.webContents, url);
      }
    }
  }

  /**
   * 自愈式静默 SSO 桥接：当内嵌 LecDoc 跳到 sso.lecspace.top/sign-in（例如 _session 过期、升级前未同步或 Cookie 丢失）
   * 且 Orbit 主进程本身已持有有效 LecSSO 凭证时，复用线上已启用的 /api/lec/orbit-auth/challenges 机制
   * 仅针对 doc.lecspace.top 自动完成静默签发与消费，免去用户二次输入密码，同时顺带刷新 persist:lec-orbit 的 _session。
   */
  private async maybeAutoBridgeDocSignIn(wc: Electron.WebContents, currentUrl: string): Promise<boolean> {
    const endpoints = getOrbitEndpoints();
    if (
      this.docOrbitBridgeAttempted ||
      this.docOrbitBridgeInFlight ||
      !this.isAuthenticated() ||
      !this.approveInternalDocSignIn ||
      !currentUrl.startsWith(`${endpoints.ssoEndpoint}/sign-in`)
    ) {
      return false;
    }

    this.docOrbitBridgeAttempted = true;
    this.docOrbitBridgeInFlight = true;
    try {
      const challenge = (await wc.executeJavaScript(
        `(async () => {
          const res = await fetch('/api/lec/orbit-auth/challenges', {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          if (!res.ok) return null;
          return await res.json();
        })()`,
      )) as { challengeId?: string; clientHost?: string; riskLevel?: string } | null;

      if (!challenge?.challengeId) {
        return false;
      }

      // 严格校验挑战目标必须是内嵌 LecDoc（doc.lecspace.top）且非高危应用，绝不静默批准其他站点
      const expectedDocHost = new URL(endpoints.docWebUrl).host;
      if (challenge.clientHost !== expectedDocHost || challenge.riskLevel !== 'normal') {
        console.warn('[orbit:doc-sso] skipped auto-bridge for unexpected target:', {
          clientHost: challenge.clientHost,
          riskLevel: challenge.riskLevel,
        });
        return false;
      }

      const approved = await this.approveInternalDocSignIn(challenge.challengeId);
      if (!approved || wc.isDestroyed()) {
        return false;
      }

      const consumed = (await wc.executeJavaScript(
        `(async () => {
          const res = await fetch('/api/lec/orbit-auth/challenges/${encodeURIComponent(challenge.challengeId)}/consume', {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          if (!res.ok) return null;
          return await res.json();
        })()`,
      )) as { status?: string; redirectTo?: string } | null;

      if (consumed?.status === 'approved' && consumed.redirectTo && !wc.isDestroyed()) {
        console.info('[orbit:doc-sso] silently bridged LecDoc SSO via Orbit desktop token');
        void wc.loadURL(consumed.redirectTo);
        return true;
      }
      return false;
    } catch (err) {
      console.error('[orbit:doc-sso] silent SSO bridge failed:', err);
      return false;
    } finally {
      this.docOrbitBridgeInFlight = false;
    }
  }

  /** 将 Orbit 的浅色 / 深色 / 跟随系统偏好同步给 Electron nativeTheme、Windows 标题栏三键、内嵌 LecDoc 及悬浮球。 */
  syncTheme(theme: ThemePreference): void {
    this.currentTheme = theme;
    nativeTheme.themeSource = theme;
    this.applyTitleBarOverlay();
    this.applyThemeToDocView();
    this.emitFloatingState();
  }

  private applyTitleBarOverlay(): void {
    if (process.platform === 'darwin') return;
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const isDark = nativeTheme.shouldUseDarkColors;
    win.setBackgroundColor(isDark ? '#0d1117' : '#f3f6fb');
    if (typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: isDark ? '#e2e8f0' : '#334155',
        height: 36,
      });
    }
  }

  private applyThemeToDocView(): void {
    const wc = this.docView?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const currentUrl = wc.getURL();
    if (!this.isDocAppOrigin(currentUrl)) return;

    wc.send('orbit:doc-bridge:themeChanged', this.currentTheme);

    const mantinePref = this.currentTheme === 'system' ? 'auto' : this.currentTheme;
    const resolved =
      this.currentTheme === 'system'
        ? nativeTheme.shouldUseDarkColors
          ? 'dark'
          : 'light'
        : this.currentTheme;

    const script = `(() => {
      try {
        window.localStorage.setItem('mantine-color-scheme-value', ${JSON.stringify(mantinePref)});
        document.documentElement.setAttribute('data-mantine-color-scheme', ${JSON.stringify(resolved)});
        window.dispatchEvent(new StorageEvent('storage', { key: 'mantine-color-scheme-value', newValue: ${JSON.stringify(mantinePref)} }));
      } catch {}
    })();`;
    void wc.executeJavaScript(script).catch(() => undefined);
  }

  getMainWindow(): BrowserWindow | null {
    return getAliveWindow(this.mainWindow);
  }

  markQuitting(): void {
    this.isQuitting = true;
  }

  onDocStateChanged(listener: (state: DocViewState) => void): () => void {
    this.docStateListeners.add(listener);
    return () => this.docStateListeners.delete(listener);
  }

  private emitDocState(): void {
    const state = this.getDocState();
    for (const listener of this.docStateListeners) {
      listener(state);
    }
  }

  getDocState(): DocViewState {
    const wc = this.docView?.webContents;
    const rawUrl = wc && !wc.isDestroyed() ? wc.getURL() || this.docLastUrl : this.docLastUrl;
    return {
      active: this.docActive,
      mounted: Boolean(this.docView),
      hibernated: this.docHibernated,
      overlayHidden: this.docOverlayHidden,
      url: this.localDocHost.toCanonicalUrl(rawUrl),
      title: this.docTitle,
      canGoBack: Boolean(wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()),
      canGoForward: Boolean(wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()),
      loading: this.docLoading,
      hostMode: this.localDocHost.getMode(),
      pageContext: this.docPageContext,
    };
  }

  createMainWindow(): BrowserWindow {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.showMainWindow();
      return this.mainWindow;
    }

    const cfg = this.configStore.get();
    const displays = screen.getAllDisplays().map((d) => d.workArea);
    const primary = screen.getPrimaryDisplay().workArea;
    const safeBounds = resolveSafeWindowBounds(cfg.windowBounds, displays, primary);
    const isMac = process.platform === 'darwin';

    const win = new BrowserWindow({
      x: safeBounds.x,
      y: safeBounds.y,
      width: safeBounds.width,
      height: safeBounds.height,
      minWidth: MIN_MAIN_WIDTH,
      minHeight: MIN_MAIN_HEIGHT,
      show: false,
      title: 'Orbit · 伴程',
      icon: this.rendererEntry.iconPath,
      // Apple HIG：macOS 左侧红绿灯 + 液态玻璃原生 vibrancy；Windows 统一 36px 顶部标题栏 + 动态明暗三键
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
      titleBarOverlay: !isMac
        ? {
            color: '#00000000',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#e2e8f0' : '#334155',
            height: 36,
          }
        : undefined,
      vibrancy: isMac ? 'under-window' : undefined,
      visualEffectState: isMac ? 'active' : undefined,
      backgroundColor: isMac ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f3f6fb',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.mainWindow = win;
    this.mainWindowReady = false;

    win.once('ready-to-show', () => {
      this.mainWindowReady = true;
      if (safeBounds.isMaximized) win.maximize();
      win.show();
      app.focus({ steal: true });
      win.focus();
      this.syncFloatingBallVisibility();
    });

    const syncFloating = () => this.syncFloatingBallVisibility();
    win.on('focus', syncFloating);
    win.on('blur', syncFloating);
    win.on('minimize', syncFloating);
    win.on('restore', syncFloating);
    win.on('show', syncFloating);
    win.on('hide', syncFloating);

    const scheduleSaveBounds = () => {
      if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer);
      this.boundsSaveTimer = setTimeout(() => {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        const isMaximized = this.mainWindow.isMaximized();
        const b = isMaximized ? this.mainWindow.getNormalBounds() : this.mainWindow.getBounds();
        this.configStore.update({
          windowBounds: {
            x: b.x,
            y: b.y,
            width: Math.max(MIN_MAIN_WIDTH, b.width),
            height: Math.max(MIN_MAIN_HEIGHT, b.height),
            isMaximized,
          },
        });
      }, 500);
    };

    win.on('resize', scheduleSaveBounds);
    win.on('move', scheduleSaveBounds);

    win.on('close', (event) => {
      if (!this.isQuitting && this.configStore.get().closeToTray) {
        event.preventDefault();
        win.hide();
      }
    });

    const onNativeThemeUpdated = () => {
      this.applyTitleBarOverlay();
      this.applyThemeToDocView();
      this.emitFloatingState();
    };
    nativeTheme.on('updated', onNativeThemeUpdated);

    win.on('closed', () => {
      nativeTheme.off('updated', onNativeThemeUpdated);
      // 必须先置空主窗引用再销毁子视图，避免 destroyDocView -> emitDocState 向已销毁窗口发送 IPC 抛 Object has been destroyed
      this.mainWindow = null;
      this.mainWindowReady = false;
      this.destroyDocView(false);
      this.syncFloatingBallVisibility();
    });

    // 主渲染层刷新（如 Shift+F5 / Cmd+R）或重载前，必须主动收起原生 WebContentsView，
    // 防止重载后回到默认「今日专注」页时云文档子视图仍残留在顶层遮挡界面。
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && this.docActive) {
        this.deactivateDoc();
      }
    });
    win.webContents.on('render-process-gone', () => {
      if (this.docActive) {
        this.deactivateDoc();
      }
    });

    if (this.rendererEntry.devUrl) {
      win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level >= 2) {
          console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
        }
      });
      void win.loadURL(this.rendererEntry.devUrl);
    } else {
      void win.loadFile(this.rendererEntry.htmlPath);
    }

    return win;
  }

  showMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.createMainWindow();
      return;
    }
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    app.focus({ steal: true });
    this.mainWindow.focus();
  }

  toggleMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.createMainWindow();
      return;
    }
    if (this.mainWindow.isVisible() && this.mainWindow.isFocused()) {
      this.mainWindow.hide();
    } else {
      this.showMainWindow();
    }
  }

  private isAllowedDocUrl(rawUrl: string): boolean {
    try {
      const target = new URL(rawUrl);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
      const localOrigin = this.localDocHost.getLocalOrigin();
      if (localOrigin && target.origin === localOrigin) return true;
      return getOrbitEndpoints().allowedOrigins.some((origin) => target.origin === origin);
    } catch {
      return false;
    }
  }

  private ensureDocView(targetUrl?: string): WebContentsView {
    const mappedTarget = targetUrl ? this.localDocHost.toLocalUrl(targetUrl) : undefined;
    if (this.docView && !this.docView.webContents.isDestroyed()) {
      if (mappedTarget && mappedTarget !== this.docView.webContents.getURL()) {
        void this.docView.webContents.loadURL(mappedTarget);
      }
      return this.docView;
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: ORBIT_SHARED_PARTITION,
        // 仅挂载极简只读 docPreload（仅暴露 window.orbitDocBridge），绝不暴露 Orbit 特权 Preload
        preload: this.docPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.docView = view;
    this.docHibernated = false;

    const wc = view.webContents;
    if (this.rendererEntry.devUrl) {
      wc.on('console-message', (_event, level, message, line, sourceId) => {
        if (level >= 2) {
          console.error(`[doc-view:${level}] ${message} (${sourceId}:${line})`);
        }
      });
    }
    wc.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedDocUrl(url)) {
        void wc.loadURL(this.localDocHost.toLocalUrl(url));
      } else {
        void shell.openExternal(this.localDocHost.toCanonicalUrl(url));
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      if (!this.isAllowedDocUrl(url)) {
        event.preventDefault();
        void shell.openExternal(this.localDocHost.toCanonicalUrl(url));
        return;
      }
      // 线上 SSO 回调完成后若跳回 https://doc.lecspace.top/<前端路由>，自动切回本地前端托管源
      const remapped = this.localDocHost.toLocalUrl(url);
      if (remapped !== url) {
        event.preventDefault();
        void wc.loadURL(remapped);
      }
    });

    wc.on('did-start-loading', () => {
      this.docLoading = true;
      this.emitDocState();
    });

    const maybeAutoTriggerDocSso = (currentUrl: string): boolean => {
      const docOrigin = getOrbitEndpoints().docWebUrl;
      const canonical = this.localDocHost.toCanonicalUrl(currentUrl);
      if (
        !this.docAutoSsoAttempted &&
        this.isAuthenticated() &&
        canonical.startsWith(`${docOrigin}/login`)
      ) {
        this.docAutoSsoAttempted = true;
        void wc.loadURL(`${docOrigin}/api/auth/lec-sso/login?redirect=/`);
        return true;
      }
      return false;
    };

    const maybeRedirectRemoteToLocal = (currentUrl: string): boolean => {
      const remapped = this.localDocHost.toLocalUrl(currentUrl);
      if (remapped !== currentUrl) {
        void wc.loadURL(remapped);
        return true;
      }
      return false;
    };

    wc.on('did-navigate-in-page', (_event, currentUrl) => {
      if (maybeAutoTriggerDocSso(currentUrl)) return;
      if (currentUrl) {
        this.docLastUrl = this.localDocHost.toCanonicalUrl(currentUrl);
        if (!/\/p\//.test(currentUrl)) {
          this.docPageContext = null;
        }
      }
      this.emitDocState();
    });

    wc.on('did-stop-loading', () => {
      this.docLoading = false;
      const currentUrl = wc.getURL();
      const title = wc.getTitle();
      if (currentUrl && maybeRedirectRemoteToLocal(currentUrl)) return;
      if (currentUrl && maybeAutoTriggerDocSso(currentUrl)) return;
      if (currentUrl && currentUrl.startsWith(`${getOrbitEndpoints().ssoEndpoint}/sign-in`)) {
        void this.maybeAutoBridgeDocSignIn(wc, currentUrl);
      }
      if (currentUrl) {
        this.docLastUrl = this.localDocHost.toCanonicalUrl(currentUrl);
        if (!/\/p\//.test(currentUrl)) {
          this.docPageContext = null;
        }
      }
      if (title) this.docTitle = title;
      if (currentUrl && this.isDocAppOrigin(currentUrl)) {
        this.applyThemeToDocView();
        this.localDb.recordDocVisit(
          this.getScopeKey(),
          this.localDocHost.toCanonicalUrl(currentUrl),
          this.docTitle,
        );
      }
      this.emitDocState();
    });

    wc.on('page-title-updated', (_e, title) => {
      this.docTitle = title || 'LecDoc';
      this.emitDocState();
    });

    const loadTarget =
      mappedTarget || this.localDocHost.toLocalUrl(this.docLastUrl) || this.getDocActiveOrigin();
    void wc.loadURL(loadTarget);
    return view;
  }

  private attachAndSyncDocBounds(): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed() || !this.docView) return;
    const shouldShow = this.docActive && !this.docOverlayHidden && this.docBounds.width > 0 && this.docBounds.height > 0;
    const children = win.contentView.children;
    const alreadyAttached = children.includes(this.docView);

    if (shouldShow) {
      if (!alreadyAttached) {
        win.contentView.addChildView(this.docView);
      }
      this.docView.setVisible(true);
      this.docView.setBounds(this.docBounds);
    } else {
      this.docView.setVisible(false);
      if (alreadyAttached) {
        win.contentView.removeChildView(this.docView);
      }
    }
  }

  private clearHibernateTimer(): void {
    if (this.hibernateTimer) {
      clearTimeout(this.hibernateTimer);
      this.hibernateTimer = null;
    }
  }

  private scheduleHibernate(): void {
    this.clearHibernateTimer();
    const minutes = this.configStore.get().docHibernateMinutes;
    this.hibernateTimer = setTimeout(() => {
      if (!this.docActive && this.docView) {
        this.destroyDocView(true);
      }
    }, minutes * 60 * 1000);
  }

  private destroyDocView(markHibernated: boolean): void {
    this.clearHibernateTimer();
    if (!this.docView) return;
    try {
      if (!this.docView.webContents.isDestroyed()) {
        const currentUrl = this.docView.webContents.getURL();
        if (currentUrl) this.docLastUrl = currentUrl;
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.contentView.removeChildView(this.docView);
      }
      this.docView.webContents.close();
    } catch {
      // 忽略关闭异常
    }
    this.docView = null;
    this.docHibernated = markHibernated;
    this.docLoading = false;
    this.emitDocState();
  }

  activateDoc(bounds: DocBounds, url?: string): DocViewState {
    this.clearHibernateTimer();
    this.docActive = true;
    this.docBounds = bounds;
    this.ensureDocView(url);
    this.attachAndSyncDocBounds();
    this.emitDocState();
    return this.getDocState();
  }

  deactivateDoc(): void {
    this.docActive = false;
    this.attachAndSyncDocBounds();
    if (this.docView) {
      this.scheduleHibernate();
    }
    this.emitDocState();
  }

  setDocBounds(bounds: DocBounds): void {
    this.docBounds = bounds;
    this.attachAndSyncDocBounds();
  }

  /**
   * 关键布局协调：当主壳打开 Cmd+K / Dialog / Sheet / LoginModal 时隐藏原生 WebContentsView，
   * 彻底消除 Electron 原生子视图遮挡 React DOM 弹窗的经典问题。
   */
  setOverlayVisible(visible: boolean): void {
    this.docOverlayHidden = visible;
    this.attachAndSyncDocBounds();
    this.emitDocState();
  }

  navigateDoc(url: string): void {
    if (!this.isAllowedDocUrl(url)) {
      void shell.openExternal(url);
      return;
    }
    const mapped = this.localDocHost.toLocalUrl(url);
    const view = this.ensureDocView(mapped);
    void view.webContents.loadURL(mapped);
  }

  docGoBack(): void {
    if (this.docView && !this.docView.webContents.isDestroyed() && this.docView.webContents.navigationHistory.canGoBack()) {
      this.docView.webContents.navigationHistory.goBack();
    }
  }

  docGoForward(): void {
    if (this.docView && !this.docView.webContents.isDestroyed() && this.docView.webContents.navigationHistory.canGoForward()) {
      this.docView.webContents.navigationHistory.goForward();
    }
  }

  docReload(): void {
    this.docAutoSsoAttempted = false;
    this.docOrbitBridgeAttempted = false;
    if (this.docView && !this.docView.webContents.isDestroyed()) {
      this.docView.webContents.reloadIgnoringCache();
    }
  }

  openDocExternal(): void {
    void shell.openExternal(this.getDocState().url);
  }

  /** Stage 2 预留：在光标所在显示器弹出独立全机 LecSSO 授权确认浮窗。 */
  showApproveChallengeWindow(event: ApproveChallengeEvent): void {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const rect = centerOnDisplay(cursorDisplay, 400, 460);

    if (!this.approveWindow || this.approveWindow.isDestroyed()) {
      const isMac = process.platform === 'darwin';
      this.approveWindow = new BrowserWindow({
        ...rect,
        resizable: false,
        alwaysOnTop: true,
        frame: false,
        show: false,
        title: 'Orbit · 授权登录确认',
        icon: this.rendererEntry.iconPath,
        vibrancy: isMac ? 'popover' : undefined,
        backgroundColor: isMac ? '#00000000' : '#ffffff',
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const target = this.rendererEntry.devUrl
        ? `${this.rendererEntry.devUrl}#approve/${encodeURIComponent(event.challengeId)}`
        : `${path.basename(this.rendererEntry.htmlPath)}`;
      if (this.rendererEntry.devUrl) {
        void this.approveWindow.loadURL(target);
      } else {
        void this.approveWindow.loadFile(this.rendererEntry.htmlPath, {
          hash: `approve/${encodeURIComponent(event.challengeId)}`,
        });
      }
      this.approveWindow.once('ready-to-show', () => {
        this.approveWindow?.show();
        this.approveWindow?.focus();
      });
      this.approveWindow.on('closed', () => {
        this.approveWindow = null;
      });
      return;
    }

    this.approveWindow.setBounds(rect);
    safeSendToWindow(this.approveWindow, 'orbit:approve:challenge', event);
    this.approveWindow.show();
    this.approveWindow.focus();
  }

  closeApproveWindow(): void {
    if (this.approveWindow && !this.approveWindow.isDestroyed()) {
      this.approveWindow.close();
      this.approveWindow = null;
    }
  }

  getFloatingState(): FloatingBallState {
    return {
      ...this.floatingSummary,
      expanded: this.floatingExpanded,
      theme: this.currentTheme,
    };
  }

  private emitFloatingState(): void {
    safeSendToWindow(this.floatingWindow, 'orbit:floating:stateChanged', this.getFloatingState());
  }

  updateFloatingPunchSummary(summary: TrayPunchSummary): void {
    this.floatingSummary = { ...this.floatingSummary, ...summary };
    this.emitFloatingState();
  }

  private shouldShowFloatingBall(): boolean {
    if (this.isQuitting || !this.configStore.get().floatingBallEnabled) return false;
    const main = this.mainWindow;
    if (main && !main.isDestroyed()) {
      // 主窗尚未首次就绪前暂不闪现悬浮球
      if (!this.mainWindowReady) return false;
      // 主窗位于前台聚焦时自动收起悬浮球；切到后台 / 最小化 / 隐藏托盘时自动显示
      const mainInForeground = main.isVisible() && !main.isMinimized() && main.isFocused();
      return !mainInForeground;
    }
    return true;
  }

  syncFloatingBallVisibility(): void {
    if (!this.configStore.get().floatingBallEnabled) {
      this.destroyFloatingBallWindow();
      return;
    }
    if (this.shouldShowFloatingBall()) {
      this.ensureFloatingBallWindow();
    } else if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      if (this.floatingExpanded) {
        this.setFloatingBallExpanded(false);
      }
      this.floatingWindow.hide();
    }
  }

  syncFloatingBallEnabled(enabled: boolean): void {
    if (enabled) {
      this.syncFloatingBallVisibility();
    } else {
      this.destroyFloatingBallWindow();
    }
  }

  ensureFloatingBallWindow(): void {
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      this.floatingWindow.showInactive();
      return;
    }
    // 窗口比可视胶囊四周各多留 16px 透明阴影安全区，彻底消除阴影被窗口边界裁出黑边/灰框
    const COLLAPSED = { width: 172, height: 70 };
    const primary = screen.getPrimaryDisplay().workArea;
    const saved = this.configStore.get().floatingBallPosition;
    const displays = screen.getAllDisplays().map((d) => d.workArea);
    let x = primary.x + primary.width - COLLAPSED.width - 4;
    let y = primary.y + Math.round(primary.height * 0.14);
    if (saved) {
      const matched = displays.find(
        (d) =>
          saved.x >= d.x - 20 &&
          saved.x <= d.x + d.width &&
          saved.y >= d.y - 20 &&
          saved.y <= d.y + d.height,
      );
      if (matched) {
        x = Math.max(matched.x - 2, Math.min(saved.x, matched.x + matched.width - COLLAPSED.width + 2));
        y = Math.max(matched.y - 2, Math.min(saved.y, matched.y + matched.height - COLLAPSED.height + 2));
      }
    }

    this.floatingExpanded = false;
    const win = new BrowserWindow({
      x,
      y,
      width: COLLAPSED.width,
      height: COLLAPSED.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      focusable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') {
      // 禁止传 visibleOnFullScreen: true：Electron 会将整个进程切为 UIElement/Accessory 模式，
      // 导致 macOS Dock 图标消失、Cmd+Tab 不可见且聚焦窗口时左上角菜单栏不显示 Orbit。
      win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    }

    this.floatingWindow = win;
    if (this.rendererEntry.devUrl) {
      void win.loadURL(`${this.rendererEntry.devUrl}#floating-ball`);
    } else {
      void win.loadFile(this.rendererEntry.htmlPath, { hash: 'floating-ball' });
    }

    win.once('ready-to-show', () => {
      if (this.shouldShowFloatingBall()) {
        win.showInactive();
      }
      this.emitFloatingState();
    });
    win.on('closed', () => {
      this.floatingWindow = null;
      this.floatingExpanded = false;
    });
  }

  destroyFloatingBallWindow(): void {
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      this.floatingWindow.destroy();
      this.floatingWindow = null;
      this.floatingExpanded = false;
    }
  }

  setFloatingBallExpanded(expanded: boolean): void {
    const win = this.floatingWindow;
    if (!win || win.isDestroyed()) return;
    if (this.floatingExpanded === expanded) return;
    const prev = win.getBounds();
    const display = screen.getDisplayMatching(prev).workArea;
    const nextWidth = expanded ? 304 : 172;
    const nextHeight = expanded ? 156 : 70;
    const dockedRight = prev.x + prev.width / 2 > display.x + display.width / 2;
    let nextX = dockedRight ? prev.x + prev.width - nextWidth : prev.x;
    let nextY = prev.y + Math.round((prev.height - nextHeight) / 2);
    nextX = Math.max(display.x - 4, Math.min(nextX, display.x + display.width - nextWidth + 4));
    nextY = Math.max(display.y - 4, Math.min(nextY, display.y + display.height - nextHeight + 4));
    this.floatingExpanded = expanded;
    win.setBounds({ x: nextX, y: nextY, width: nextWidth, height: nextHeight }, false);
    this.emitFloatingState();
  }

  moveFloatingBall(x: number, y: number): void {
    const win = this.floatingWindow;
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height }, false);
  }

  /** 结束拖拽后保留用户放置的任意位置（仅做防越界裁剪）并持久化坐标。 */
  snapFloatingBallToEdge(): void {
    const win = this.floatingWindow;
    if (!win || win.isDestroyed()) return;
    const cur = win.getBounds();
    const display = screen.getDisplayMatching(cur).workArea;
    const targetX = Math.max(
      display.x - 10,
      Math.min(cur.x, display.x + display.width - cur.width + 10),
    );
    const targetY = Math.max(
      display.y - 10,
      Math.min(cur.y, display.y + display.height - cur.height + 10),
    );
    if (targetX !== cur.x || targetY !== cur.y) {
      win.setBounds({ x: targetX, y: targetY, width: cur.width, height: cur.height }, false);
    }
    this.configStore.update({ floatingBallPosition: { x: targetX, y: targetY } });
  }
}
