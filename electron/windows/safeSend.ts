/** 主进程安全向 Electron BrowserWindow 发送 IPC 消息的防护工具（零 Electron 运行时依赖，便于单测）。 */

export interface DestroyableWebContentsLike {
  isDestroyed: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
}

export interface DestroyableWindowLike {
  isDestroyed: () => boolean;
  webContents: DestroyableWebContentsLike;
}

/** 仅在窗口对象存在且未被销毁时返回窗口实例；已销毁或访问异常时返回 null。 */
export function getAliveWindow<T extends DestroyableWindowLike>(
  win: T | null | undefined,
): T | null {
  if (!win) return null;
  try {
    return win.isDestroyed() ? null : win;
  } catch {
    return null;
  }
}

/** 安全向窗口的 webContents 发送 IPC 消息；窗口或 webContents 已销毁时静默返回 false，防止抛出 Object has been destroyed。 */
export function safeSendToWindow(
  win: DestroyableWindowLike | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  const alive = getAliveWindow(win);
  if (!alive) return false;
  try {
    if (alive.webContents.isDestroyed()) return false;
    alive.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}
