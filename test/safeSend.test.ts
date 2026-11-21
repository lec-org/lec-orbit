import { describe, expect, test } from 'bun:test';
import {
  getAliveWindow,
  safeSendToWindow,
  type DestroyableWindowLike,
} from '../electron/windows/safeSend';

/** 构造模拟 Electron 原生 BrowserWindow：一旦 destroyed=true，访问 .webContents 立刻抛 TypeError: Object has been destroyed。 */
function createMockBrowserWindow(initialDestroyed = false) {
  let destroyed = initialDestroyed;
  let wcDestroyed = initialDestroyed;
  const sent: Array<{ channel: string; args: unknown[] }> = [];

  const win: DestroyableWindowLike = {
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) {
        throw new TypeError('Object has been destroyed');
      }
      return {
        isDestroyed: () => wcDestroyed,
        send: (channel: string, ...args: unknown[]) => {
          if (wcDestroyed) {
            throw new TypeError('Object has been destroyed');
          }
          sent.push({ channel, args });
        },
      };
    },
  };

  return {
    win,
    sent,
    markDestroyed: () => {
      destroyed = true;
      wcDestroyed = true;
    },
    markWebContentsDestroyed: () => {
      wcDestroyed = true;
    },
  };
}

describe('safeSend (防止主窗口销毁后 emitDocState / IPC 抛 Object has been destroyed)', () => {
  test('存活窗口正常透传 channel 与参数', () => {
    const mock = createMockBrowserWindow(false);
    expect(getAliveWindow(mock.win)).toBe(mock.win);

    const ok = safeSendToWindow(mock.win, 'orbit:doc:stateChanged', { mounted: true });
    expect(ok).toBe(true);
    expect(mock.sent).toEqual([{ channel: 'orbit:doc:stateChanged', args: [{ mounted: true }] }]);
  });

  test('复现线上重启更新崩溃链路：BrowserWindow 已进入 closed (isDestroyed=true) 后触发 emitDocState 绝不抛错', () => {
    const mock = createMockBrowserWindow(false);
    // 模拟重启更新时主窗口触发 closed：此时 Electron 原生对象已销毁，直接访问 .webContents 会抛 TypeError
    mock.markDestroyed();
    expect(() => mock.win.webContents).toThrow('Object has been destroyed');

    // 修复后：getAliveWindow 直接过滤掉已销毁窗口，safeSendToWindow 静默跳过不抛异常
    expect(getAliveWindow(mock.win)).toBeNull();
    expect(() => safeSendToWindow(mock.win, 'orbit:doc:stateChanged', { mounted: false })).not.toThrow();
    expect(safeSendToWindow(mock.win, 'orbit:doc:stateChanged', { mounted: false })).toBe(false);
    expect(mock.sent).toHaveLength(0);
  });

  test('窗口尚未完全销毁但 webContents 已销毁或 send 抛错时均静默返回 false', () => {
    const mock = createMockBrowserWindow(false);
    mock.markWebContentsDestroyed();

    expect(getAliveWindow(mock.win)).toBe(mock.win);
    expect(safeSendToWindow(mock.win, 'orbit:system:updateState', { stage: 'downloaded' })).toBe(
      false,
    );
    expect(safeSendToWindow(null, 'orbit:system:updateState', {})).toBe(false);
    expect(safeSendToWindow(undefined, 'orbit:system:updateState', {})).toBe(false);
  });
});
