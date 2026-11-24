import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsViewConstructorOptions } from 'electron';

class FakeContents extends EventEmitter {
  url = '';
  closed = false;
  openExternalWindow?: (event: { url: string }) => { action: 'deny' };
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };

  getURL() { return this.url; }
  isDestroyed() { return this.closed; }
  close() { this.closed = true; }
  setWindowOpenHandler(handler: FakeContents['openExternalWindow']) { this.openExternalWindow = handler; }

  async loadURL(url: string) {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    this.url = url;
    this.emit('did-navigate', {}, url);
    this.emit('did-stop-loading');
  }
}

class FakeView {
  webContents = new FakeContents();
  visible = false;

  constructor(readonly options: WebContentsViewConstructorOptions) {}
  setVisible(visible: boolean) { this.visible = visible; }
  setBounds() {}
}

const fromPartition = mock(() => ({
  setPermissionCheckHandler: mock(),
  setPermissionRequestHandler: mock(),
  on: mock(),
}));
const openExternalMock = mock(async () => undefined);

mock.module('electron', () => ({
  session: { fromPartition },
  shell: { openExternal: openExternalMock },
  WebContentsView: FakeView,
}));

const { BlogBrowserView } = await import('../electron/windows/blogView');
const bounds = { x: 12, y: 36, width: 600, height: 480 };

function createBrowser(hibernateMinutes = 15) {
  const children: FakeView[] = [];
  const window = {
    isDestroyed: () => false,
    contentView: {
      children,
      addChildView: (view: FakeView) => children.push(view),
      removeChildView: (view: FakeView) => children.splice(children.indexOf(view), 1),
    },
  } as unknown as BrowserWindow;
  const browser = new BlogBrowserView(() => window, () => hibernateMinutes, () => {});
  return { browser, children };
}

describe('博客原生视图', () => {
  test('在独立沙盒中打开，弹窗避让后恢复原视图', () => {
    const { browser, children } = createBrowser();
    browser.activate(bounds, new URL('https://blog.example/'));
    const view = children[0]!;
    expect(fromPartition).toHaveBeenCalledWith('persist:lec-orbit-blogs');
    expect(view.options.webPreferences).toEqual({
      partition: 'persist:lec-orbit-blogs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });

    browser.setOverlayVisible(true);
    expect(browser.getState()).toMatchObject({ active: true, mounted: true, overlayHidden: true });
    expect(children).toHaveLength(0);
    browser.setOverlayVisible(false);
    expect(children[0]).toBe(view);
    expect(browser.getState().url).toBe('https://blog.example/');
    browser.destroy();
    expect(children).toHaveLength(0);
    expect(view.webContents.closed).toBe(true);
  });

  test('拦截非 HTTP(S) 跳转并在载入错误后释放显示区域', () => {
    const { browser, children } = createBrowser();
    browser.activate(bounds, new URL('https://blog.example/'));
    const view = children[0]!;
    const preventDefault = mock();
    view.webContents.emit('will-redirect', { url: 'file:///blog.html', isMainFrame: true, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(browser.getState()).toMatchObject({ loadError: '博客尝试打开不支持的地址', loading: false });
    expect(children).toHaveLength(0);
    expect(view.webContents.openExternalWindow?.({ url: 'lec-orbit://blog' })).toEqual({ action: 'deny' });
    browser.reload();
    expect(children[0]).toBe(view);
    expect(browser.getState().loadError).toBeNull();
    browser.destroy();
  });

  test('离开后休眠，重新激活时继续浏览原地址', async () => {
    const { browser, children } = createBrowser(0);
    browser.activate(bounds, new URL('https://blog.example/article'));
    const view = children[0]!;
    browser.deactivate();
    expect(children).toHaveLength(0);
    await Bun.sleep(10);
    expect(view.webContents.closed).toBe(true);
    expect(browser.getState()).toMatchObject({ hibernated: true, mounted: false, url: 'https://blog.example/article' });
    browser.activate(bounds);
    expect(children).toHaveLength(1);
    expect(children[0]).not.toBe(view);
    expect(browser.getState()).toMatchObject({ hibernated: false, mounted: true, url: 'https://blog.example/article' });
    openExternalMock.mockClear();
    await browser.openExternal();
    expect(openExternalMock).toHaveBeenCalledWith('https://blog.example/article');
    browser.destroy();
  });
});
