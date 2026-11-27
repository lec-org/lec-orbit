/**
 * 西南石油大学（SWPU）金智 EMAP 教务课表抓取器：
 * - 使用独立 Electron BrowserWindow 与隔离 Session（persist:swpu-jw），绝不污染 LecSSO 登录态
 * - 教务账号密码仅由用户在官方统一身份认证页输入，Orbit 不接触也不存储明文密码
 * - 默认开启直连模式绕过异常本机抓包代理，并支持一键切换系统代理 / WebVPN
 * - 登录成功后自动同源调用金智 xnxq.do / classWeek.do / cxxszhxqkb.do，直接输出结构化预览
 */
import { BrowserWindow, session } from 'electron';
import {
  INITIAL_SWPU_IMPORT_STATE,
  SWPU_SSO_LOGIN_URL,
  SWPU_WEBVPN_LOGIN_URL,
  formatLocalDate,
  inferTermStartDate,
  parseSwpuWiseduRows,
  type SwpuImportPreview,
  type SwpuImportWindowState,
  type SwpuNetworkMode,
  type SwpuTermOption,
} from '../../src/shared/schedule';

export const SWPU_IMPORT_PARTITION = 'persist:swpu-jw';

interface RawPageFetchResult {
  ok: boolean;
  error?: string;
  terms: SwpuTermOption[];
  selectedTermCode: string;
  selectedTermName: string;
  classWeek: number | null;
  holidays: string[];
  rows: Array<Record<string, unknown>>;
}

export class SwpuScheduleImporter {
  private win: BrowserWindow | null = null;
  private state: SwpuImportWindowState = { ...INITIAL_SWPU_IMPORT_STATE };
  private autoFetchInFlight = false;
  private lastAutoFetchedOrigin = '';
  private configuredProxyMode: SwpuNetworkMode | null = null;

  constructor(
    private readonly getParentWindow: () => BrowserWindow | null,
    private readonly onStateChanged: (state: SwpuImportWindowState) => void,
  ) {}

  getState(): SwpuImportWindowState {
    return this.state;
  }

  private emit(patch: Partial<SwpuImportWindowState>): SwpuImportWindowState {
    this.state = { ...this.state, ...patch };
    this.onStateChanged(this.state);
    return this.state;
  }

  private isSwpuJwUrl(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl);
      const isSwpuHost =
        u.hostname === 'deanservices.swpu.edu.cn' ||
        u.hostname.endsWith('.swpu.edu.cn');
      return isSwpuHost && u.pathname.includes('/jwapp/');
    } catch {
      return false;
    }
  }

  private async configureSession(mode: SwpuNetworkMode): Promise<Electron.Session> {
    const sess = session.fromPartition(SWPU_IMPORT_PARTITION);
    // 仅在网络模式实际变化时重设代理，避免反复重建连接池拖慢首屏
    if (this.configuredProxyMode !== mode) {
      if (mode === 'direct' || mode === 'webvpn') {
        await sess.setProxy({ mode: 'direct' });
      } else {
        await sess.setProxy({ mode: 'system' });
      }
      this.configuredProxyMode = mode;
    }
    const ua = sess
      .getUserAgent()
      .replace(/\sElectron\/[\d.]+/g, '')
      .replace(/\s@lec-orbit\/desktop\/[\d.]+/g, '');
    sess.setUserAgent(ua);
    return sess;
  }

  private buildLoadingPlaceholderHtml(entryUrl: string): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    background: #f5f7fb; color: #1e293b;
  }
  .spinner {
    width: 30px; height: 30px; border-radius: 50%;
    border: 3px solid rgba(37, 99, 235, 0.18);
    border-top-color: #2563eb;
    animation: spin 0.8s linear infinite;
  }
  .title { font-size: 15px; font-weight: 600; }
  .sub { font-size: 12px; color: #64748b; max-width: 520px; text-align: center; word-break: break-all; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="spinner"></div>
  <div class="title">正在连接西南石油大学统一身份认证…</div>
  <div class="sub">${entryUrl}</div>
</body>
</html>`;
  }

  /** 判断某个 WebContents 是否属于本导入器（用于 certificate-error 精准范围放行） */
  ownsWebContents(wc: Electron.WebContents): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === wc);
  }

  async openLoginWindow(options?: {
    networkMode?: SwpuNetworkMode;
    clearSession?: boolean;
  }): Promise<SwpuImportWindowState> {
    const networkMode: SwpuNetworkMode = options?.networkMode ?? this.state.networkMode ?? 'system';
    const entryUrl = networkMode === 'webvpn' ? SWPU_WEBVPN_LOGIN_URL : SWPU_SSO_LOGIN_URL;
    const sess = await this.configureSession(networkMode);

    if (options?.clearSession) {
      await sess.clearStorageData({ storages: ['cookies', 'localstorage', 'shadercache'] });
    }

    this.lastAutoFetchedOrigin = '';
    this.autoFetchInFlight = false;

    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      this.emit({
        open: true,
        stage: 'waiting_login',
        networkMode,
        currentUrl: entryUrl,
        error: null,
        message: '正在加载西柚统一身份认证，请稍候…',
      });
      await this.win.loadURL(entryUrl).catch(() => undefined);
      return this.state;
    }

    const parent = this.getParentWindow();
    const bounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
    const width = 1120;
    const height = 760;
    const win = new BrowserWindow({
      width,
      height,
      x: bounds ? Math.round(bounds.x + (bounds.width - width) / 2) : undefined,
      y: bounds ? Math.round(bounds.y + (bounds.height - height) / 2) : undefined,
      minWidth: 820,
      minHeight: 560,
      backgroundColor: '#f5f7fb',
      title: '正在连接… · 西南石油大学教务登录',
      autoHideMenuBar: true,
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;

    const wc = win.webContents;

    // 教务门户常使用 target="_blank" 打开子系统，统一在当前窗口内承载，避免丢失上下文
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void wc.loadURL(url);
      }
      return { action: 'deny' };
    });

    const handleNavigation = (url: string) => {
      if (!url || win.isDestroyed() || !url.startsWith('http')) return;
      this.emit({ currentUrl: url });
      if (this.isSwpuJwUrl(url)) {
        const origin = new URL(url).origin;
        if (!this.autoFetchInFlight && this.lastAutoFetchedOrigin !== origin) {
          this.lastAutoFetchedOrigin = origin;
          setTimeout(() => {
            void this.fetchSchedule();
          }, 600);
        }
      }
    };

    wc.on('did-start-loading', () => {
      if (win.isDestroyed()) return;
      win.setTitle('正在加载… · 西南石油大学教务登录');
    });
    wc.on('did-stop-loading', () => {
      if (win.isDestroyed()) return;
      win.setTitle('西南石油大学教务登录 · Orbit 课表导入');
    });
    wc.on('did-navigate', (_evt, url) => handleNavigation(url));
    wc.on('did-navigate-in-page', (_evt, url) => handleNavigation(url));
    wc.on('did-finish-load', () => {
      if (win.isDestroyed()) return;
      const url = wc.getURL();
      if (!url.startsWith('http')) return;
      if (this.isSwpuJwUrl(url)) {
        if (!this.autoFetchInFlight && !this.state.preview) {
          void this.fetchSchedule();
        }
      } else if (this.state.stage === 'waiting_login') {
        this.emit({
          message: '教务登录页已就绪，请完成统一身份认证，登录后将自动提取课表',
        });
      }
    });

    wc.on('did-fail-load', (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      console.warn('[orbit:swpu-import] did-fail-load:', { errorCode, errorDescription, validatedURL });
      this.emit({
        stage: 'error',
        error: `页面加载失败（${errorCode}: ${errorDescription}）`,
        message: '连接教务系统失败，可尝试切换「跟随系统 / 直连 / WebVPN」模式重试',
        currentUrl: validatedURL || this.state.currentUrl,
      });
    });

    win.on('closed', () => {
      this.win = null;
      this.autoFetchInFlight = false;
      this.emit({
        open: false,
        stage: this.state.preview ? 'ready' : 'idle',
      });
    });

    this.emit({
      open: true,
      stage: 'waiting_login',
      networkMode,
      currentUrl: entryUrl,
      error: null,
      preview: null,
      message: '正在连接西柚统一身份认证，请稍候…',
    });

    // 先瞬时渲染加载提示消除白屏等待感，紧接着发起真实导航
    await win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.buildLoadingPlaceholderHtml(entryUrl))}`)
      .catch(() => undefined);

    const startedAt = Date.now();
    await win
      .loadURL(entryUrl)
      .then(() => {
        console.info(`[orbit:swpu-import] loaded entry in ${Date.now() - startedAt}ms (mode=${networkMode})`);
      })
      .catch((err) => {
        console.warn('[orbit:swpu-import] loadURL error:', err);
        this.emit({
          stage: 'error',
          error: err instanceof Error ? err.message : String(err),
          message: '打开教务登录页失败，请检查网络连接或切换代理模式',
        });
      });

    return this.state;
  }

  /** 在当前已登录的西柚教务窗口中主动拉取指定学期（或默认当前学期）课表 */
  async fetchSchedule(requestedTermCode?: string): Promise<SwpuImportWindowState> {
    if (!this.win || this.win.isDestroyed()) {
      return this.emit({
        stage: 'error',
        error: '教务登录窗口已关闭，请重新打开登录窗口',
        message: '请重新打开教务登录窗口',
      });
    }

    const wc = this.win.webContents;
    const currentUrl = wc.getURL();
    if (!this.isSwpuJwUrl(currentUrl)) {
      return this.emit({
        stage: 'waiting_login',
        error: null,
        message: '当前尚未进入教务系统页面，请先完成统一身份认证登录',
      });
    }

    this.autoFetchInFlight = true;
    this.emit({
      stage: 'fetching',
      error: null,
      message: requestedTermCode
        ? `正在拉取 ${requestedTermCode} 学期课表…`
        : '已登录西柚教务，正在自动获取学期、教学周与完整课表…',
    });

    const todayStr = formatLocalDate(new Date());
    const safeTermArg = JSON.stringify(requestedTermCode ?? '');

    try {
      const raw = (await wc.executeJavaScript(`(async () => {
        const requestedTerm = ${safeTermArg};
        const today = ${JSON.stringify(todayStr)};
        const headers = { 'X-Requested-With': 'XMLHttpRequest' };

        // 1. 拉取全部可选学期与当前默认学期
        let terms = [];
        let selectedTermCode = requestedTerm || '';
        let selectedTermName = '';
        try {
          const r = await fetch('/jwapp/sys/homeapp/api/home/kb/xnxq.do', {
            method: 'GET',
            credentials: 'include',
            headers,
          });
          if (r.ok) {
            const j = await r.json();
            const list = Array.isArray(j?.datas) ? j.datas : [];
            terms = list
              .filter((x) => x && x.itemCode)
              .map((x) => ({
                code: String(x.itemCode),
                name: String(x.itemName || x.itemCode),
                selected: Boolean(x.selected),
              }));
            if (!selectedTermCode) {
              const hit = terms.find((t) => t.selected) || terms[0];
              if (hit) {
                selectedTermCode = hit.code;
                selectedTermName = hit.name;
              }
            } else {
              const hit = terms.find((t) => t.code === selectedTermCode);
              selectedTermName = hit ? hit.name : selectedTermCode;
            }
          }
        } catch {}

        // 兜底：若 homeapp 学期接口未取到，回退 wdkb/dqxnxq.do
        if (!selectedTermCode) {
          try {
            const r = await fetch('/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do', {
              method: 'POST',
              credentials: 'include',
              headers,
            });
            if (r.ok) {
              const j = await r.json();
              const row = j?.datas?.dqxnxq?.rows?.[0];
              if (row?.DM) {
                selectedTermCode = String(row.DM);
                selectedTermName = String(row.MC || row.DM);
                if (terms.length === 0) {
                  terms = [{ code: selectedTermCode, name: selectedTermName, selected: true }];
                }
              }
            }
          } catch {}
        }

        if (!selectedTermCode) {
          return { ok: false, error: '未能获取到学年学期信息，请确认已完成教务系统登录', terms: [], selectedTermCode: '', selectedTermName: '', classWeek: null, holidays: [], rows: [] };
        }

        // 2. 拉取当前教学周（用于反推本学期第 1 周周一开学日期）
        let classWeek = null;
        try {
          const r = await fetch('/jwapp/sys/homeapp/api/home/teachingSchedule/classWeek.do?rq=' + encodeURIComponent(today), {
            method: 'GET',
            credentials: 'include',
            headers,
          });
          if (r.ok) {
            const j = await r.json();
            const w = Number(j?.datas?.classWeek);
            if (Number.isInteger(w) && w >= 1 && w <= 30) classWeek = w;
          }
        } catch {}

        // 3. 尝试提取本月节假日标记（非必需，失败静默忽略）
        let holidays = [];
        try {
          const r = await fetch('/jwapp/sys/homeapp/api/home/teachingSchedule/list.do?rq=' + encodeURIComponent(today) + '&lxdm=student', {
            method: 'GET',
            credentials: 'include',
            headers,
          });
          if (r.ok) {
            const j = await r.json();
            const items = Array.isArray(j?.datas) ? j.datas : [];
            const jjr = items.find((x) => x && (x.bizKey === 'JJR' || x.category === 'JJR'));
            if (Array.isArray(jjr?.days)) {
              holidays = jjr.days.filter((d) => typeof d === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(d));
            }
          }
        } catch {}

        // 4. 拉取整学期完整课表
        const kbRes = await fetch('/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do', {
          method: 'POST',
          credentials: 'include',
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: new URLSearchParams({ XNXQDM: selectedTermCode }).toString(),
        });
        if (!kbRes.ok) {
          return { ok: false, error: '拉取课表接口失败（HTTP ' + kbRes.status + '）', terms, selectedTermCode, selectedTermName, classWeek, holidays, rows: [] };
        }
        const kbJson = await kbRes.json();
        const rows = Array.isArray(kbJson?.datas?.cxxszhxqkb?.rows)
          ? kbJson.datas.cxxszhxqkb.rows
          : [];

        return {
          ok: true,
          terms,
          selectedTermCode,
          selectedTermName: selectedTermName || selectedTermCode,
          classWeek,
          holidays,
          rows,
        };
      })()`)) as RawPageFetchResult;

      if (!raw || !raw.ok) {
        return this.emit({
          stage: 'error',
          error: raw?.error || '未能解析到课表数据，请确认已成功进入教务首页',
          message: raw?.error || '拉取课表失败',
        });
      }

      const parsed = parseSwpuWiseduRows(raw.rows);
      const isDefaultTerm =
        !requestedTermCode ||
        raw.terms.some((t) => t.code === raw.selectedTermCode && t.selected);
      const inferredStartDate =
        isDefaultTerm && raw.classWeek != null
          ? inferTermStartDate(todayStr, raw.classWeek, 1)
          : inferTermStartDate(todayStr, 1, 1);

      const preview: SwpuImportPreview = {
        termCode: raw.selectedTermCode,
        termName: raw.selectedTermName,
        terms: raw.terms,
        inferredStartDate,
        currentClassWeek: isDefaultTerm ? raw.classWeek : null,
        campus: parsed.campus,
        holidays: raw.holidays,
        courseCount: parsed.courseCount,
        meetingCount: parsed.meetingCount,
        courses: parsed.courses,
      };

      // 成功抓到数据后将主窗口前置，方便用户在 Orbit 预览确认导入
      const parent = this.getParentWindow();
      if (parent && !parent.isDestroyed()) {
        parent.focus();
      }

      return this.emit({
        stage: 'ready',
        error: null,
        preview,
        message:
          parsed.courseCount > 0
            ? `已提取 ${preview.termName}：共 ${parsed.courseCount} 门课程（${parsed.meetingCount} 条排课）`
            : `${preview.termName} 暂无排课记录，可切换其他学期查看`,
      });
    } catch (err) {
      return this.emit({
        stage: 'error',
        error: err instanceof Error ? err.message : String(err),
        message: '提取课表时发生异常，请点击「重新抓取」重试',
      });
    } finally {
      this.autoFetchInFlight = false;
    }
  }

  close(): SwpuImportWindowState {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
    this.autoFetchInFlight = false;
    return this.emit({
      open: false,
      stage: this.state.preview ? 'ready' : 'idle',
    });
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}
