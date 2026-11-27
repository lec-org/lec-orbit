/** Orbit 桌面主壳：左上角头像信息卡、精简侧栏导航、卡牌工坊、内嵌文档与悬浮球/授权子窗路由。 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Button,
  ConfigProvider,
  Tag,
  ToastProvider,
  useToast,
  zhCN,
} from '@lec-space/liquidglass';
import {
  Bell,
  BookOpen,
  CalendarDays,
  Clock3,
  Download,
  LogOut,
  Settings,
  Users,
} from '@lec-space/icons';
import { Compass, Gamepad2, GraduationCap, Sparkles, X } from 'lucide-react';
import { formatReadableDuration, getCurrentIsoWeek } from '@shared/punch';
import { evaluateFocusReminder } from '@shared/reminders';
import { evaluateCalendarReminders } from '@shared/calendar';
import { evaluateClassReminder } from '@shared/schedule';
import { compareOrbitSemver } from '@shared/updateChangelog';
import { UpdateChangelogDialog } from '@/components/UpdateChangelogDialog';
import { getOrbitClient } from '@/services/orbitClient';
import { connectOrbitWebSocket } from '@/services/orbitServerApi';
import { notifyToast, registerOrbitToast } from '@/services/orbitToast';
import { useCalendarStore } from '@/stores/useCalendarStore';
import { useOrbitStore, type OrbitNavTab } from '@/stores/useOrbitStore';
import { useScheduleStore } from '@/stores/useScheduleStore';
import { ApprovePage } from '@/pages/approve';
import { BlogHubPage } from '@/pages/blog-hub';
import { DocWorkspacePage } from '@/pages/doc-workspace';
import { FloatingBallPage } from '@/pages/floating-ball';
import { HubPage } from '@/pages/hub';
import { MiniAppSidepanelHost } from '@/pages/hub/MiniAppSidepanelHost';
import { MiniAppStandaloneShell } from '@/pages/hub/MiniAppStandaloneShell';
import { InboxPage } from '@/pages/inbox';
import { LoginModal } from '@/pages/login';
import { ProductNavPage } from '@/pages/product-nav';
import { PunchCardsPage } from '@/pages/punch-cards';
import { PunchGrowthPage } from '@/pages/punch-growth';
import { PunchStudioPage } from '@/pages/punch-studio';
import { PunchTodayPage } from '@/pages/punch-today';
import { SchedulePage } from '@/pages/schedule';
import { SettingsPage } from '@/pages/settings';
import styles from './App.module.css';

interface NavItem {
  id: OrbitNavTab;
  label: string;
  icon: ReactNode;
  badgeCount?: number;
}

function ToastBridge(): null {
  const api = useToast();
  useEffect(() => {
    registerOrbitToast(api);
    return () => registerOrbitToast(null);
  }, [api]);
  return null;
}

export function App(): JSX.Element {
  const isFloatingBall = window.location.hash === '#floating-ball';
  const approveMatch = window.location.hash.match(/^#approve\/([^/?#]+)/);
  const approveChallengeId = approveMatch ? decodeURIComponent(approveMatch[1]!) : null;
  const miniAppWinMatch = window.location.hash.match(/^#miniapp-window\/([^/?#]+)/);
  const standaloneMiniAppId = miniAppWinMatch ? decodeURIComponent(miniAppWinMatch[1]!) : null;
  const isAuxiliaryWindow = isFloatingBall || Boolean(approveChallengeId) || Boolean(standaloneMiniAppId);

  const ready = useOrbitStore((s) => s.ready);
  const activeTab = useOrbitStore((s) => s.activeTab);
  const config = useOrbitStore((s) => s.config);
  const auth = useOrbitStore((s) => s.auth);
  const attendance = useOrbitStore((s) => s.attendance);
  const weeklyStats = useOrbitStore((s) => s.weeklyStats);
  const notifications = useOrbitStore((s) => s.notifications);
  const orbitNotifications = useOrbitStore((s) => s.orbitNotifications);
  const orbitAnnouncements = useOrbitStore((s) => s.orbitAnnouncements);
  const loginModalOpen = useOrbitStore((s) => s.loginModalOpen);
  const updateInfo = useOrbitStore((s) => s.updateInfo);
  const updateBannerDismissed = useOrbitStore((s) => s.updateBannerDismissed);
  const hubRuntime = useOrbitStore((s) => s.hubRuntime);

  const bootstrap = useOrbitStore((s) => s.bootstrap);
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const setAuthState = useOrbitStore((s) => s.setAuthState);
  const setDocState = useOrbitStore((s) => s.setDocState);
  const setHubRuntime = useOrbitStore((s) => s.setHubRuntime);
  const setBlogState = useOrbitStore((s) => s.setBlogState);
  const setUpdateInfo = useOrbitStore((s) => s.setUpdateInfo);
  const dismissUpdateBanner = useOrbitStore((s) => s.dismissUpdateBanner);
  const setLoginModalOpen = useOrbitStore((s) => s.setLoginModalOpen);
  const pushOverlay = useOrbitStore((s) => s.pushOverlay);
  const popOverlay = useOrbitStore((s) => s.popOverlay);
  const toggleCheckInOut = useOrbitStore((s) => s.toggleCheckInOut);
  const applyOrbitWsEvent = useOrbitStore((s) => s.applyOrbitWsEvent);
  const syncStaleData = useOrbitStore((s) => s.syncStaleData);
  const sendAttendanceHeartbeat = useOrbitStore((s) => s.sendAttendanceHeartbeat);
  const isCheckedIn = useOrbitStore((s) => Boolean(s.attendance?.isCheckedIn));
  const updateConfig = useOrbitStore((s) => s.updateConfig);

  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [whatsNewState, setWhatsNewState] = useState<{
    open: boolean;
    version: string;
    previousVersion?: string;
  } | null>(null);
  const profileAreaRef = useRef<HTMLDivElement | null>(null);
  const notifiedVersionRef = useRef<string | null>(null);
  const whatsNewCheckedRef = useRef(false);

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    if (isAuxiliaryWindow) return;
    void bootstrap();
    const orbit = getOrbitClient();
    const offAuth = orbit.auth.onStateChanged(setAuthState);
    const offDoc = orbit.doc.onStateChanged(setDocState);
    const offHubRuntime = orbit.hub.onRuntimeChanged((snapshot) => {
      const prevWorkspace = useOrbitStore
        .getState()
        .hubRuntime.apps.find((a) => a.mode === 'workspace');
      const nextWorkspace = snapshot.apps.find((a) => a.mode === 'workspace');
      setHubRuntime(snapshot);
      // 独立窗或右侧栏切为主区展开时，自动切到「工坊」标签呈现主区容器
      if (!prevWorkspace && nextWorkspace && useOrbitStore.getState().activeTab !== 'hub') {
        setActiveTab('hub');
      }
    });
    const offHubToast = orbit.hub.onToastRequested((payload) => {
      notifyToast({
        tone: payload.tone ?? 'info',
        title: payload.appName,
        description: payload.message,
      });
    });
    const offBlog = orbit.blog.onStateChanged(setBlogState);
    const offScheduleImport = orbit.schedule.onImportStateChanged((importState) => {
      useScheduleStore.getState().setImportState(importState);
    });
    const offUpdate = orbit.system.onUpdateStateChanged((info) => {
      setUpdateInfo(info);
      // 后台静默下载就绪时发出一次温和提示（不突兀弹窗，左下角卡片同步常驻「重启以更新」）
      if (
        info.available &&
        info.latestVersion &&
        info.stage === 'downloaded' &&
        notifiedVersionRef.current !== `ready:${info.latestVersion}`
      ) {
        notifiedVersionRef.current = `ready:${info.latestVersion}`;
        notifyToast({
          tone: 'success',
          title: `Orbit v${info.latestVersion} 已就绪`,
          description: '新版本已在后台静默下载完成，可随时在左下角点击重启更新。',
          action: {
            label: info.canAutoInstall ? '重启以更新' : '打开安装包',
            onClick: () => void orbit.system.installUpdate(),
          },
        });
        return;
      }
      // 仅当当前平台不支持后台自动静默下载（如只读 DMG / Linux）时，在发现新版时温和提示一次
      if (
        info.available &&
        info.latestVersion &&
        info.stage === 'available' &&
        !info.canAutoInstall &&
        notifiedVersionRef.current !== `avail:${info.latestVersion}`
      ) {
        notifiedVersionRef.current = `avail:${info.latestVersion}`;
        const changeCount = info.changelog?.items.length ?? 0;
        const contribCount = info.changelog?.contributors.length ?? 0;
        const summaryHint =
          changeCount > 0
            ? `包含 ${changeCount} 项改动${contribCount > 0 ? `（${contribCount} 位成员参与）` : ''}，可在左下角查看详情并下载。`
            : '包含最新功能与内置 LecDoc 更新，可在左下角查看详情并下载。';
        notifyToast({
          tone: 'info',
          title: `发现 Orbit 新版本 v${info.latestVersion}`,
          description: summaryHint,
          action: {
            label: '查看更新',
            onClick: () => setUpdateDialogOpen(true),
          },
        });
      }
    });
    const offQuickPunch = orbit.system.onQuickPunchRequested(() => {
      void toggleCheckInOut().then((res) => {
        notifyToast({
          tone: res.ok ? 'success' : 'error',
          title: res.ok ? '考勤操作完成' : '考勤操作失败',
          description: res.message,
          action:
            res.status === 401
              ? { label: '重新登录', onClick: () => setLoginModalOpen(true) }
              : undefined,
        });
      });
    });
    return () => {
      offAuth();
      offDoc();
      offHubRuntime();
      offHubToast();
      offBlog();
      offScheduleImport();
      offUpdate();
      offQuickPunch();
    };
  }, [
    isAuxiliaryWindow,
    bootstrap,
    setAuthState,
    setDocState,
    setHubRuntime,
    setActiveTab,
    setBlogState,
    setUpdateInfo,
    setLoginModalOpen,
    toggleCheckInOut,
  ]);

  useEffect(() => {
    if (!updateDialogOpen && !whatsNewState?.open) return;
    pushOverlay();
    return () => popOverlay();
  }, [updateDialogOpen, whatsNewState?.open, pushOverlay, popOverlay]);

  // 升级后首次启动自动弹出「本次更新了什么 / 都是谁修的」弹窗，关闭后记录 lastSeenAppVersion
  useEffect(() => {
    if (isAuxiliaryWindow || !ready || whatsNewCheckedRef.current) return;
    const currentVersion = updateInfo?.currentVersion?.trim();
    if (!currentVersion) return;
    whatsNewCheckedRef.current = true;

    const lastSeen = config.lastSeenAppVersion?.trim();
    if (!lastSeen) {
      // 首次引入版本追踪基线：静默记录当前版本，避免老用户未升级却误弹
      void updateConfig({ lastSeenAppVersion: currentVersion });
      return;
    }
    if (compareOrbitSemver(currentVersion, lastSeen) > 0) {
      setWhatsNewState({
        open: true,
        version: currentVersion,
        previousVersion: lastSeen,
      });
    }
  }, [isAuxiliaryWindow, ready, updateInfo?.currentVersion, config.lastSeenAppVersion, updateConfig]);

  // 个人信息卡弹层打开时自动避让内嵌视图，点击外部或按 Esc 自动关闭
  useEffect(() => {
    if (!profileMenuOpen) return;
    pushOverlay();
    const onPointerDown = (e: MouseEvent) => {
      if (profileAreaRef.current && !profileAreaRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      popOverlay();
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [profileMenuOpen, pushOverlay, popOverlay]);

  useEffect(() => {
    if (isAuxiliaryWindow || !auth.authenticated) return;
    return connectOrbitWebSocket(applyOrbitWsEvent);
  }, [isAuxiliaryWindow, auth.authenticated, applyOrbitWsEvent]);

  // 应用主动静默同步：切回窗口、网络恢复及前台定时自动拉取，无需用户手动点刷新
  useEffect(() => {
    if (isAuxiliaryWindow || !auth.authenticated) return;
    const onWake = () => {
      if (document.visibilityState === 'visible') {
        syncStaleData(15_000);
      }
    };
    const onOnline = () => syncStaleData(3_000);
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncStaleData(55_000);
      }
    }, 60_000);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, [isFloatingBall, auth.authenticated, syncStaleData]);

  // 打卡中后台心跳：每 3 分钟自动上报 /attendance/keepalive（含周边 Wi-Fi 指纹），
  // 即使窗口最小化到托盘也持续校对在线状态、防 5 小时超时不同步并检测是否离开工作室环境
  useEffect(() => {
    if (isAuxiliaryWindow || !auth.authenticated || !isCheckedIn) return;
    const HEARTBEAT_INTERVAL_MS = 3 * 60_000;
    const timer = window.setInterval(() => {
      void sendAttendanceHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAuxiliaryWindow, auth.authenticated, isCheckedIn, sendAttendanceHeartbeat]);

  // 专注提醒真实定时引擎：连续专注 2h 休息、4h15m / 4h45m 防超 5 小时上限签退、周末考核冲刺提醒
  useEffect(() => {
    if (isAuxiliaryWindow || !auth.authenticated || !config.remindersEnabled) return;
    const STORAGE_KEY = 'orbit:sent-reminders:v1';
    const readSentKeys = (): Set<string> => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
      } catch {
        return new Set();
      }
    };
    const saveSentKey = (key: string) => {
      try {
        const next = [...readSentKeys(), key].slice(-60);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 忽略本地存储异常
      }
    };

    const tick = () => {
      const state = useOrbitStore.getState();
      if (!state.auth.authenticated || !state.config.remindersEnabled) return;
      const att = state.attendance;
      const isCheckedIn = Boolean(att?.isCheckedIn);
      let elapsedSeconds = att?.currentSessionSeconds ?? 0;
      if (isCheckedIn && att?.checkedInAt) {
        const startedMs = Date.parse(att.checkedInAt);
        if (!Number.isNaN(startedMs)) {
          elapsedSeconds = Math.max(elapsedSeconds, Math.floor((Date.now() - startedMs) / 1000));
        }
      }
      const weekTargetSeconds = state.weeklyStats?.targetDurationSeconds ?? att?.weekTargetSeconds ?? 18 * 3600;
      const weekTotalSeconds =
        (state.weeklyStats?.totalDurationSeconds ?? att?.weekDurationSeconds ?? 0) +
        (isCheckedIn ? elapsedSeconds : 0);

      const notice = evaluateFocusReminder({
        now: new Date(),
        authenticated: state.auth.authenticated,
        remindersEnabled: state.config.remindersEnabled,
        isCheckedIn,
        sessionKey: att?.activeSessionId || att?.checkedInAt || 'active',
        elapsedSeconds,
        weekTotalSeconds,
        weekTargetSeconds,
        weekKey: state.weeklyStats?.week || getCurrentIsoWeek(),
        sentKeys: readSentKeys(),
      });
      if (!notice) return;
      saveSentKey(notice.key);
      void getOrbitClient().system.notify(notice.title, notice.body);
      notifyToast({
        tone: notice.tone,
        title: notice.title,
        description: notice.body,
        action: { label: '查看今日专注', onClick: () => setActiveTab('punch-today') },
      });
    };

    const initialTimer = window.setTimeout(tick, 10_000);
    const interval = window.setInterval(tick, 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [isAuxiliaryWindow, auth.authenticated, config.remindersEnabled, setActiveTab]);

  // 课前提醒心跳：独立于打卡状态运行，只要当前激活课表开启了上课提醒即按分钟评估
  useEffect(() => {
    if (isAuxiliaryWindow) return;
    const CLASS_REMINDER_KEY = 'orbit:sent-class-reminders:v1';
    const readSent = (): Set<string> => {
      try {
        const raw = window.localStorage.getItem(CLASS_REMINDER_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
      } catch {
        return new Set();
      }
    };
    const saveSent = (key: string) => {
      try {
        const next = [...readSent(), key].slice(-120);
        window.localStorage.setItem(CLASS_REMINDER_KEY, JSON.stringify(next));
      } catch {
        // 忽略本地存储异常
      }
    };

    const tickClassReminder = async () => {
      let detail = useScheduleStore.getState().activeDetail;
      if (!detail && !useScheduleStore.getState().loaded) {
        await useScheduleStore.getState().loadAll();
        detail = useScheduleStore.getState().activeDetail;
      }
      if (!useCalendarStore.getState().loaded) {
        await useCalendarStore.getState().loadSnapshot();
      }
      const nowDate = new Date();
      const sent = readSent();

      // 将已开启订阅日历中的法定放假日（badge === 'off'）自动并入课表休假日以跳过提醒
      const calSnap = useCalendarStore.getState();
      const visibleSubIds = new Set(
        calSnap.subscriptions.filter((s) => s.visible).map((s) => s.id),
      );
      const subOffDates = calSnap.subscriptionItems
        .filter((item) => item.badge === 'off' && visibleSubIds.has(item.subscriptionId))
        .map((item) => item.startDate);
      const effectiveDetail =
        detail && subOffDates.length > 0
          ? {
              ...detail,
              schedule: {
                ...detail.schedule,
                holidays: Array.from(new Set([...detail.schedule.holidays, ...subOffDates])),
              },
            }
          : detail;

      const classNotice = evaluateClassReminder({
        now: nowDate,
        detail: effectiveDetail,
        sentKeys: sent,
      });
      if (classNotice) {
        saveSent(classNotice.key);
        void getOrbitClient().system.notify(classNotice.title, classNotice.body);
        notifyToast({
          tone: 'info',
          title: classNotice.title,
          description: classNotice.body,
          action: { label: '查看日程课表', onClick: () => setActiveTab('schedule') },
        });
      }

      const calState = useCalendarStore.getState();
      const orbitState = useOrbitStore.getState();
      const mySubject = orbitState.auth.profile?.subject ?? null;
      const myEnrollYear =
        mySubject
          ? (orbitState.studioMembers.find((m) => m.id === mySubject)?.enrollYear ?? null)
          : null;
      // 仅对当前用户受邀且未谢绝的工作室日程发出提醒，避免无关或已谢绝活动打扰
      const relevantStudioEvents = calState.studioEvents.filter((ev) => {
        if (mySubject && ev.attendeeResponses?.[mySubject] === 'declined') {
          return false;
        }
        const uIds = ev.attendeeUserIds ?? [];
        const grds = ev.attendeeGrades ?? [];
        if (uIds.length === 0 && grds.length === 0) return true;
        if (mySubject && ev.creatorId === mySubject) return true;
        if (mySubject && uIds.includes(mySubject)) return true;
        if (myEnrollYear != null && grds.includes(myEnrollYear)) return true;
        return false;
      });
      const calNotices = evaluateCalendarReminders({
        now: nowDate,
        events: [...calState.events, ...relevantStudioEvents],
        tasks: calState.tasks,
        sentKeys: readSent(),
      });
      for (const calNotice of calNotices) {
        saveSent(calNotice.key);
        void getOrbitClient().system.notify(calNotice.title, calNotice.body);
        notifyToast({
          tone: 'info',
          title: calNotice.title,
          description: calNotice.body,
          action: { label: '查看日程课表', onClick: () => setActiveTab('schedule') },
        });
      }
    };

    // 切换账号或登录态变化时刷新当前 scope 的课表与日程
    void Promise.all([
      useScheduleStore.getState().loadAll(),
      useCalendarStore.getState().loadSnapshot(),
    ]);

    const first = window.setTimeout(() => void tickClassReminder(), 8_000);
    const timer = window.setInterval(() => void tickClassReminder(), 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [isAuxiliaryWindow, auth.profile?.subject, setActiveTab]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    config.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset.platform = getOrbitClient().platform;
  }, []);

  const unreadCount = useMemo(() => {
    const punchUnread = notifications.filter(
      (n) => n.status !== 'acknowledged' && n.status !== 'read',
    ).length;
    const orbitNotifUnread = orbitNotifications.filter((n) => !n.isRead).length;
    const annUnread = orbitAnnouncements.filter((a) => !a.isReadByMe).length;
    return punchUnread + orbitNotifUnread + annUnread;
  }, [notifications, orbitNotifications, orbitAnnouncements]);

  const navItems: NavItem[] = useMemo(
    () => [
      { id: 'punch-today', label: '今日专注', icon: <Clock3 size={17} /> },
      { id: 'schedule', label: '日程课表', icon: <GraduationCap size={17} /> },
      { id: 'punch-growth', label: '成长记录', icon: <CalendarDays size={17} /> },
      { id: 'punch-cards', label: '卡牌工坊', icon: <Sparkles size={17} /> },
      { id: 'punch-studio', label: '工作室', icon: <Users size={17} /> },
      { id: 'doc', label: '团队文档', icon: <BookOpen size={17} /> },
      { id: 'hub', label: '工坊', icon: <Gamepad2 size={17} />, badgeCount: hubRuntime.apps.length || undefined },
      { id: 'inbox', label: '通知中心', icon: <Bell size={17} />, badgeCount: unreadCount },
      { id: 'products', label: '应用导航', icon: <Compass size={17} /> },
    ],
    [unreadCount, hubRuntime.apps.length],
  );

  const isMac = getOrbitClient().platform === 'darwin';

  if (isFloatingBall) {
    return (
      <ConfigProvider locale={zhCN} theme={resolvedTheme}>
        <FloatingBallPage />
      </ConfigProvider>
    );
  }

  if (standaloneMiniAppId) {
    return (
      <ConfigProvider locale={zhCN} theme={resolvedTheme}>
        <MiniAppStandaloneShell appId={standaloneMiniAppId} />
      </ConfigProvider>
    );
  }

  if (approveChallengeId) {
    return (
      <ConfigProvider locale={zhCN} theme={resolvedTheme}>
        <ToastProvider position="top-right" maxVisible={3}>
          <ToastBridge />
          <ApprovePage initialChallengeId={approveChallengeId} />
        </ToastProvider>
      </ConfigProvider>
    );
  }

  const displayName = auth.profile?.name || auth.profile?.username || '未登录';
  const roleLabel = auth.authenticated
    ? auth.isAdmin
      ? '工作室队长'
      : auth.isStudioMember
        ? '正式成员'
        : 'Applicant'
    : '点击登录 LecSSO';

  const handleSignOut = async () => {
    setProfileMenuOpen(false);
    const next = await getOrbitClient().auth.signOut();
    setAuthState(next);
    notifyToast({ tone: 'info', title: '已退出登录' });
  };

  return (
    <ConfigProvider locale={zhCN} theme={resolvedTheme}>
      <ToastProvider position="top-right" maxVisible={3}>
        <ToastBridge />
        <div className={`${styles.shell} ${!isMac ? styles.shellWin : ''}`}>
          {!isMac && (
            <header className={`${styles.winTitlebar} orbit-drag`} aria-label="窗口标题栏">
              <img src="./icon.png" alt="" className={styles.winTitleIcon} />
              <span className={styles.winTitleText}>Orbit · 伴程</span>
            </header>
          )}
          <aside className={`${styles.sidebar} ${isMac ? styles.sidebarMac : ''} orbit-drag`}>
            <div className={`${styles.topBar} orbit-drag`} ref={profileAreaRef}>
              <button
                type="button"
                className={`${styles.avatarTrigger} orbit-no-drag ${
                  profileMenuOpen ? styles.avatarTriggerOpen : ''
                }`}
                onClick={() => {
                  if (!auth.authenticated) {
                    setLoginModalOpen(true);
                  } else {
                    setProfileMenuOpen((v) => !v);
                  }
                }}
                title={auth.authenticated ? `${displayName} · 点击查看个人信息` : '点击登录 LecSSO'}
              >
                <span className={styles.avatarWrap}>
                  <Avatar src={auth.profile?.avatar} name={displayName} size="small" />
                  <span
                    className={`${styles.presenceDot} ${
                      attendance?.isCheckedIn ? styles.presenceDotActive : ''
                    }`}
                  />
                </span>
                <div className={styles.profileInfo}>
                  <span className={styles.profileName}>
                    {auth.authenticated ? displayName : '登录 LecSSO'}
                  </span>
                  <span className={styles.profileRole}>{roleLabel}</span>
                </div>
              </button>

              {profileMenuOpen && auth.authenticated && (
                <div className={`${styles.profilePopover} orbit-no-drag`} role="dialog" aria-label="个人信息卡">
                  <div className={styles.popoverHeader}>
                    <Avatar src={auth.profile?.avatar} name={displayName} size="regular" />
                    <div className={styles.popoverIdentity}>
                      <div className={styles.popoverNameRow}>
                        <span className={styles.popoverName}>{displayName}</span>
                        <Tag tone={auth.isAdmin ? 'warning' : 'info'}>{roleLabel}</Tag>
                      </div>
                      {auth.profile?.username && (
                        <span className={styles.popoverHandle}>@{auth.profile.username}</span>
                      )}
                    </div>
                  </div>

                  <div className={styles.popoverStats}>
                    <div className={styles.popoverStatItem}>
                      <span className={styles.popoverStatLabel}>当前状态</span>
                      <span className={styles.popoverStatValue}>
                        {attendance?.isCheckedIn ? '专注打卡中' : '未打卡'}
                      </span>
                    </div>
                    <div className={styles.popoverStatItem}>
                      <span className={styles.popoverStatLabel}>本周累计</span>
                      <span className={styles.popoverStatValue}>
                        {formatReadableDuration(
                          weeklyStats?.totalDurationSeconds ?? attendance?.weekDurationSeconds ?? 0,
                        )}
                      </span>
                    </div>
                  </div>

                  <div className={styles.popoverDivider} />

                  <div className={styles.popoverActions}>
                    <Button
                      variant="glass"
                      size="small"
                      icon={<Settings size={14} />}
                      className={styles.popoverActionBtn}
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setActiveTab('settings');
                      }}
                    >
                      设置
                    </Button>
                    <Button
                      variant="glass"
                      size="small"
                      destructive
                      icon={<LogOut size={14} />}
                      className={styles.popoverActionBtn}
                      onClick={() => void handleSignOut()}
                    >
                      退出登录
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <nav className={styles.nav} aria-label="主导航">
              {navItems.map((item) => {
                const isActive =
                  activeTab === item.id || (item.id === 'punch-studio' && activeTab === 'blogs');
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
                    onClick={() => setActiveTab(item.id)}
                  >
                    <span className={styles.navIcon}>{item.icon}</span>
                    <span className={styles.navLabel}>{item.label}</span>
                    {item.badgeCount ? <Badge count={item.badgeCount} /> : null}
                  </button>
                );
              })}
            </nav>

            {updateInfo &&
              (updateInfo.stage === 'downloading' ||
                updateInfo.stage === 'downloaded' ||
                (updateInfo.available && !updateBannerDismissed)) && (
                <div className={styles.updateCard}>
                  <div className={styles.updateCardHead}>
                    <span className={styles.updateCardTitle}>
                      {updateInfo.stage === 'downloaded'
                        ? `v${updateInfo.latestVersion} 已就绪`
                        : updateInfo.stage === 'downloading'
                          ? `后台更新 v${updateInfo.latestVersion}`
                          : `新版本 v${updateInfo.latestVersion}`}
                    </span>
                    {updateInfo.stage === 'available' && (
                      <button
                        type="button"
                        className={styles.updateDismissBtn}
                        aria-label="稍后提醒"
                        onClick={dismissUpdateBanner}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {updateInfo.stage === 'downloading' && (
                    <div className={styles.updateProgressTrack}>
                      <div
                        className={styles.updateProgressFill}
                        style={{ width: `${updateInfo.progressPercent ?? 0}%` }}
                      />
                    </div>
                  )}

                  <div className={styles.updateCardActions}>
                    {updateInfo.stage === 'downloaded' ? (
                      <>
                        <Button
                          variant="filled"
                          size="small"
                          className={styles.updatePrimaryBtn}
                          onClick={() => void getOrbitClient().system.installUpdate()}
                        >
                          {updateInfo.canAutoInstall ? '重启以更新' : '打开安装包'}
                        </Button>
                        <Button
                          variant="glass"
                          size="small"
                          onClick={() => setUpdateDialogOpen(true)}
                        >
                          改了啥
                        </Button>
                      </>
                    ) : updateInfo.stage === 'downloading' ? (
                      <span className={styles.updatePctText}>
                        {(updateInfo.progressPercent ?? 0) >= 95 && updateInfo.canAutoInstall
                          ? '正在准备更新包…'
                          : `已下载 ${updateInfo.progressPercent ?? 0}%`}
                      </span>
                    ) : (
                      <>
                        <Button
                          variant="filled"
                          size="small"
                          icon={<Download size={13} />}
                          className={styles.updatePrimaryBtn}
                          onClick={() => void getOrbitClient().system.downloadUpdate()}
                        >
                          下载
                        </Button>
                        <Button
                          variant="glass"
                          size="small"
                          onClick={() => setUpdateDialogOpen(true)}
                        >
                          改了啥
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
          </aside>

          <div className={styles.mainArea}>
            <main className={styles.content}>
              {isMac && activeTab !== 'doc' && activeTab !== 'blogs' && (
                <div className={`${styles.macTopDragStrip} orbit-drag`} aria-hidden="true" />
              )}
              {!ready ? (
                <div className={styles.loadingState}>正在初始化工作台…</div>
              ) : (
                <>
                  {activeTab === 'punch-today' && <PunchTodayPage />}
                  {activeTab === 'schedule' && <SchedulePage />}
                  {activeTab === 'punch-growth' && <PunchGrowthPage />}
                  {activeTab === 'punch-cards' && <PunchCardsPage />}
                  {activeTab === 'punch-studio' && <PunchStudioPage />}
                  {activeTab === 'doc' && <DocWorkspacePage />}
                  {activeTab === 'blogs' && <BlogHubPage />}
                  {activeTab === 'hub' && <HubPage />}
                  {activeTab === 'inbox' && <InboxPage />}
                  {activeTab === 'products' && <ProductNavPage />}
                  {activeTab === 'settings' && <SettingsPage />}
                </>
              )}
            </main>

            {(() => {
              const sidepanelApp = hubRuntime.apps.find((a) => a.mode === 'sidepanel');
              return sidepanelApp ? <MiniAppSidepanelHost app={sidepanelApp} /> : null;
            })()}
          </div>

          {/* 更新前弹窗：展示新版本改动明细、参与修复的 @成员 与一键下载/重启更新 */}
          <UpdateChangelogDialog
            open={updateDialogOpen}
            onOpenChange={setUpdateDialogOpen}
            mode="update"
            version={updateInfo?.latestVersion ?? updateInfo?.currentVersion ?? '0.2.0'}
            previousVersion={updateInfo?.currentVersion}
            publishedAt={updateInfo?.publishedAt}
            releaseUrl={updateInfo?.releaseUrl}
            rawNotes={updateInfo?.releaseNotes}
            changelog={updateInfo?.changelog}
            updateInfo={updateInfo}
          />

          {/* 更新后首次启动自动弹窗（What's New）：展示本次改了啥、都是谁修的 */}
          {whatsNewState && (
            <UpdateChangelogDialog
              open={whatsNewState.open}
              onOpenChange={(nextOpen) => {
                setWhatsNewState((prev) => (prev ? { ...prev, open: nextOpen } : null));
                if (!nextOpen) {
                  void updateConfig({ lastSeenAppVersion: whatsNewState.version });
                }
              }}
              mode="whats-new"
              version={whatsNewState.version}
              previousVersion={whatsNewState.previousVersion}
            />
          )}

          <LoginModal open={loginModalOpen} onOpenChange={setLoginModalOpen} />
        </div>
      </ToastProvider>
    </ConfigProvider>
  );
}
