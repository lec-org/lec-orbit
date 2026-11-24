/** 渲染层统一访问 window.orbit 的类型安全封装；在纯浏览器调试时提供无副作用降级。 */
import {
  INITIAL_BLOG_VIEW_STATE,
  OrbitConfigSchema,
  type AuthState,
  type DocViewState,
  type OrbitBridge,
  type OrbitConfig,
} from '@shared/ipc';

const fallbackConfig: OrbitConfig = OrbitConfigSchema.parse({});

const fallbackAuth: AuthState = {
  authenticated: false,
  profile: null,
  isStudioMember: false,
  isAdmin: false,
};

const fallbackDocState: DocViewState = {
  active: false,
  mounted: false,
  hibernated: false,
  overlayHidden: false,
  url: 'https://doc.lecspace.top',
  title: 'LecDoc',
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

const browserFallback: OrbitBridge = {
  platform: 'darwin',
  isPackaged: false,
  auth: {
    getState: async () => fallbackAuth,
    signInWithPassword: async () => ({
      status: 'error',
      message: '当前处于纯浏览器预览模式，请通过 pnpm dev 启动 Electron 客户端完成 LecSSO 登录。',
      canFallbackWeb: false,
    }),
    verifyMfa: async () => ({
      status: 'error',
      message: '当前未连接到桌面主进程。',
      canFallbackWeb: false,
    }),
    signInWithEmbeddedWindow: async () => ({
      status: 'error',
      message: '请通过 Electron 桌面端打开内置登录窗口。',
      canFallbackWeb: false,
    }),
    getApiToken: async () => null,
    pickAndUploadAvatar: async () => ({ ok: false, message: '请在桌面客户端中操作。' }),
    updateAvatarUrl: async () => ({ ok: false, message: '请在桌面客户端中操作。' }),
    changePassword: async () => ({ ok: false, message: '请在桌面客户端中操作。' }),
    signOut: async () => fallbackAuth,
    onStateChanged: () => () => undefined,
  },
  doc: {
    activate: async () => fallbackDocState,
    deactivate: async () => undefined,
    setBounds: async () => undefined,
    setOverlayVisible: async () => undefined,
    navigate: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => undefined,
    openExternal: async () => {
      window.open(fallbackDocState.url, '_blank', 'noopener,noreferrer');
    },
    getState: async () => fallbackDocState,
    listRecents: async () => [],
    onStateChanged: () => () => undefined,
    onEditRequestTriggered: () => () => undefined,
  },
  blog: {
    activate: async () => INITIAL_BLOG_VIEW_STATE,
    deactivate: async () => undefined,
    setBounds: async () => undefined,
    navigate: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => undefined,
    openExternal: async () => undefined,
    getState: async () => INITIAL_BLOG_VIEW_STATE,
    onStateChanged: () => () => undefined,
  },
  storage: {
    getCache: async () => null,
    setCache: async () => undefined,
    getWeeklyDraft: async () => null,
    saveWeeklyDraft: async (week, content) => ({ week, content, updatedAt: Date.now() }),
    clearUserCache: async () => undefined,
  },
  system: {
    getConfig: async () => fallbackConfig,
    updateConfig: async (patch) => OrbitConfigSchema.parse({ ...fallbackConfig, ...patch }),
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    copyText: async (text) => {
      await navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    notify: async () => undefined,
    updateTrayPunch: async () => undefined,
    scanWifi: async () => ({
      ok: false,
      platform: 'darwin',
      scannedAt: Date.now(),
      rounds: 1,
      networks: [],
      error: '仅 Electron 桌面端支持读取周边 Wi-Fi 环境指纹。',
    }),
    getUpdateState: async () => ({ currentVersion: '0.1.0', available: false, checked: false, stage: 'idle' }),
    checkUpdate: async () => ({ currentVersion: '0.1.0', available: false, checked: false, stage: 'idle' }),
    downloadUpdate: async () => ({ currentVersion: '0.1.0', available: false, checked: false, stage: 'idle' }),
    installUpdate: async () => undefined,
    onUpdateStateChanged: () => () => undefined,
    onCommandPaletteRequested: () => () => undefined,
    onQuickPunchRequested: () => () => undefined,
  },
  approve: {
    getChallenge: async () => {
      throw new Error('仅 Electron 桌面端支持全机 SSO 授权弹窗。');
    },
    decide: async () => {
      throw new Error('仅 Electron 桌面端支持全机 SSO 授权弹窗。');
    },
    closeWindow: async () => undefined,
    onChallengeReceived: () => () => undefined,
    promptBiometric: async () => true,
  },
  floating: {
    getState: async () => ({
      checkedIn: false,
      elapsedSeconds: 0,
      statusLabel: '未打卡',
      expanded: false,
      theme: 'system',
    }),
    setExpanded: async () => undefined,
    moveTo: async () => undefined,
    snapToEdge: async () => undefined,
    togglePunch: async () => undefined,
    openMain: async () => undefined,
    onStateChanged: () => () => undefined,
  },
  hub: {
    listBuiltins: async () => [],
    listInstalled: async () => [],
    getRuntimeSnapshot: async () => ({ apps: [] }),
    launch: async () => {
      throw new Error('工坊容器仅在 Orbit 桌面客户端中运行。');
    },
    launchLocalDir: async () => {
      throw new Error('本地目录调试仅在 Orbit 桌面客户端中可用。');
    },
    launchDevUrl: async () => {
      throw new Error('开发热重载仅在 Orbit 桌面客户端中可用。');
    },
    switchMode: async () => null,
    close: async () => undefined,
    reload: async () => undefined,
    openDevTools: async () => undefined,
    toggleFullscreen: async () => undefined,
    setSidepanelBounds: async () => undefined,
    setWorkspaceBounds: async () => undefined,
    uninstall: async () => undefined,
    clearCache: async () => ({ freedBytes: 0 }),
    pickLocalDir: async () => ({ ok: false, cancelled: true }),
    pickZipFile: async () => ({ ok: false, cancelled: true }),
    readZipFileBase64: async () => {
      throw new Error('仅 Electron 桌面端支持读取本地构建包。');
    },
    getAppPref: async (appId) => ({ appId }),
    setAppPref: async (appId, patch) => ({ appId, ...patch }),
    listAppPrefs: async () => [],
    onRuntimeChanged: () => () => undefined,
    onToastRequested: () => () => undefined,
  },
};

export function getOrbitClient(): OrbitBridge {
  return window.orbit ?? browserFallback;
}

export function isDesktopRuntime(): boolean {
  return Boolean(window.orbit);
}
