/**
 * 极简只读权限的 LecDoc 嵌入式桥接 Preload：
 * 仅向内嵌的 LecDoc WebContentsView 暴露 window.orbitDocBridge，
 * 绝不暴露 Orbit 主进程鉴权 Token、本地密钥库或系统 Shell 能力。
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface OrbitDocPageContextPayload {
  pageId?: string;
  pageSlug?: string;
  pageTitle?: string;
  canEdit?: boolean;
  spaceName?: string;
}

export interface OrbitDocEditRequestPayload {
  pageId?: string;
  pageSlug?: string;
  pageTitle?: string;
  reason?: string;
}

const orbitDocBridge = {
  isOrbit: true as const,
  notifyPageContext: (ctx: OrbitDocPageContextPayload): void => {
    ipcRenderer.send('orbit:doc-bridge:pageContext', ctx);
  },
  requestEditAccess: (payload: OrbitDocEditRequestPayload): void => {
    ipcRenderer.send('orbit:doc-bridge:requestEdit', payload);
  },
  onThemeChanged: (listener: (theme: 'light' | 'dark' | 'system') => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark' | 'system') =>
      listener(theme);
    ipcRenderer.on('orbit:doc-bridge:themeChanged', handler);
    return () => ipcRenderer.removeListener('orbit:doc-bridge:themeChanged', handler);
  },
};

contextBridge.exposeInMainWorld('orbitDocBridge', orbitDocBridge);
