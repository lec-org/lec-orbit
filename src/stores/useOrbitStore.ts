/** Orbit 全局状态管理（Zustand）：协调身份、配置、弹窗避让与本地缓存。 */
import { create } from 'zustand';
import { useScheduleStore } from './useScheduleStore';
import {
  INITIAL_BLOG_VIEW_STATE,
  OrbitConfigSchema,
  type AuthState,
  type BlogViewState,
  type DocRecentItem,
  type DocViewState,
  type OrbitConfig,
  type OrbitConfigPatch,
  type StudioMemberCard,
  type UpdateCheckResult,
} from '@shared/ipc';
import { parseBlogUrl } from '@shared/blogUrl';
import type {
  InstalledMiniAppRecord,
  MiniAppBuiltinItem,
  MiniAppCatalogItem,
  MiniAppDisplayMode,
  MiniAppLaunchRoomContext,
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
import { useCalendarStore } from '@/stores/useCalendarStore';
import {
  blogApi,
  BlogApiError,
  type BlogPublicConfig,
  type MemberBlogItem,
  type MyBlogDetail,
} from '@/services/blogApi';
import {
  orbitServerApi,
  type ActiveHubPlayer,
  type OrbitAnnouncement,
  type OrbitNotificationItem,
  type OrbitWsEvent,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { punchApi, PunchApiError } from '@/services/punchApi';

export type OrbitNavTab =
  | 'punch-today'
  | 'schedule'
  | 'punch-growth'
  | 'punch-cards'
  | 'punch-studio'
  | 'doc'
  | 'blogs'
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
  memberBlogs: MemberBlogItem[];
  myBlog: MyBlogDetail | null;
  blogPublicConfig: BlogPublicConfig | null;
  blogState: BlogViewState;
  selectedBlogUserId: string | null;
  pendingBlogUrl: string | null;
  blogsLoading: boolean;
  blogsError: string | null;

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
  /** 狂热打卡状态与触发人数阈值（优先消费后端 /attendance/team-active 下发结果） */
  feverActive: boolean;
  feverThreshold: number;
  weeklyStats: MyWeeklyStats | null;
  records: AttendanceRecordItem[];
  points: PointsSummary | null;
  cardGame: CardGameView | null;
  cardGameError: string | null;
  teamRanking: TeamWeeklyRankingItem[];
  teamEvents: TeamEventItem[];
  notifications: PunchNotificationItem[];
  myTitles: MyTitlesView | null;

  /** LecSSO 工作室成员公开名片目录（跨工作室动态与今日在岗弹窗共享） */
  studioMembers: StudioMemberCard[];
  studioMembersLoading: boolean;
  studioMembersError: string | null;

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
  hubPresence: ActiveHubPlayer[];
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
  refreshHubPresence: () => Promise<void>;
  setBlogState: (blogState: BlogViewState) => void;
  setMyBlog: (myBlog: MyBlogDetail | null) => void;
  openBlogTarget: (userId: string, url?: string) => void;
  consumeBlogUrl: () => string | null;
  clearBlogTarget: (userId: string) => void;
  refreshMemberBlogs: () => Promise<void>;
  refreshBlogPublicConfig: (force?: boolean) => Promise<BlogPublicConfig | null>;
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
  refreshStudioMembers: (force?: boolean) => Promise<void>;
  refreshCardGame: (options?: { silent?: boolean }) => Promise<void>;
  setCardGame: (game: CardGameView) => void;
  refreshOrbitCenter: () => Promise<void>;
  acceptHubRoomInvite: (notif: OrbitNotificationItem) => Promise<void>;
  denyHubRoomInvite: (notif: OrbitNotificationItem) => Promise<void>;
  syncStaleData: (minIntervalMs?: number) => void;
  sendAttendanceHeartbeat: () => Promise<void>;
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
let consecutiveEnvMisses = 0;
let lastEnvLeaveNotifiedAt = 0;
let heartbeatInFlight = false;
let blogsRequestId = 0;
let blogConfigInFlight: Promise<BlogPublicConfig | null> | null = null;
const MEMBER_BLOG_CACHE = 'blogs:members';

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
  memberBlogs: [],
  myBlog: null,
  blogPublicConfig: null,
  blogState: INITIAL_BLOG_VIEW_STATE,
  selectedBlogUserId: null,
  pendingBlogUrl: null,
  blogsLoading: false,
  blogsError: null,
  loginModalOpen: false,
  commandPaletteOpen: false,
  activeOverlayCount: 0,

  punchLoading: false,
  punchError: null,
  attendance: null,
  networkStatus: null,
  teamActive: [],
  feverActive: false,
  feverThreshold: 12,
  weeklyStats: null,
  records: [],
  points: null,
  cardGame: null,
  cardGameError: null,
  teamRanking: [],
  teamEvents: [],
  notifications: [],
  myTitles: null,
  studioMembers: [],
  studioMembersLoading: false,
  studioMembersError: null,
  orbitServerOnline: false,
  orbitAnnouncements: [],
  orbitNotifications: [],
  updateInfo: null,
  updateBannerDismissed: false,
  hubRuntime: { apps: [] },
  hubBuiltins: [],
  hubInstalled: [],
  hubCatalog: [],
  hubPresence: [],
  hubLoading: false,
  hubError: null,

  bootstrap: async () => {
    const orbit = getOrbitClient();
    const [
      config,
      auth,
      docState,
      blogState,
      docRecents,
      updateInfo,
      hubRuntime,
      hubBuiltins,
      hubInstalled,
    ] = await Promise.all([
      orbit.system.getConfig(),
      orbit.auth.getState(),
      orbit.doc.getState(),
      orbit.blog.getState(),
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
      blogState,
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
    if (get().activeTab !== 'blogs' && blogState.active) {
      void orbit.blog.deactivate();
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
      void get().refreshStudioMembers();
      void get().refreshMemberBlogs();
      void get().refreshCardGame({ silent: true });
      void get().refreshOrbitCenter();
    }
  },

  setActiveTab: (tab) => {
    const prev = get().activeTab;
    if (tab !== 'doc' && (prev === 'doc' || get().docState.active)) {
      void getOrbitClient().doc.deactivate();
    }
    if (tab !== 'blogs' && (prev === 'blogs' || get().blogState.active)) {
      void getOrbitClient().blog.deactivate();
    }
    if (tab !== 'hub' && prev === 'hub') {
      void getOrbitClient().hub.setWorkspaceBounds({ x: 0, y: 0, width: 0, height: 0 });
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
    const previous = get().auth;
    if (auth.authenticated !== previous.authenticated || auth.profile?.subject !== previous.profile?.subject) {
      blogsRequestId++;
      consecutiveEnvMisses = 0;
      lastEnvLeaveNotifiedAt = 0;
      void getOrbitClient().blog.deactivate();
      // 登出或切换账号时同步重置日历与课表 Store，防止旧账号日程/课表残留串号并污染新账号云端快照
      useCalendarStore.getState().reset();
      useScheduleStore.getState().reset();
      set({
        memberBlogs: [],
        myBlog: null,
        blogState: INITIAL_BLOG_VIEW_STATE,
        selectedBlogUserId: null,
        pendingBlogUrl: null,
        blogsLoading: false,
        blogsError: null,
      });
    }
    set({ auth, loginModalOpen: !auth.authenticated });
    syncOverlayWithMain(get());
    if (auth.authenticated) {
      void get().refreshPunchData();
      void get().refreshStudioMembers();
      void get().refreshCardGame({ silent: true });
      void get().refreshOrbitCenter();
      void get().refreshDocRecents();
    } else {
      set({
        attendance: null,
        networkStatus: null,
        teamActive: [],
        feverActive: false,
        feverThreshold: 12,
        weeklyStats: null,
        records: [],
        points: null,
        cardGame: null,
        cardGameError: null,
        teamRanking: [],
        teamEvents: [],
        notifications: [],
        myTitles: null,
        studioMembers: [],
        studioMembersLoading: false,
        studioMembersError: null,
        orbitServerOnline: false,
        orbitAnnouncements: [],
        orbitNotifications: [],
      });
    }
  },

  setDocState: (docState) => set({ docState }),
  setBlogState: (blogState) => set({ blogState }),
  setMyBlog: (myBlog) => set({ myBlog }),

  openBlogTarget: (userId, url) => {
    const target = parseBlogUrl(url ?? get().memberBlogs.find((blog) => blog.userId === userId)?.blogUrl);
    if (!userId.trim() || !target) return;
    get().setActiveTab('blogs');
    set({ selectedBlogUserId: userId, pendingBlogUrl: target.href });
  },

  consumeBlogUrl: () => {
    const pending = get().pendingBlogUrl;
    if (pending) set({ pendingBlogUrl: null });
    return pending;
  },

  clearBlogTarget: (userId) => {
    if (get().selectedBlogUserId !== userId) return;
    void getOrbitClient().blog.deactivate();
    set({ selectedBlogUserId: null, pendingBlogUrl: null });
  },

  refreshMemberBlogs: async () => {
    const id = ++blogsRequestId;
    const { storage } = getOrbitClient();
    const { auth, memberBlogs } = get();
    const useCache = auth.authenticated && Boolean(auth.profile?.subject);
    set({ blogsLoading: true, blogsError: null });
    if (useCache && memberBlogs.length === 0) {
      const cached = await storage.getCache<MemberBlogItem[]>(MEMBER_BLOG_CACHE).catch(() => null);
      if (id !== blogsRequestId) return;
      if (cached) set({ memberBlogs: cached.value });
    }
    try {
      const [items, myBlogResult] = await Promise.all([
        blogApi.listBlogs(),
        blogApi.getMyBlog().catch(() => undefined),
      ]);
      if (id !== blogsRequestId) return;
      set({
        memberBlogs: items,
        ...(myBlogResult !== undefined ? { myBlog: myBlogResult } : {}),
        blogsLoading: false,
      });
      if (useCache) void storage.setCache(MEMBER_BLOG_CACHE, items).catch(() => undefined);
    } catch (error) {
      if (id !== blogsRequestId) return;
      const denied = error instanceof BlogApiError && (error.status === 401 || error.status === 403);
      if (denied) {
        const authorId = get().selectedBlogUserId;
        if (authorId) get().clearBlogTarget(authorId);
        if (useCache) void storage.setCache(MEMBER_BLOG_CACHE, []).catch(() => undefined);
      }
      set({
        blogsLoading: false,
        blogsError: error instanceof Error ? error.message : '无法读取成员博客',
        ...(denied ? { memberBlogs: [] } : {}),
      });
    }
  },

  refreshBlogPublicConfig: async (force = false) => {
    const cached = get().blogPublicConfig;
    if (cached && !force) return cached;
    if (blogConfigInFlight) return blogConfigInFlight;
    blogConfigInFlight = blogApi
      .getPublicConfig()
      .then((config) => {
        set({ blogPublicConfig: config });
        return config;
      })
      .catch(() => null)
      .finally(() => {
        blogConfigInFlight = null;
      });
    return blogConfigInFlight;
  },

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
        const [items, presence] = await Promise.all([
          orbitServerApi.listMiniApps(),
          orbitServerApi.listMiniAppPresence().catch(() => get().hubPresence),
        ]);
        set({ hubCatalog: items, hubPresence: presence, hubLoading: false });
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

  refreshHubPresence: async () => {
    if (!get().auth.authenticated) return;
    try {
      const items = await orbitServerApi.listMiniAppPresence();
      set({ hubPresence: items });
    } catch {
      // 忽略偶发刷新失败
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

  refreshStudioMembers: async (force = false) => {
    if (!get().auth.authenticated) return;
    if (get().studioMembersLoading) return;
    if (!force && get().studioMembers.length > 0) return;

    set({ studioMembersLoading: true, studioMembersError: null });
    try {
      const res = await getOrbitClient().auth.listStudioMembers();
      if (res.ok) {
        set({ studioMembers: res.items, studioMembersLoading: false, studioMembersError: null });
        return;
      }
      set({
        studioMembersLoading: false,
        studioMembersError: res.message || '加载工作室成员名片失败。',
      });
    } catch (err) {
      set({
        studioMembersLoading: false,
        studioMembersError: err instanceof Error ? err.message : '加载工作室成员名片失败。',
      });
    }
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
        punchApi.fetchTeamActiveSnapshot(),
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
        teamActive: teamActive.status === 'fulfilled' ? teamActive.value.items : get().teamActive,
        feverActive: teamActive.status === 'fulfilled' ? teamActive.value.isFever : get().feverActive,
        feverThreshold:
          teamActive.status === 'fulfilled' ? teamActive.value.feverThreshold : get().feverThreshold,
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
      consecutiveEnvMisses = 0;
      lastEnvLeaveNotifiedAt = 0;
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
      void useCalendarStore.getState().syncStudioEvents({ silent: true });
    }
  },

  sendAttendanceHeartbeat: async () => {
    const state = get();
    if (!state.auth.authenticated || !state.attendance?.isCheckedIn || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      // 默认优先读取系统缓存 BSS 列表（避免每 3 分钟主动 WlanScan 造成 CPU/语音丢包尖峰）；
      // 仅当缓存结果未命中工作室环境时，再升级触发一次 force=true 主动复核，减少误报
      let res = await punchApi.sendAttendanceKeepAlive(false);
      if (res.environment?.wifiFingerprintEnabled && !res.environment.allowed) {
        try {
          res = await punchApi.sendAttendanceKeepAlive(true);
        } catch {
          // 主动复核失败时保留首次心跳结果
        }
      }
      const latest = get();
      if (!latest.attendance?.isCheckedIn) return;

      const nextAttendance: AttendanceSnapshot = {
        ...latest.attendance,
        currentSessionSeconds: res.elapsedSeconds || latest.attendance.currentSessionSeconds,
      };
      const nextNetwork = res.environment ?? latest.networkStatus;

      set({
        attendance: nextAttendance,
        ...(res.environment ? { networkStatus: res.environment } : {}),
      });
      void getOrbitClient().storage.setCache('punch:attendance', nextAttendance);
      void getOrbitClient().system.updateTrayPunch({
        checkedIn: true,
        elapsedSeconds: nextAttendance.currentSessionSeconds ?? 0,
        todaySeconds: nextAttendance.todayDurationSeconds ?? 0,
        weekSeconds: latest.weeklyStats?.totalDurationSeconds ?? nextAttendance.weekDurationSeconds ?? 0,
        weekTargetSeconds:
          latest.weeklyStats?.targetDurationSeconds ?? nextAttendance.weekTargetSeconds ?? 18 * 3600,
        networkAllowed: nextNetwork ? nextNetwork.allowed : true,
        authenticated: true,
        statusLabel: '专注中',
      });

      if (res.environment?.wifiFingerprintEnabled) {
        if (res.environment.allowed) {
          consecutiveEnvMisses = 0;
        } else {
          consecutiveEnvMisses += 1;
          const now = Date.now();
          // 连续 2 次心跳（约 6 分钟）均未命中工作室环境时提醒签退，避免单次 Wi-Fi 波动误报，且至少间隔 15 分钟提醒一次
          if (consecutiveEnvMisses >= 2 && now - lastEnvLeaveNotifiedAt >= 15 * 60_000) {
            lastEnvLeaveNotifiedAt = now;
            const title = '未检测到工作室环境';
            const body =
              res.environment.scanError ||
              res.environment.reason ||
              '连续多次未检测到工作室周边 Wi-Fi 信号，若已离开工作室请记得及时签退。';
            void getOrbitClient().system.notify(title, body);
            notifyToast({
              tone: 'info',
              title,
              description: body,
            });
          }
        }
      }
    } catch (err) {
      // 若服务端已签退或满 5 小时自动失效（400），立即刷新考勤状态同步托盘与计时器
      if (err instanceof PunchApiError && err.status === 400) {
        consecutiveEnvMisses = 0;
        void get().refreshPunchData();
      }
    } finally {
      heartbeatInFlight = false;
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

  acceptHubRoomInvite: async (notif) => {
    const payload = notif.payload ?? {};
    const appId = typeof payload.appId === 'string' ? payload.appId.trim() : '';
    const appName = (typeof payload.appName === 'string' ? payload.appName.trim() : '') || appId;
    const roomId = typeof payload.roomId === 'string' ? payload.roomId.trim() : '';
    const roomName = typeof payload.roomName === 'string' ? payload.roomName.trim() : undefined;
    const message = typeof payload.message === 'string' ? payload.message.trim() : undefined;
    const modeRaw = payload.mode;
    const mode: MiniAppDisplayMode | undefined =
      modeRaw === 'sidepanel' || modeRaw === 'workspace' || modeRaw === 'standalone'
        ? modeRaw
        : undefined;
    const meta =
      payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
        ? (payload.meta as Record<string, unknown>)
        : undefined;
    const inviterId = typeof payload.inviterId === 'string' ? payload.inviterId.trim() : '';
    const inviterUsername =
      typeof payload.inviterUsername === 'string' ? payload.inviterUsername.trim() : undefined;
    const inviterName =
      (typeof payload.inviterName === 'string' ? payload.inviterName.trim() : '') || '工作室队友';
    const inviterAvatar =
      typeof payload.inviterAvatar === 'string' ? payload.inviterAvatar.trim() : undefined;

    if (!appId || !roomId) {
      notifyToast({
        tone: 'error',
        title: '无法加入房间',
        description: '该组队邀请缺少应用或房间信息。',
      });
      return;
    }

    try {
      // 1. 待处理状态先向服务端确认接受，校验有效期并通知房主
      if (notif.actionStatus === 'pending') {
        await orbitServerApi.handleNotificationAction(notif.id, 'approve');
        set((s) => ({
          orbitNotifications: s.orbitNotifications.map((n) =>
            n.id === notif.id ? { ...n, actionStatus: 'approved', isRead: true } : n,
          ),
        }));
      }

      // 2. 自动解析应用包（内置示例 / 已缓存目录 / 线上最新上架版本，未安装会自动下载安装）
      const state = get();
      const isBuiltin = state.hubBuiltins.some((b) => b.appId === appId);
      let remoteBundle:
        | {
            version: string;
            bundleUrl: string;
            bundleSha256: string;
            bundleSize?: number;
            manifest?: MiniAppCatalogItem['activeVersion'] extends infer V
              ? V extends { manifest: infer M }
                ? M
                : never
              : never;
            iconUrl?: string;
          }
        | undefined;

      if (!isBuiltin) {
        let catalogItem: MiniAppCatalogItem | null =
          state.hubCatalog.find((c) => c.id === appId) ?? null;
        if (!catalogItem?.activeVersion) {
          try {
            catalogItem = await orbitServerApi.getMiniApp(appId);
          } catch {
            // 若线上不可达，允许回退到本地已安装缓存
          }
        }
        const activeVer = catalogItem?.activeVersion;
        if (activeVer) {
          remoteBundle = {
            version: activeVer.version,
            bundleUrl: activeVer.bundleUrl,
            bundleSha256: activeVer.bundleSha256,
            bundleSize: activeVer.bundleSize,
            manifest: activeVer.manifest,
            iconUrl: catalogItem?.iconUrl || activeVer.iconUrl,
          };
        } else if (
          !state.hubInstalled.some((i) => i.appId === appId) &&
          !state.hubRuntime.apps.some((r) => r.appId === appId)
        ) {
          throw new Error(`未找到作品《${appName}》的可用版本，可能尚未正式发布或已下架`);
        }
      }

      const launchRoom: MiniAppLaunchRoomContext = {
        inviteId: notif.id,
        appId,
        roomId,
        roomName: roomName || undefined,
        mode,
        message: message || undefined,
        meta,
        inviter: {
          userId: inviterId || 'studio-member',
          username: inviterUsername || undefined,
          displayName: inviterName,
          avatar: inviterAvatar || undefined,
        },
        acceptedAt: new Date().toISOString(),
      };

      const launched = await getOrbitClient().hub.launch({
        appId,
        mode,
        remoteBundle,
        launchRoom,
      });

      if (launched.mode === 'workspace') {
        get().setActiveTab('hub');
      }
      void get().refreshHubLocal();
      void get().refreshHubPresence();

      notifyToast({
        tone: 'success',
        title: `正在进入《${launched.name || appName}》`,
        description: `已连接 ${inviterName} 的房间：${roomName || roomId}`,
      });
    } catch (err) {
      void get().refreshOrbitCenter();
      notifyToast({
        tone: 'error',
        title: '接受组队邀请失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  },

  denyHubRoomInvite: async (notif) => {
    try {
      await orbitServerApi.handleNotificationAction(notif.id, 'deny');
      set((s) => ({
        orbitNotifications: s.orbitNotifications.map((n) =>
          n.id === notif.id ? { ...n, actionStatus: 'denied', isRead: true } : n,
        ),
      }));
      notifyToast({
        tone: 'info',
        title: '已婉拒组队邀请',
        description: '已将你的回复同步给发起邀请的队友。',
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '婉拒操作失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  },

  applyOrbitWsEvent: (event) => {
    const mySub = get().auth.profile?.subject;
    if (
      useCalendarStore
        .getState()
        .applyStudioWsEvent(event, mySub, () => get().setActiveTab('schedule'))
    ) {
      return;
    }
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
      const isBlogEvent = notif.sourceApp === 'lec-blog';
      if (isBlogEvent && get().auth.authenticated && (get().activeTab === 'blogs' || get().memberBlogs.length > 0)) {
        void get().refreshMemberBlogs();
      }
      const isRoomInvite = notif.eventType === 'hub.room_invite';
      const blogTargetUrl = isBlogEvent ? parseBlogUrl(notif.payload?.postUrl ?? notif.payload?.blogUrl) : null;
      const blogAuthorId = typeof notif.payload?.userId === 'string' ? notif.payload.userId.trim() : '';
      void getOrbitClient().system.notify(notif.title, notif.body);
      notifyToast({
        tone: notif.eventType === 'doc.edit_request' || isRoomInvite ? 'info' : 'success',
        title: notif.title,
        description: notif.body,
        action: isRoomInvite
          ? { label: '接受并进房', onClick: () => void get().acceptHubRoomInvite(notif) }
          : blogTargetUrl && blogAuthorId
            ? { label: '前往阅读', onClick: () => get().openBlogTarget(blogAuthorId, blogTargetUrl.href) }
            : { label: '前往处理', onClick: () => get().setActiveTab('inbox') },
      });
      return;
    }
    if (event.type === 'hub.presence.updated') {
      void get().refreshHubPresence();
      return;
    }
    if (event.type === 'miniapp.realtime') {
      const p = event.payload;
      if (typeof p.appId === 'string' && typeof p.event === 'string') {
        void getOrbitClient().hub.dispatchRealtimeEvent({
          appId: p.appId,
          roomId: typeof p.roomId === 'string' ? p.roomId : null,
          event: p.event,
          payload: p.payload,
          ts: typeof p.ts === 'number' ? p.ts : Date.now(),
        });
      }
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
