/** Preload 安全隔离层：仅通过 contextBridge 暴露严格白名单的 window.orbit 能力。 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  MiniAppBounds,
  MiniAppDisplayMode,
  MiniAppLaunchDevUrlInput,
  MiniAppLaunchInput,
  MiniAppLaunchLocalDirInput,
  MiniAppRuntimeSnapshot,
  MiniAppUserPref,
} from '../src/shared/miniapp';
import type {
  ApproveChallengeEvent,
  AuthState,
  BlogViewState,
  ChangePasswordInput,
  DocBounds,
  DocEditRequestEvent,
  DocViewState,
  FloatingBallState,
  MfaVerifyInput,
  OrbitBridge,
  OrbitConfigPatch,
  PasswordSignInInput,
  TrayPunchSummary,
  UpdateAvatarUrlInput,
  UpdateCheckResult,
  WifiScanOptions,
} from '../src/shared/ipc';

const bridge: OrbitBridge = {
  platform: process.platform,
  isPackaged: process.env.NODE_ENV === 'production',
  auth: {
    getState: () => ipcRenderer.invoke('orbit:auth:getState'),
    signInWithPassword: (input: PasswordSignInInput) =>
      ipcRenderer.invoke('orbit:auth:signInWithPassword', input),
    verifyMfa: (input: MfaVerifyInput) => ipcRenderer.invoke('orbit:auth:verifyMfa', input),
    signInWithEmbeddedWindow: () => ipcRenderer.invoke('orbit:auth:signInWithEmbeddedWindow'),
    getApiToken: (target: 'punch' | 'orbit') =>
      ipcRenderer.invoke('orbit:auth:getApiToken', target),
    pickAndUploadAvatar: () => ipcRenderer.invoke('orbit:auth:pickAndUploadAvatar'),
    updateAvatarUrl: (input: UpdateAvatarUrlInput) =>
      ipcRenderer.invoke('orbit:auth:updateAvatarUrl', input),
    changePassword: (input: ChangePasswordInput) =>
      ipcRenderer.invoke('orbit:auth:changePassword', input),
    signOut: () => ipcRenderer.invoke('orbit:auth:signOut'),
    onStateChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: AuthState) => listener(state);
      ipcRenderer.on('orbit:auth:stateChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:auth:stateChanged', wrapped);
    },
  },
  doc: {
    activate: (bounds: DocBounds, url?: string) =>
      ipcRenderer.invoke('orbit:doc:activate', { bounds, url }),
    deactivate: () => ipcRenderer.invoke('orbit:doc:deactivate'),
    setBounds: (bounds: DocBounds) => ipcRenderer.invoke('orbit:doc:setBounds', bounds),
    setOverlayVisible: (visible: boolean) =>
      ipcRenderer.invoke('orbit:doc:setOverlayVisible', visible),
    navigate: (url: string) => ipcRenderer.invoke('orbit:doc:navigate', url),
    goBack: () => ipcRenderer.invoke('orbit:doc:goBack'),
    goForward: () => ipcRenderer.invoke('orbit:doc:goForward'),
    reload: () => ipcRenderer.invoke('orbit:doc:reload'),
    openExternal: () => ipcRenderer.invoke('orbit:doc:openExternal'),
    getState: () => ipcRenderer.invoke('orbit:doc:getState'),
    listRecents: (query?: string) => ipcRenderer.invoke('orbit:doc:listRecents', query),
    onStateChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: DocViewState) => listener(state);
      ipcRenderer.on('orbit:doc:stateChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:doc:stateChanged', wrapped);
    },
    onEditRequestTriggered: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: DocEditRequestEvent) =>
        listener(payload);
      ipcRenderer.on('orbit:doc:editRequestTriggered', wrapped);
      return () => ipcRenderer.removeListener('orbit:doc:editRequestTriggered', wrapped);
    },
  },
  blog: {
    activate: (bounds: DocBounds, url?: string) =>
      ipcRenderer.invoke('orbit:blog:activate', { bounds, url }),
    deactivate: () => ipcRenderer.invoke('orbit:blog:deactivate'),
    setBounds: (bounds) => ipcRenderer.invoke('orbit:blog:setBounds', bounds),
    navigate: (url) => ipcRenderer.invoke('orbit:blog:navigate', url),
    goBack: () => ipcRenderer.invoke('orbit:blog:goBack'),
    goForward: () => ipcRenderer.invoke('orbit:blog:goForward'),
    reload: () => ipcRenderer.invoke('orbit:blog:reload'),
    openExternal: () => ipcRenderer.invoke('orbit:blog:openExternal'),
    getState: () => ipcRenderer.invoke('orbit:blog:getState'),
    onStateChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: BlogViewState) => listener(state);
      ipcRenderer.on('orbit:blog:stateChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:blog:stateChanged', wrapped);
    },
  },
  storage: {
    getCache: (key: string) => ipcRenderer.invoke('orbit:storage:getCache', key),
    setCache: (key: string, value: unknown) =>
      ipcRenderer.invoke('orbit:storage:setCache', { key, value }),
    getWeeklyDraft: (week: string) => ipcRenderer.invoke('orbit:storage:getWeeklyDraft', week),
    saveWeeklyDraft: (week: string, content: string) =>
      ipcRenderer.invoke('orbit:storage:saveWeeklyDraft', { week, content }),
    clearUserCache: () => ipcRenderer.invoke('orbit:storage:clearUserCache'),
  },
  system: {
    getConfig: () => ipcRenderer.invoke('orbit:system:getConfig'),
    updateConfig: (patch: OrbitConfigPatch) => ipcRenderer.invoke('orbit:system:updateConfig', patch),
    openExternal: (url: string) => ipcRenderer.invoke('orbit:system:openExternal', url),
    copyText: (text: string) => ipcRenderer.invoke('orbit:system:copyText', text),
    notify: (title: string, body: string) =>
      ipcRenderer.invoke('orbit:system:notify', { title, body }),
    updateTrayPunch: (summary: TrayPunchSummary) =>
      ipcRenderer.invoke('orbit:system:updateTrayPunch', summary),
    scanWifi: (options?: WifiScanOptions) =>
      ipcRenderer.invoke('orbit:system:scanWifi', options ?? {}),
    getUpdateState: () => ipcRenderer.invoke('orbit:system:getUpdateState'),
    checkUpdate: () => ipcRenderer.invoke('orbit:system:checkUpdate'),
    downloadUpdate: () => ipcRenderer.invoke('orbit:system:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('orbit:system:installUpdate'),
    onUpdateStateChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: UpdateCheckResult) =>
        listener(state);
      ipcRenderer.on('orbit:system:updateState', wrapped);
      return () => ipcRenderer.removeListener('orbit:system:updateState', wrapped);
    },
    onCommandPaletteRequested: (listener) => {
      const wrapped = () => listener();
      ipcRenderer.on('orbit:system:commandPalette', wrapped);
      return () => ipcRenderer.removeListener('orbit:system:commandPalette', wrapped);
    },
    onQuickPunchRequested: (listener) => {
      const wrapped = () => listener();
      ipcRenderer.on('orbit:system:quickPunch', wrapped);
      return () => ipcRenderer.removeListener('orbit:system:quickPunch', wrapped);
    },
  },
  approve: {
    getChallenge: (challengeId: string) =>
      ipcRenderer.invoke('orbit:approve:getChallenge', challengeId),
    decide: (challengeId: string, action: 'approve' | 'deny') =>
      ipcRenderer.invoke('orbit:approve:decide', { challengeId, action }),
    closeWindow: () => ipcRenderer.invoke('orbit:approve:closeWindow'),
    onChallengeReceived: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: ApproveChallengeEvent) =>
        listener(payload);
      ipcRenderer.on('orbit:approve:challenge', wrapped);
      return () => ipcRenderer.removeListener('orbit:approve:challenge', wrapped);
    },
    promptBiometric: (reason: string) => ipcRenderer.invoke('orbit:approve:promptBiometric', reason),
  },
  floating: {
    getState: () => ipcRenderer.invoke('orbit:floating:getState'),
    setExpanded: (expanded: boolean) => ipcRenderer.invoke('orbit:floating:setExpanded', expanded),
    moveTo: (x: number, y: number) => ipcRenderer.invoke('orbit:floating:moveTo', { x, y }),
    snapToEdge: () => ipcRenderer.invoke('orbit:floating:snapToEdge'),
    togglePunch: () => ipcRenderer.invoke('orbit:floating:togglePunch'),
    openMain: () => ipcRenderer.invoke('orbit:floating:openMain'),
    onStateChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: FloatingBallState) =>
        listener(state);
      ipcRenderer.on('orbit:floating:stateChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:floating:stateChanged', wrapped);
    },
  },
  hub: {
    listBuiltins: () => ipcRenderer.invoke('orbit:hub:listBuiltins'),
    listInstalled: () => ipcRenderer.invoke('orbit:hub:listInstalled'),
    getRuntimeSnapshot: () => ipcRenderer.invoke('orbit:hub:getRuntimeSnapshot'),
    launch: (input: MiniAppLaunchInput) => ipcRenderer.invoke('orbit:hub:launch', input),
    launchLocalDir: (input: MiniAppLaunchLocalDirInput) =>
      ipcRenderer.invoke('orbit:hub:launchLocalDir', input),
    launchDevUrl: (input: MiniAppLaunchDevUrlInput) =>
      ipcRenderer.invoke('orbit:hub:launchDevUrl', input),
    switchMode: (appId: string, mode: MiniAppDisplayMode) =>
      ipcRenderer.invoke('orbit:hub:switchMode', { appId, mode }),
    close: (appId: string) => ipcRenderer.invoke('orbit:hub:close', appId),
    reload: (appId: string) => ipcRenderer.invoke('orbit:hub:reload', appId),
    openDevTools: (appId: string) => ipcRenderer.invoke('orbit:hub:openDevTools', appId),
    toggleFullscreen: (appId: string) => ipcRenderer.invoke('orbit:hub:toggleFullscreen', appId),
    setSidepanelBounds: (bounds: MiniAppBounds, width?: number) =>
      ipcRenderer.invoke('orbit:hub:setSidepanelBounds', { bounds, width }),
    setWorkspaceBounds: (bounds: MiniAppBounds) =>
      ipcRenderer.invoke('orbit:hub:setWorkspaceBounds', bounds),
    uninstall: (appId: string) => ipcRenderer.invoke('orbit:hub:uninstall', appId),
    clearCache: () => ipcRenderer.invoke('orbit:hub:clearCache'),
    pickLocalDir: () => ipcRenderer.invoke('orbit:hub:pickLocalDir'),
    pickZipFile: () => ipcRenderer.invoke('orbit:hub:pickZipFile'),
    readZipFileBase64: (filePath: string) =>
      ipcRenderer.invoke('orbit:hub:readZipFileBase64', filePath),
    getAppPref: (appId: string) => ipcRenderer.invoke('orbit:hub:getAppPref', appId),
    setAppPref: (appId: string, patch: Partial<Omit<MiniAppUserPref, 'appId'>>) =>
      ipcRenderer.invoke('orbit:hub:setAppPref', { appId, patch }),
    listAppPrefs: () => ipcRenderer.invoke('orbit:hub:listAppPrefs'),
    onRuntimeChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, snapshot: MiniAppRuntimeSnapshot) =>
        listener(snapshot);
      ipcRenderer.on('orbit:hub:runtimeChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:hub:runtimeChanged', wrapped);
    },
    onToastRequested: (listener) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        payload: {
          appId: string;
          appName: string;
          message: string;
          tone?: 'info' | 'success' | 'warning' | 'error';
        },
      ) => listener(payload);
      ipcRenderer.on('orbit:hub:toastRequested', wrapped);
      return () => ipcRenderer.removeListener('orbit:hub:toastRequested', wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('orbit', bridge);
