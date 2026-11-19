/** Orbit 桌面主壳：左上角头像信息卡、精简侧栏导航、卡牌工坊、内嵌文档与悬浮球/授权子窗路由。 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Button,
  ConfigProvider,
  Dialog,
  Message,
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
  ExternalLink,
  LogOut,
  Settings,
  Users,
} from '@lec-space/icons';
import { Compass, Sparkles, X } from 'lucide-react';
import { formatReadableDuration } from '@shared/punch';
import { getOrbitClient } from '@/services/orbitClient';
import { connectOrbitWebSocket } from '@/services/orbitServerApi';
import { notifyToast, registerOrbitToast } from '@/services/orbitToast';
import { useOrbitStore, type OrbitNavTab } from '@/stores/useOrbitStore';
import { ApprovePage } from '@/pages/approve';
import { DocWorkspacePage } from '@/pages/doc-workspace';
import { FloatingBallPage } from '@/pages/floating-ball';
import { InboxPage } from '@/pages/inbox';
import { LoginModal } from '@/pages/login';
import { ProductNavPage } from '@/pages/product-nav';
import { PunchCardsPage } from '@/pages/punch-cards';
import { PunchGrowthPage } from '@/pages/punch-growth';
import { PunchStudioPage } from '@/pages/punch-studio';
import { PunchTodayPage } from '@/pages/punch-today';
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

  const bootstrap = useOrbitStore((s) => s.bootstrap);
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const setAuthState = useOrbitStore((s) => s.setAuthState);
  const setDocState = useOrbitStore((s) => s.setDocState);
  const setUpdateInfo = useOrbitStore((s) => s.setUpdateInfo);
  const dismissUpdateBanner = useOrbitStore((s) => s.dismissUpdateBanner);
  const setLoginModalOpen = useOrbitStore((s) => s.setLoginModalOpen);
  const pushOverlay = useOrbitStore((s) => s.pushOverlay);
  const popOverlay = useOrbitStore((s) => s.popOverlay);
  const toggleCheckInOut = useOrbitStore((s) => s.toggleCheckInOut);
  const applyOrbitWsEvent = useOrbitStore((s) => s.applyOrbitWsEvent);
  const syncStaleData = useOrbitStore((s) => s.syncStaleData);

  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const profileAreaRef = useRef<HTMLDivElement | null>(null);
  const notifiedVersionRef = useRef<string | null>(null);

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    if (isFloatingBall) return;
    void bootstrap();
    const orbit = getOrbitClient();
    const offAuth = orbit.auth.onStateChanged(setAuthState);
    const offDoc = orbit.doc.onStateChanged(setDocState);
    const offUpdate = orbit.system.onUpdateStateChanged((info) => {
      setUpdateInfo(info);
      if (
        info.available &&
        info.latestVersion &&
        info.stage === 'available' &&
        notifiedVersionRef.current !== info.latestVersion
      ) {
        notifiedVersionRef.current = info.latestVersion;
        notifyToast({
          tone: 'info',
          title: `发现 Orbit 新版本 v${info.latestVersion}`,
          description: '包含最新功能与内置 LecDoc 更新，点击查看详情并应用内下载。',
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
      offUpdate();
      offQuickPunch();
    };
  }, [
    isFloatingBall,
    bootstrap,
    setAuthState,
    setDocState,
    setUpdateInfo,
    setLoginModalOpen,
    toggleCheckInOut,
  ]);

  useEffect(() => {
    if (!updateDialogOpen) return;
    pushOverlay();
    return () => popOverlay();
  }, [updateDialogOpen, pushOverlay, popOverlay]);

  // 个人信息卡弹层打开时自动避让内嵌 LecDoc WebContentsView，点击外部或按 Esc 自动关闭
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
    if (isFloatingBall || !auth.authenticated) return;
    return connectOrbitWebSocket(applyOrbitWsEvent);
  }, [isFloatingBall, auth.authenticated, applyOrbitWsEvent]);

  // 应用主动静默同步：切回窗口、网络恢复及前台定时自动拉取，无需用户手动点刷新
  useEffect(() => {
    if (isFloatingBall || !auth.authenticated) return;
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
      { id: 'punch-growth', label: '成长记录', icon: <CalendarDays size={17} /> },
      { id: 'punch-cards', label: '卡牌工坊', icon: <Sparkles size={17} /> },
      { id: 'punch-studio', label: '工作室', icon: <Users size={17} /> },
      { id: 'doc', label: '团队文档', icon: <BookOpen size={17} /> },
      { id: 'inbox', label: '通知中心', icon: <Bell size={17} />, badgeCount: unreadCount },
      { id: 'products', label: '应用导航', icon: <Compass size={17} /> },
    ],
    [unreadCount],
  );

  const isMac = getOrbitClient().platform === 'darwin';

  if (isFloatingBall) {
    return (
      <ConfigProvider locale={zhCN} theme={resolvedTheme}>
        <FloatingBallPage />
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
        <div className={styles.shell}>
          <aside className={`${styles.sidebar} ${isMac ? styles.sidebarMac : ''}`}>
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
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.navItem} ${activeTab === item.id ? styles.navItemActive : ''}`}
                  onClick={() => setActiveTab(item.id)}
                >
                  <span className={styles.navIcon}>{item.icon}</span>
                  <span className={styles.navLabel}>{item.label}</span>
                  {item.badgeCount ? <Badge count={item.badgeCount} /> : null}
                </button>
              ))}
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
                          ? `正在下载 v${updateInfo.latestVersion}`
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
                      <Button
                        variant="filled"
                        size="small"
                        className={styles.updatePrimaryBtn}
                        onClick={() => void getOrbitClient().system.installUpdate()}
                      >
                        {updateInfo.canAutoInstall ? '重启更新' : '打开安装包'}
                      </Button>
                    ) : updateInfo.stage === 'downloading' ? (
                      <span className={styles.updatePctText}>
                        已下载 {updateInfo.progressPercent ?? 0}%
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
                          详情
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
          </aside>

          <main className={styles.content}>
            {!ready ? (
              <div className={styles.loadingState}>正在初始化工作台…</div>
            ) : (
              <>
                {activeTab === 'punch-today' && <PunchTodayPage />}
                {activeTab === 'punch-growth' && <PunchGrowthPage />}
                {activeTab === 'punch-cards' && <PunchCardsPage />}
                {activeTab === 'punch-studio' && <PunchStudioPage />}
                {activeTab === 'doc' && <DocWorkspacePage />}
                {activeTab === 'inbox' && <InboxPage />}
                {activeTab === 'products' && <ProductNavPage />}
                {activeTab === 'settings' && <SettingsPage />}
              </>
            )}
          </main>

          <Dialog
            open={updateDialogOpen}
            onOpenChange={setUpdateDialogOpen}
            size="regular"
            title={
              updateInfo?.latestVersion
                ? `发现 Orbit 新版本 v${updateInfo.latestVersion}`
                : 'Orbit 版本更新'
            }
            description={`当前版本 v${updateInfo?.currentVersion ?? '0.1.0'}${
              updateInfo?.publishedAt
                ? ` · 发布于 ${new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN')}`
                : ''
            }`}
          >
            <div className={styles.updateDialogBody}>
              <div className={styles.updateNotesBox}>
                {updateInfo?.releaseNotes
                  ? updateInfo.releaseNotes
                  : '本次更新包含功能优化与最新内置 LecDoc 前端版本。'}
              </div>

              {updateInfo?.stage === 'downloading' && (
                <div className={styles.updateDialogProgress}>
                  <div className={styles.updateProgressTrack}>
                    <div
                      className={styles.updateProgressFill}
                      style={{ width: `${updateInfo.progressPercent ?? 0}%` }}
                    />
                  </div>
                  <span className={styles.updatePctText}>
                    应用内下载中 {updateInfo.progressPercent ?? 0}%
                    {updateInfo.assetName ? `（${updateInfo.assetName}）` : ''}
                  </span>
                </div>
              )}

              {updateInfo?.stage === 'error' && updateInfo.errorMessage && (
                <Message tone="error">{updateInfo.errorMessage}</Message>
              )}

              <div className={styles.updateDialogFooter}>
                {updateInfo?.releaseUrl && (
                  <Button
                    variant="glass"
                    size="small"
                    icon={<ExternalLink size={14} />}
                    onClick={() => void getOrbitClient().system.openExternal(updateInfo.releaseUrl!)}
                  >
                    GitHub 发布页
                  </Button>
                )}
                <div className={styles.updateDialogFooterRight}>
                  <Button variant="glass" size="small" onClick={() => setUpdateDialogOpen(false)}>
                    稍后
                  </Button>
                  {updateInfo?.stage === 'downloaded' ? (
                    <Button
                      variant="filled"
                      size="small"
                      onClick={() => void getOrbitClient().system.installUpdate()}
                    >
                      {updateInfo.canAutoInstall ? '重启并安装' : '打开安装包'}
                    </Button>
                  ) : (
                    <Button
                      variant="filled"
                      size="small"
                      icon={<Download size={14} />}
                      loading={updateInfo?.stage === 'downloading'}
                      onClick={() => void getOrbitClient().system.downloadUpdate()}
                    >
                      {updateInfo?.stage === 'downloading'
                        ? `下载中 ${updateInfo.progressPercent ?? 0}%`
                        : '应用内下载更新'}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Dialog>

          <LoginModal open={loginModalOpen} onOpenChange={setLoginModalOpen} />
        </div>
      </ToastProvider>
    </ConfigProvider>
  );
}
