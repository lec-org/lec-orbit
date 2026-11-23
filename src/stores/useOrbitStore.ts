/** Orbit 全局状态管理（Zustand）：协调身份、配置、弹窗栈与 LecDoc 视图避让、Punch SWR 数据流。 */
import { create } from 'zustand';
import {
  OrbitConfigSchema,
  type AuthState,
  type DocRecentItem,
  type DocViewState,
  type OrbitConfig,
  type OrbitConfigPatch,
  type UpdateCheckResult,
} from '@shared/ipc';
import type {
  InstalledMiniAppRecord,
  MiniAppBuiltinItem,
  MiniAppCatalogItem,
  MiniAppRuntimeSnapshot,
} from '@shared/miniapp';
import type {
  AttendanceRecordItem,
  AttendanceSnapshot,
  CardGameView,
  MyTitlesView,
  MyWeeklyStats,
  NetworkPolicyStatus,
  PointsSummary,
  PunchNotificationItem,
  TeamActiveMember,
  TeamEventItem,
  TeamWeeklyRankingItem,
} from '@shared/punch';
import { getOrbitClient } from '@/services/orbitClient';
import {
  orbitServerApi,
  type OrbitAnnouncement,
  type OrbitNotificationItem,
  type OrbitWsEvent,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { punchApi, PunchApiError } from '@/services/punchApi';

export type OrbitNavTab =
  | 'punch-today'
  | 'punch-growth'
  | 'punch-cards'
  | 'punch-studio'
  | 'doc'
  | 'hub'
  | 'inbox'
  | 'products'
  | 'settings';

export type GrowthSegment = 'calendar' | 'titles' | 'assessment' | 'report';

interface OrbitStoreState {
  ready: boolean;
  activeTab: OrbitNavTab;
  growthSegment: GrowthSegment;
  config: OrbitConfig;
  auth: AuthState;
  docState: DocViewState;
  docRecents: DocRecentItem[];

  /** 弹窗栈：任一弹窗打开时自动通知主进程隐藏原生 WebContentsView 避免层级遮挡。 */
  loginModalOpen: boolean;
  commandPaletteOpen: boolean;
  activeOverlayCount: number;

  /** Punch 核心数据（支持 SQLite SWR 秒开缓存） */
  punchLoading: boolean;
  punchError: string | null;
  attendance: AttendanceSnapshot | null;
  networkStatus: NetworkPolicyStatus | null;
  teamActive: TeamActiveMember[];
  weeklyStats: MyWeeklyStats | null;
  records: AttendanceRecordItem[];
  points: PointsSummary | null;
  cardGame: CardGameView | null;
  cardGameError: string | null;
  teamRanking: TeamWeeklyRankingItem[];
  teamEvents: TeamEventItem[];
  notifications: PunchNotificationItem[];
  myTitles: MyTitlesView | null;

  /** Orbit Go 后端实时公告（含 IM 已读回执）与跨应用通知总线 */
  orbitServerOnline: boolean;
  orbitAnnouncements: OrbitAnnouncement[];
  orbitNotifications: OrbitNotificationItem[];

  /** 全局 GitHub Releases 更新状态（跨页面共享与侧栏提醒） */
  updateInfo: UpdateCheckResult | null;
  updateBannerDismissed: boolean;

  /** 工坊（小程序 + 小游戏容器）运行态与目录数据 */
  hubRuntime: MiniAppRuntimeSnapshot;
  hubBuiltins: MiniAppBuiltinItem[];
  hubInstalled: InstalledMiniAppRecord[];
  hubCatalog: MiniAppCatalogItem[];
  hubLoading: boolean;
  hubError: string | null;

  bootstrap: () => Promise<void>;
  setActiveTab: (tab: OrbitNavTab) => void;
  setGrowthSegment: (segment: GrowthSegment) => void;
  openTitleCabinet: () => void;
  setAuthState: (auth: AuthState) => void;
  setDocState: (docState: DocViewState) => void;
  setHubRuntime: (snapshot: MiniAppRuntimeSnapshot) => void;
  refreshHubLocal: () => Promise<void>;
  refreshHubData: () => Promise<void>;
  setUpdateInfo: (info: UpdateCheckResult) => void;
  dismissUpdateBanner: () => void;
  updateConfig: (patch: OrbitConfigPatch) => Promise<void>;
  setLoginModalOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  pushOverlay: () => void;
  popOverlay: () => void;
  refreshDocRecents: (query?: string) => Promise<void>;
  refreshNetworkStatus: (forceWifiScan?: boolean) => Promise<NetworkPolicyStatus | null>;
  refreshPunchData: (options?: { notifyOnError?: boolean }) => Promise<void>;
  refreshCardGame: (options?: { silent?: boolean }) => Promise<void>;
  setCardGame: (game: CardGameView) => void;
  refreshOrbitCenter: () => Promise<void>;
  syncStaleData: (minIntervalMs?: number) => void;
  applyOrbitWsEvent: (event: OrbitWsEvent) => void;
  toggleCheckInOut: () => Promise<{ ok: boolean; message: string; status?: number }>;
  equipTitle: (titleId: string | null) => Promise<void>;
  ackNotification: (id: string) => Promise<void>;
}

const initialAuth: AuthState = {
  authenticated: false,
  profile: null,
  isStudioMember: false,
  isAdmin: false,
};

const initialDoc: DocViewState = {
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

let lastPunchSyncAt = 0;
let lastOrbitSyncAt = 0;
let lastCardSyncAt = 0;

function syncOverlayWithMain(state: {
  loginModalOpen: boolean;
  commandPaletteOpen: boolean;
  activeOverlayCount: number;
}): void {
  const anyOpen =
    state.loginModalOpen || state.commandPaletteOpen || state.activeOverlayCount > 0;
  void getOrbitClient().doc.setOverlayVisible(anyOpen);
}

export const useOrbitStore = create<OrbitStoreState>((set, get) => ({
  ready: false,
  activeTab: 'punch-today',
  growthSegment: 'calendar',
  config: OrbitConfigSchema.parse({}),
  auth: initialAuth,
  docState: initialDoc,
  docRecents: [],
  loginModalOpen: false,
  commandPaletteOpen: false,
  activeOverlayCount: 0,

  punchLoading: false,
  punchError: null,
  attendance: null,
  networkStatus: null,
  teamActive: [],
  weeklyStats: null,
  records: [],
  points: null,
  cardGame: null,
  cardGameError: null,
  teamRanking: [],
  teamEvents: [],
  notifications: [],
  myTitles: null,
  orbitServerOnline: false,
  orbitAnnouncements: [],
  orbitNotifications: [],
  updateInfo: null,
  updateBannerDismissed: false,
  hubRuntime: { apps: [] },
  hubBuiltins: [],
  hubInstalled: [],
  hubCatalog: [],
  hubLoading: false,
  hubError: null,

  bootstrap: async () => {
    const orbit = getOrbitClient();
    const [config, auth, docState, docRecents, updateInfo, hubRuntime, hubBuiltins, hubInstalled] =
      await Promise.all([
        orbit.system.getConfig(),
        orbit.auth.getState(),
        orbit.doc.getState(),
        orbit.doc.listRecents(),
        orbit.system.getUpdateState(),
        orbit.hub.getRuntimeSnapshot(),
        orbit.hub.listBuiltins(),
        orbit.hub.listInstalled(),
      ]);
    set({
      ready: true,
      config,
      auth,
      docState,
      docRecents,
      updateInfo,
      hubRuntime,
      hubBuiltins,
      hubInstalled,
      loginModalOpen: !auth.authenticated,
    });
    // 若主壳发生重载后当前不在「团队文档」页，但主进程 WebContentsView 仍处于激活态，立即兜底收起
    if (get().activeTab !== 'doc' && docState.active) {
      void orbit.doc.deactivate();
    }
    syncOverlayWithMain(get());

    // 先从 L3 SQLite 读 SWR 秒开缓存，再静默刷新最新接口
    const [cachedAttendance, cachedCardGame] = await Promise.all([
      orbit.storage.getCache<AttendanceSnapshot>('punch:attendance'),
      orbit.storage.getCache<CardGameView>('punch:card-game'),
    ]);
    if (cachedAttendance || cachedCardGame) {
      set({
        ...(cachedAttendance ? { attendance: cachedAttendance.value } : {}),
        ...(cachedCardGame ? { cardGame: cachedCardGame.value } : {}),
      });
      if (cachedCardGame?.value?.collection) {
        const ownedIds = cachedCardGame.value.collection
          .filter((c) => c.unlocked && c.quantity > 0)
          .map((c) => c.id);
        punchApi.prefetchCardArt(ownedIds);
      }
    }
    if (auth.authenticated) {
      void get().refreshPunchData();
      void get().refreshCardGame({ silent: true });
      void get().refreshOrbitCenter();
    }
  },

  setActiveTab: (tab) => {
    const prev = get().activeTab;
    if (tab !== 'doc' && (prev === 'doc' || get().docState.active)) {
      void getOrbitClient().doc.deactivate();
    }
    set({ activeTab: tab });
    if (!get().auth.authenticated) return;
    const now = Date.now();
    if (
      (tab === 'punch-today' || tab === 'punch-growth' || tab === 'punch-studio') &&
      now - lastPunchSyncAt >= 15_000
    ) {
      void get().refreshPunchData();
    } else if (tab === 'punch-cards') {
      if (!get().cardGame || now - lastCardSyncAt >= 15_000) {
        void get().refreshCardGame({ silent: Boolean(get().cardGame) });
      }
    } else if (tab === 'inbox') {
      if (now - lastOrbitSyncAt >= 15_000) void get().refreshOrbitCenter();
      if (now - lastPunchSyncAt >= 15_000) void get().refreshPunchData();
    } else if (tab === 'hub') {
      void get().refreshHubData();
    }
  },

  setGrowthSegment: (growthSegment) => set({ growthSegment }),

  openTitleCabinet: () => {
    set({ growthSegment: 'titles' });
    get().setActiveTab('punch-growth');
  },

  setAuthState: (auth) => {
    set({ auth, loginModalOpen: !auth.authenticated });
    syncOverlayWithMain(get());
    if (auth.authenticated) {
      void get().refreshPunchData();
      void get().refreshCardGame({ silent: true });
      void get().refreshOrbitCenter();
      void get().refreshDocRecents();
    } else {
      set({
        attendance: null,
        networkStatus: null,
        teamActive: [],
        weeklyStats: null,
        records: [],
        points: null,
        cardGame: null,
        cardGameError: null,
        teamRanking: [],
        teamEvents: [],
        notifications: [],
        myTitles: null,
        orbitServerOnline: false,
        orbitAnnouncements: [],
        orbitNotifications: [],
      });
    }
  },

  setDocState: (docState) => set({ docState }),

  setHubRuntime: (hubRuntime) => set({ hubRuntime }),

  refreshHubLocal: async () => {
    const orbit = getOrbitClient();
    const [hubBuiltins, hubInstalled, hubRuntime] = await Promise.all([
      orbit.hub.listBuiltins(),
      orbit.hub.listInstalled(),
      orbit.hub.getRuntimeSnapshot(),
    ]);
    set({ hubBuiltins, hubInstalled, hubRuntime });
  },

  refreshHubData: async () => {
    set({ hubLoading: true, hubError: null });
    try {
      await get().refreshHubLocal();
      if (get().auth.authenticated) {
        const items = await orbitServerApi.listMiniApps();
        set({ hubCatalog: items, hubLoading: false });
      } else {
        set({ hubLoading: false });
      }
    } catch (err) {
      set({
        hubLoading: false,
        hubError: err instanceof Error ? err.message : '拉取线上工坊列表失败（本地示例仍可正常运行）',
      });
    }
  },

  setUpdateInfo: (updateInfo) =>
    set((prev) => ({
      updateInfo,
      // 发现更新版本号或进入下载/就绪态时重新展示全局更新提示
      updateBannerDismissed:
        updateInfo.stage === 'downloading' ||
        updateInfo.stage === 'downloaded' ||
        (updateInfo.latestVersion && updateInfo.latestVersion !== prev.updateInfo?.latestVersion)
          ? false
          : prev.updateBannerDismissed,
    })),

  dismissUpdateBanner: () => set({ updateBannerDismissed: true }),

  updateConfig: async (patch) => {
    const next = await getOrbitClient().system.updateConfig(patch);
    set({ config: next });
  },

  setLoginModalOpen: (open) => {
    set({ loginModalOpen: open });
    syncOverlayWithMain(get());
  },

  setCommandPaletteOpen: (open) => {
    set({ commandPaletteOpen: open });
    syncOverlayWithMain(get());
    if (open) void get().refreshDocRecents();
  },

  pushOverlay: () => {
    set((s) => ({ activeOverlayCount: s.activeOverlayCount + 1 }));
    syncOverlayWithMain(get());
  },

  popOverlay: () => {
    set((s) => ({ activeOverlayCount: Math.max(0, s.activeOverlayCount - 1) }));
    syncOverlayWithMain(get());
  },

  refreshDocRecents: async (query) => {
    const docRecents = await getOrbitClient().doc.listRecents(query);
    set({ docRecents });
  },

  refreshNetworkStatus: async (forceWifiScan = false) => {
    if (!get().auth.authenticated) return null;
    try {
      const nextNetwork = await punchApi.fetchNetworkStatus(forceWifiScan);
      set({ networkStatus: nextNetwork });
      return nextNetwork;
    } catch {
      return get().networkStatus;
    }
  },

  refreshPunchData: async (options) => {
    if (!get().auth.authenticated) return;
    lastPunchSyncAt = Date.now();
    set({ punchLoading: true, punchError: null });
    try {
      const results = await Promise.allSettled([
        punchApi.fetchAttendance(),
        punchApi.fetchNetworkStatus(),
        punchApi.fetchTeamActive(),
        punchApi.fetchMyWeeklyStats(),
        punchApi.fetchMyRecords(30),
        punchApi.fetchPoints(),
        punchApi.fetchTeamWeeklyRanking(),
        punchApi.fetchTeamEvents(),
        punchApi.fetchNotifications('all', 30),
        punchApi.fetchMyTitles(),
      ]);
      const [
        attendance,
        networkStatus,
        teamActive,
        weeklyStats,
        records,
        points,
        teamRanking,
        teamEvents,
        notifications,
        myTitles,
      ] = results;

      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      const authExpiredErr = rejected.find(
        (r) => r.reason instanceof PunchApiError && r.reason.status === 401,
      )?.reason as PunchApiError | undefined;

      if (rejected.length > 0) {
        console.error(
          '[orbit:punch] refresh failures:',
          rejected.map((r) =>
            r.reason instanceof PunchApiError
              ? `${r.reason.status ?? 'net'}: ${r.reason.message}`
              : String(r.reason),
          ),
        );
      }

      if (authExpiredErr) {
        notifyToast({
          tone: 'error',
          title: 'LecPunch 鉴权失败（401）',
          description: authExpiredErr.message || '请重新登录以同步考勤数据与网络策略。',
          action: {
            label: '重新登录',
            onClick: () => get().setLoginModalOpen(true),
          },
        });
      } else if (options?.notifyOnError && rejected.length === results.length) {
        const firstErr = rejected[0]?.reason;
        notifyToast({
          tone: 'error',
          title: '同步 LecPunch 数据失败',
          description: firstErr instanceof Error ? firstErr.message : '请检查校园网络连接后重试。',
        });
      }

      const nextRecords = records.status === 'fulfilled' ? records.value : get().records;
      const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const todayCompletedSeconds = nextRecords
        .filter((r) => r.status !== 'active' && r.status !== 'invalidated')
        .filter((r) => {
          const d = r.checkInTime ? new Date(r.checkInTime) : null;
          if (!d || Number.isNaN(d.getTime())) return false;
          return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d) === todayKey;
        })
        .reduce((sum, r) => sum + (r.durationSeconds || 0), 0);

      const rawAttendance = attendance.status === 'fulfilled' ? attendance.value : get().attendance;
      const nextAttendance = rawAttendance
        ? {
            ...rawAttendance,
            todayDurationSeconds: rawAttendance.todayDurationSeconds || todayCompletedSeconds,
          }
        : null;
      const nextNetwork =
        networkStatus.status === 'fulfilled' ? networkStatus.value : get().networkStatus;
      const nextWeekly =
        weeklyStats.status === 'fulfilled' ? weeklyStats.value : get().weeklyStats;
      if (nextAttendance) {
        void getOrbitClient().storage.setCache('punch:attendance', nextAttendance);
      }
      void getOrbitClient().system.updateTrayPunch({
        checkedIn: Boolean(nextAttendance?.isCheckedIn),
        elapsedSeconds: nextAttendance?.currentSessionSeconds ?? 0,
        todaySeconds: nextAttendance?.todayDurationSeconds ?? 0,
        weekSeconds: nextWeekly?.totalDurationSeconds ?? nextAttendance?.weekDurationSeconds ?? 0,
        weekTargetSeconds:
          nextWeekly?.targetDurationSeconds ?? nextAttendance?.weekTargetSeconds ?? 18 * 3600,
        networkAllowed: nextNetwork ? nextNetwork.allowed : true,
        authenticated: get().auth.authenticated,
        statusLabel: nextAttendance?.isCheckedIn ? '专注中' : '未打卡',
      });
      set({
        punchLoading: false,
        attendance: nextAttendance,
        networkStatus: nextNetwork,
        teamActive: teamActive.status === 'fulfilled' ? teamActive.value : get().teamActive,
        weeklyStats: nextWeekly,
        records: nextRecords,
        points: points.status === 'fulfilled' ? points.value : get().points,
        teamRanking: teamRanking.status === 'fulfilled' ? teamRanking.value : get().teamRanking,
        teamEvents: teamEvents.status === 'fulfilled' ? teamEvents.value : get().teamEvents,
        notifications: notifications.status === 'fulfilled' ? notifications.value : get().notifications,
        myTitles: myTitles.status === 'fulfilled' ? myTitles.value : get().myTitles,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '拉取 LecPunch 数据失败。';
      set({ punchLoading: false, punchError: msg });
      notifyToast({
        tone: 'error',
        title: '拉取 LecPunch 数据失败',
        description: msg,
      });
    }
  },

  toggleCheckInOut: async () => {
    const { attendance, networkStatus } = get();
    const isCheckedIn = Boolean(attendance?.isCheckedIn);
    if (!isCheckedIn && networkStatus && !networkStatus.allowed && !networkStatus.wifiFingerprintEnabled) {
      return {
        ok: false,
        message: networkStatus.reason || '当前网络不在工作室允许签到的白名单范围内。',
      };
    }
    try {
      const updated = isCheckedIn ? await punchApi.checkOut() : await punchApi.checkIn();
      set({ attendance: updated });
      void getOrbitClient().storage.setCache('punch:attendance', updated);
      void get().refreshPunchData();
      return {
        ok: true,
        message: isCheckedIn ? '已签退，本次专注时长已记录。' : '签到成功，开始今日专注！',
      };
    } catch (err) {
      if (err instanceof PunchApiError && err.status === 403) {
        void get().refreshNetworkStatus(false);
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : '考勤操作失败，请检查网络策略与登录状态。',
        status: err instanceof PunchApiError ? err.status : undefined,
      };
    }
  },

  setCardGame: (cardGame) => {
    lastCardSyncAt = Date.now();
    set({ cardGame, cardGameError: null });
    void getOrbitClient().storage.setCache('punch:card-game', cardGame);
  },

  refreshCardGame: async (options) => {
    if (!get().auth.authenticated) return;
    lastCardSyncAt = Date.now();
    if (!options?.silent) {
      set({ cardGameError: null });
    }
    try {
      const data = await punchApi.fetchCardGame();
      set({ cardGame: data, cardGameError: null });
      void getOrbitClient().storage.setCache('punch:card-game', data);
      const ownedOrUnlocked = data.collection
        .filter((c) => c.unlocked)
        .sort((a, b) => b.quantity - a.quantity)
        .map((c) => c.id);
      punchApi.prefetchCardArt(ownedOrUnlocked);
    } catch (err) {
      if (!options?.silent || !get().cardGame) {
        set({
          cardGameError: err instanceof Error ? err.message : '加载卡牌工坊失败，请稍后重试。',
        });
      }
    }
  },

  syncStaleData: (minIntervalMs = 15_000) => {
    if (!get().auth.authenticated) return;
    const now = Date.now();
    if (now - lastPunchSyncAt >= minIntervalMs) {
      void get().refreshPunchData();
    }
    if (now - lastCardSyncAt >= minIntervalMs) {
      void get().refreshCardGame({ silent: true });
    }
    if (now - lastOrbitSyncAt >= minIntervalMs) {
      void get().refreshOrbitCenter();
    }
  },

  refreshOrbitCenter: async () => {
    if (!get().auth.authenticated) return;
    lastOrbitSyncAt = Date.now();
    try {
      const [announcements, notifications] = await Promise.all([
        orbitServerApi.listAnnouncements(),
        orbitServerApi.listNotifications(),
      ]);
      set({
        orbitServerOnline: true,
        orbitAnnouncements: announcements,
        orbitNotifications: notifications,
      });
    } catch {
      set({ orbitServerOnline: false });
    }
  },

  applyOrbitWsEvent: (event) => {
    const mySub = get().auth.profile?.subject;
    if (event.type === 'announcement.created') {
      const ann = event.payload as unknown as OrbitAnnouncement;
      const isAuthor = ann.authorId === mySub;
      set((s) => ({
        orbitServerOnline: true,
        orbitAnnouncements: [
          { ...ann, isReadByMe: isAuthor },
          ...s.orbitAnnouncements.filter((a) => a.id !== ann.id),
        ],
      }));
      if (!isAuthor) {
        void getOrbitClient().system.notify('工作室新公告', ann.title);
        notifyToast({
          tone: 'info',
          title: '收到新公告',
          description: ann.title,
          action: { label: '立即查看', onClick: () => get().setActiveTab('inbox') },
        });
      }
      return;
    }
    if (event.type === 'announcement.updated') {
      const p = event.payload;
      set((s) => ({
        orbitAnnouncements: s.orbitAnnouncements.map((a) =>
          a.id === String(p.id)
            ? {
                ...a,
                title: typeof p.title === 'string' ? p.title : a.title,
                contentHtml: typeof p.contentHtml === 'string' ? p.contentHtml : a.contentHtml,
                contentText: typeof p.contentText === 'string' ? p.contentText : a.contentText,
                pinned: typeof p.pinned === 'boolean' ? p.pinned : a.pinned,
                updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : a.updatedAt,
              }
            : a,
        ),
      }));
      return;
    }
    if (event.type === 'announcement.deleted') {
      const id = String(event.payload.id ?? '');
      set((s) => ({
        orbitAnnouncements: s.orbitAnnouncements.filter((a) => a.id !== id),
      }));
      return;
    }
    if (event.type === 'announcement.receipt') {
      const p = event.payload;
      const annId = String(p.announcementId ?? '');
      const readerId = String(p.userId ?? '');
      set((s) => ({
        orbitAnnouncements: s.orbitAnnouncements.map((a) =>
          a.id === annId
            ? {
                ...a,
                readCount: typeof p.readCount === 'number' ? p.readCount : a.readCount,
                totalCount: typeof p.totalCount === 'number' ? p.totalCount : a.totalCount,
                isReadByMe: a.isReadByMe || readerId === mySub,
              }
            : a,
        ),
      }));
      return;
    }
    if (event.type === 'notification.created') {
      const notif = event.payload as unknown as OrbitNotificationItem;
      set((s) => ({
        orbitServerOnline: true,
        orbitNotifications: [notif, ...s.orbitNotifications.filter((n) => n.id !== notif.id)],
      }));
      void getOrbitClient().system.notify(notif.title, notif.body);
      notifyToast({
        tone: notif.eventType === 'doc.edit_request' ? 'info' : 'success',
        title: notif.title,
        description: notif.body,
        action: { label: '前往处理', onClick: () => get().setActiveTab('inbox') },
      });
      return;
    }
    if (event.type === 'notification.updated') {
      const p = event.payload;
      const id = String(p.id ?? '');
      set((s) => ({
        orbitNotifications: s.orbitNotifications.map((n) =>
          n.id === id
            ? {
                ...n,
                actionStatus:
                  (p.actionStatus as OrbitNotificationItem['actionStatus']) ?? n.actionStatus,
                actionNote: typeof p.actionNote === 'string' ? p.actionNote : n.actionNote,
                isRead: typeof p.isRead === 'boolean' ? p.isRead : n.isRead,
              }
            : n,
        ),
      }));
    }
  },

  equipTitle: async (titleId) => {
    try {
      const updated = await punchApi.equipTitle(titleId);
      set({ myTitles: updated });
      const activeName = updated.displayTitles.find((t) => !t.forced)?.name;
      notifyToast({
        tone: 'success',
        title: titleId ? `已佩戴「${activeName ?? '新称号'}」` : '已恢复自动佩戴',
        description: '你的工作室在岗卡片与团队周榜已同步更新。',
      });
      void get().refreshPunchData();
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '切换称号失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  },

  ackNotification: async (id) => {
    try {
      await punchApi.acknowledgeNotification(id);
      set((s) => ({
        notifications: s.notifications.map((n) => (n.id === id ? { ...n, status: 'acknowledged' } : n)),
      }));
      notifyToast({ tone: 'success', title: '已标记为已读' });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '标记已读失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  },
}));
