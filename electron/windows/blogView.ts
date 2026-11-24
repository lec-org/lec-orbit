/** A dedicated browser session for member sites. It never receives the Orbit bridge. */
import { session, shell, WebContentsView, type BrowserWindow } from 'electron';
import { parseBlogUrl } from '../../src/shared/blogUrl';
import { INITIAL_BLOG_VIEW_STATE, type BlogViewState, type DocBounds } from '../../src/shared/ipc';

const BLOG_SANDBOX_PARTITION = 'persist:lec-orbit-blogs';
const BLOCKED_NAVIGATION = '博客尝试打开不支持的地址';
const LOAD_FAILED = '无法加载当前博客';

export class BlogBrowserView {
  private view: WebContentsView | null = null;
  private state = { ...INITIAL_BLOG_VIEW_STATE };
  private bounds: DocBounds = { x: 0, y: 0, width: 0, height: 0 };
  private hibernateTimer: NodeJS.Timeout | null = null;
  private sessionConfigured = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly hibernateMinutes: () => number,
    private readonly emit: (state: BlogViewState) => void,
  ) {}

  private get contents() {
    const wc = this.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  getState(): BlogViewState {
    const history = this.contents?.navigationHistory;
    return {
      ...this.state,
      mounted: Boolean(history),
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
    };
  }

  activate(bounds: DocBounds, target?: URL): BlogViewState {
    this.clearHibernate();
    this.bounds = bounds;
    const needsRestore = !this.contents && this.state.url;
    this.update({ active: true });
    if (target) {
      this.navigate(target);
    } else if (needsRestore) {
      this.navigate(new URL(this.state.url));
    }
    return this.getState();
  }

  deactivate(): void {
    if (!this.state.active) return;
    this.update({ active: false });
    if (this.view) {
      this.hibernateTimer = setTimeout(() => this.destroy(true), this.hibernateMinutes() * 60_000);
    }
  }

  setBounds(bounds: DocBounds): void {
    this.bounds = bounds;
    this.syncBounds();
  }

  setOverlayVisible(visible: boolean): void {
    if (this.state.overlayHidden !== visible) this.update({ overlayHidden: visible });
  }

  navigate(target: URL): void {
    if (!this.state.active) return;
    const wc = this.ensureView().webContents;
    if (!this.state.loadError && (wc.getURL() === target.href || (this.state.loading && this.state.url === target.href))) {
      return;
    }

    this.update({
      url: target.href,
      title: target.hostname,
      loading: true,
      loadError: null,
      hibernated: false,
    });
    void wc.loadURL(target.href).catch((error: Error & { code?: string }) => {
      if (this.contents === wc && this.state.url === target.href && error.code !== 'ERR_ABORTED') {
        this.update({ loading: false, loadError: this.state.loadError || LOAD_FAILED });
      }
    });
  }

  goBack(): void {
    const history = this.contents?.navigationHistory;
    if (this.state.active && history?.canGoBack()) history.goBack();
  }

  goForward(): void {
    const history = this.contents?.navigationHistory;
    if (this.state.active && history?.canGoForward()) history.goForward();
  }

  reload(): void {
    if (!this.state.active || !this.state.url) return;
    if (!this.contents || this.state.loadError) {
      this.navigate(new URL(this.state.url));
    } else {
      this.contents.reloadIgnoringCache();
    }
  }

  async openExternal(): Promise<void> {
    const safe = parseBlogUrl(this.state.url);
    if (this.state.active && safe) await shell.openExternal(safe.href);
  }

  destroy(hibernate = false): void {
    this.clearHibernate();
    const view = this.view;
    const win = this.getWindow();
    this.view = null;
    if (view) {
      if (win && !win.isDestroyed() && win.contentView.children.includes(view)) {
        win.contentView.removeChildView(view);
      }
      const wc = view.webContents;
      if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
    }
    const { url, title, overlayHidden } = this.state;
    this.state = {
      ...INITIAL_BLOG_VIEW_STATE,
      ...(hibernate ? { hibernated: true, url, title } : {}),
      overlayHidden,
    };
    this.emit(this.getState());
  }

  private ensureView(): WebContentsView {
    if (this.view && this.contents) return this.view;
    if (!this.sessionConfigured) {
      const blogSession = session.fromPartition(BLOG_SANDBOX_PARTITION);
      blogSession.setPermissionCheckHandler(() => false);
      blogSession.setPermissionRequestHandler((_wc, _permission, respond) => respond(false));
      blogSession.on('will-download', (event) => event.preventDefault());
      this.sessionConfigured = true;
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: BLOG_SANDBOX_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.view = view;
    const wc = view.webContents;
    const update = (patch: Partial<BlogViewState>) => {
      if (this.view === view) this.update(patch);
    };
    wc.setWindowOpenHandler(({ url }) => {
      const safe = parseBlogUrl(url);
      if (safe) this.navigate(safe);
      return { action: 'deny' };
    });
    wc.on('will-frame-navigate', (event) => {
      if (!parseBlogUrl(event.url)) event.preventDefault();
    });
    wc.on('will-redirect', (event) => {
      if (!parseBlogUrl(event.url)) {
        event.preventDefault();
        if (event.isMainFrame) update({ loading: false, loadError: BLOCKED_NAVIGATION });
      }
    });

    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        const safe = parseBlogUrl(details.url);
        if (safe) update({ url: safe.href, title: safe.hostname, loading: true, loadError: null });
      }
    });
    wc.on('did-navigate', (_event, url) => {
      const safe = parseBlogUrl(url);
      if (safe) update({ url: safe.href });
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      const safe = isMainFrame ? parseBlogUrl(url) : null;
      if (safe) update({ url: safe.href });
    });
    wc.on('page-title-updated', (_event, title) => {
      if (title) update({ title });
    });
    wc.on('did-stop-loading', () => update({ loading: false }));
    wc.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        const failedUrl = parseBlogUrl(url);
        update({ loading: false, loadError: this.state.loadError || LOAD_FAILED, ...(failedUrl ? { url: failedUrl.href } : {}) });
      }
    });
    wc.on('render-process-gone', () => {
      if (this.view !== view) return;
      const wasActive = this.state.active;
      this.destroy(true);
      this.update({ active: wasActive, loadError: LOAD_FAILED });
    });
    return view;
  }

  private update(patch: Partial<BlogViewState>): void {
    this.state = { ...this.state, ...patch };
    this.syncBounds();
    this.emit(this.getState());
  }

  private syncBounds(): void {
    const win = this.getWindow();
    const view = this.view;
    if (!win || win.isDestroyed() || !view || !this.contents) return;

    const attached = win.contentView.children.includes(view);
    const { active, overlayHidden, loadError } = this.state;
    if (active && !overlayHidden && !loadError && this.bounds.width > 0 && this.bounds.height > 0) {
      if (!attached) win.contentView.addChildView(view);
      view.setBounds(this.bounds);
      view.setVisible(true);
    } else if (attached) {
      view.setVisible(false);
      win.contentView.removeChildView(view);
    }
  }

  private clearHibernate(): void {
    if (this.hibernateTimer) clearTimeout(this.hibernateTimer);
    this.hibernateTimer = null;
  }
}
