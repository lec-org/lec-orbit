/** LecPunch 今日专注主屏：Apple HIG 风格原生考勤计时卡片、网络白名单状态、本周考核与实时在岗伙伴。 */
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Avatar, Button, Card, Empty, Statistic, Switch, Tag } from '@lec-space/liquidglass';
import { Clock3, Flame, RefreshCw, ShieldCheck, Trophy, Users } from '@lec-space/icons';
import { Award, IdCard, Wifi } from 'lucide-react';
import {
  formatClockDuration,
  formatReadableDuration,
  getCurrentIsoWeek,
  type TeamActiveMember,
} from '@shared/punch';
import { MemberProfileDialog, type MemberProfileSeed } from '@/components/MemberProfileDialog';
import { TitleBadgeList } from '@/components/TitleBadge';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchToday.module.css';
import { dutyWeek, type DutySchedule } from '@shared/duty';
import { orbitServerApi } from '@/services/orbitServerApi';
import { dutyRefreshFailure } from '@/services/dutySync';

const GlyphEmber = lazy(() => import('./GlyphEmber'));


/** 跟随 Orbit 外观配置与系统深浅色解析当前生效主题，避免特效背景硬编码浅底。 */
function useResolvedTheme(preference: 'system' | 'light' | 'dark'): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function PunchTodayPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const config = useOrbitStore((s) => s.config);
  const attendance = useOrbitStore((s) => s.attendance);
  const networkStatus = useOrbitStore((s) => s.networkStatus);
  const teamActive = useOrbitStore((s) => s.teamActive);
  const frenzyActive = useOrbitStore((s) => s.feverActive);
  const resolvedTheme = useResolvedTheme(config.theme);
  const weeklyStats = useOrbitStore((s) => s.weeklyStats);
  const points = useOrbitStore((s) => s.points);
  const myTitles = useOrbitStore((s) => s.myTitles);
  const toggleCheckInOut = useOrbitStore((s) => s.toggleCheckInOut);
  const refreshNetworkStatus = useOrbitStore((s) => s.refreshNetworkStatus);
  const openTitleCabinet = useOrbitStore((s) => s.openTitleCabinet);
  const updateConfig = useOrbitStore((s) => s.updateConfig);
  const setLoginModalOpen = useOrbitStore((s) => s.setLoginModalOpen);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [{ schedule, message: dutyMessage }, setDuty] = useState<{ schedule: DutySchedule | null; message: string }>({ schedule: null, message: '' });
  useEffect(() => {
    setDuty({ schedule: null, message: '' });
    if (!auth.authenticated || !auth.isStudioMember) return;
    let active = true;
    const load = () => orbitServerApi.getDutySchedule().then(next => {
      if (active) setDuty({ schedule: next, message: '' });
    }).catch(error => { if (active) setDuty(prev => dutyRefreshFailure(prev.schedule, error)); });
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.authenticated, auth.isStudioMember, auth.profile?.subject]);
  const duty = dutyWeek(nowMs, schedule);
  const [busy, setBusy] = useState(false);
  const [recheckingEnv, setRecheckingEnv] = useState(false);
  const [selectedMember, setSelectedMember] = useState<TeamActiveMember | null>(null);
  const [profileSeed, setProfileSeed] = useState<MemberProfileSeed | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const liveSessionSeconds = useMemo(() => {
    if (!attendance?.isCheckedIn) return 0;
    if (attendance.checkedInAt) {
      const start = Date.parse(attendance.checkedInAt);
      if (!Number.isNaN(start)) {
        return Math.max(0, Math.floor((nowMs - start) / 1000));
      }
    }
    return attendance.currentSessionSeconds ?? 0;
  }, [attendance, nowMs]);

  const todayTotalSeconds = (attendance?.todayDurationSeconds ?? 0) + liveSessionSeconds;
  const weekTotalSeconds =
    (weeklyStats?.totalDurationSeconds ?? attendance?.weekDurationSeconds ?? 0) + liveSessionSeconds;
  const weekTargetSeconds = weeklyStats?.targetDurationSeconds ?? attendance?.weekTargetSeconds ?? 18 * 3600;
  const weekPercent = Math.min(100, Math.round((weekTotalSeconds / Math.max(1, weekTargetSeconds)) * 100));

  // 同步系统托盘实时计时
  useEffect(() => {
    void getOrbitClient().system.updateTrayPunch({
      checkedIn: Boolean(attendance?.isCheckedIn),
      elapsedSeconds: liveSessionSeconds,
      statusLabel: auth.authenticated ? '未在打卡' : '未登录',
    });
  }, [attendance?.isCheckedIn, liveSessionSeconds, auth.authenticated]);

  const handleRecheckEnvironment = async () => {
    if (!auth.authenticated || recheckingEnv) return;
    setRecheckingEnv(true);
    const next = await refreshNetworkStatus(true);
    setRecheckingEnv(false);
    if (!next) return;
    if (next.wifiFingerprintEnabled) {
      notifyToast({
        tone: next.allowed ? 'success' : 'info',
        title: next.allowed ? '已识别工作室环境' : '未识别到工作室环境',
        description: next.allowed
          ? `命中 ${next.matchedCount ?? 0} 个工作室信号点，可正常签到 / 签退。`
          : next.scanError || next.reason || '请确认身处工作室并开启本机 Wi-Fi 后重试。',
      });
    } else {
      notifyToast({
        tone: next.allowed ? 'success' : 'info',
        title: next.allowed ? '当前网络允许签到' : '当前网络禁止签到',
        description: next.clientIp ? `出口 IP：${next.clientIp}` : next.reason,
      });
    }
  };

  const handleTogglePunch = async () => {
    if (!auth.authenticated) {
      setLoginModalOpen(true);
      return;
    }
    setBusy(true);
    const res = await toggleCheckInOut();
    setBusy(false);
    notifyToast({
      tone: res.ok ? 'success' : 'error',
      title: res.ok ? (attendance?.isCheckedIn ? '已结束本次专注' : '签到成功') : '考勤操作失败',
      description: res.message,
      action:
        res.status === 401
          ? { label: '重新登录', onClick: () => setLoginModalOpen(true) }
          : undefined,
    });
  };

  const openMemberDetail = (member: TeamActiveMember, e: ReactMouseEvent<HTMLButtonElement>) => {
    if (selectedMember?.userId === member.userId) {
      setSelectedMember(null);
      setPopoverPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const cardWidth = 272;
    const cardHeight = 166;
    const margin = 14;
    const centerX = rect.left + rect.width / 2;
    const left = Math.max(
      margin,
      Math.min(centerX - cardWidth / 2, window.innerWidth - cardWidth - margin),
    );
    const placeAbove = rect.top > cardHeight + 24;
    const top = placeAbove ? rect.top - 10 : rect.bottom + 10;
    setSelectedMember(member);
    setPopoverPos({ left, top, placement: placeAbove ? 'top' : 'bottom' });
  };

  useEffect(() => {
    if (!selectedMember) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (popoverRef.current?.contains(target)) return;
      if (target?.closest('[data-presence-chip="true"]')) return;
      setSelectedMember(null);
      setPopoverPos(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedMember(null);
        setPopoverPos(null);
      }
    };
    const onDismiss = () => {
      setSelectedMember(null);
      setPopoverPos(null);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onDismiss);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onDismiss);
    };
  }, [selectedMember]);

  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('zh-CN', {
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      }).format(new Date(nowMs)),
    [Math.floor(nowMs / 60_000)],
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.headingRow}>
            <h1 className={styles.heading}>今日专注</h1>
            {myTitles && myTitles.displayTitles.length > 0 && (
              <TitleBadgeList
                titles={myTitles.displayTitles}
                size="sm"
                maxVisible={3}
                onBadgeClick={() => openTitleCabinet()}
              />
            )}
            {auth.authenticated && (
              <Button
                variant="glass"
                size="small"
                icon={<Award size={13} />}
                onClick={() => openTitleCabinet()}
              >
                称号图鉴
                {myTitles
                  ? ` ${myTitles.catalog.filter((c) => c.unlocked).length}/${myTitles.catalog.length}`
                  : ''}
              </Button>
            )}
          </div>
          <p className={styles.subheading}>
            {todayLabel} · {getCurrentIsoWeek()}
          </p>
        </div>
        <div className={styles.headerActions}>
          {networkStatus ? (
            <button
              type="button"
              className={styles.statusTrigger}
              onClick={() => void handleRecheckEnvironment()}
              disabled={recheckingEnv}
              title={networkStatus.scanError || networkStatus.reason || '点击重新检测当前工作室环境'}
            >
              <Tag
                tone={networkStatus.allowed ? 'success' : 'warning'}
                icon={
                  recheckingEnv ? (
                    <RefreshCw size={14} className={styles.spinIcon} />
                  ) : networkStatus.wifiFingerprintEnabled ? (
                    <Wifi size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )
                }
              >
                {recheckingEnv
                  ? '正在检测工作室环境…'
                  : networkStatus.wifiFingerprintEnabled
                    ? networkStatus.allowed
                      ? `已识别工作室环境（命中 ${networkStatus.matchedCount ?? 0} 个信号点）`
                      : '未在工作室环境内（点击重新扫描）'
                    : networkStatus.allowed
                      ? `允许签到网络${networkStatus.clientIp ? ` (${networkStatus.clientIp})` : ''}`
                      : '当前网络禁止签到（仅可浏览）'}
              </Tag>
            </button>
          ) : (
            <Tag tone="neutral">等待同步网络策略</Tag>
          )}
        </div>
      </header>

      <section className={styles.heroGrid}>
        <Card className={styles.heroCard} padding="large">
          {frenzyActive && config.frenzyFlamesEnabled && (
            <Suspense fallback={null}>
              <GlyphEmber
                className={styles.emberBackground}
                backgroundColor={resolvedTheme === 'dark' ? '#161b26' : '#faf5ff'}
                mode={resolvedTheme === 'dark' ? 'glow' : 'ink'}
                interactive={false}
                glyphSize={8.8}
                height={(0.7 * 2) / 3}
                quality={0.8}
              />
            </Suspense>
          )}
          <div className={styles.heroTop}>
            <div className={styles.punchBadges}>
              <Tag
                tone={attendance?.isCheckedIn ? (frenzyActive ? 'warning' : 'success') : 'neutral'}
                icon={<Clock3 size={14} />}
              >
                {attendance?.isCheckedIn ? '专注计时中' : '尚未签到'}
              </Tag>
              {frenzyActive && (
                <Tag tone="warning" icon={<Flame size={14} />}>
                  狂热打卡
                </Tag>
              )}
            </div>
            <span className={styles.todayHint}>今日累计 {formatReadableDuration(todayTotalSeconds)}</span>
          </div>

          <div className={styles.clockDisplay}>
            {attendance?.isCheckedIn ? formatClockDuration(liveSessionSeconds) : '00:00:00'}
          </div>

          <div className={styles.heroFooter}>
            <Button
              variant="filled"
              size="large"
              destructive={Boolean(attendance?.isCheckedIn)}
              loading={busy}
              onClick={handleTogglePunch}
              disabled={
                !auth.authenticated
                  ? false
                  : !attendance?.isCheckedIn &&
                    networkStatus?.allowed === false &&
                    !networkStatus?.wifiFingerprintEnabled
              }
            >
              {!auth.authenticated
                ? '登录 LecSSO 后开始签到'
                : attendance?.isCheckedIn
                  ? '结束专注并签退'
                  : '开始今日签到'}
            </Button>
            {auth.authenticated &&
              networkStatus?.wifiFingerprintEnabled &&
              !networkStatus.allowed && (
                <span className={styles.envHint}>
                  {networkStatus.scanError ||
                    networkStatus.reason ||
                    '请确认在工作室内并开启 Wi-Fi 开关（无需连接热点）'}
                  {networkStatus.scanPermissionDenied && (
                    <>
                      {' '}
                      <Button
                        variant="glass"
                        size="small"
                        onClick={() => void getOrbitClient().system.openLocationSettings()}
                      >
                        打开系统定位设置
                      </Button>
                    </>
                  )}
                </span>
              )}
          </div>
        </Card>

        <div className={styles.sideMetrics}>
          <Card title="本周考核进度" extra={<Tag tone={weekPercent >= 100 ? 'success' : 'info'}>{weekPercent}%</Tag>}>
            <Statistic
              title={`目标 ${formatReadableDuration(weekTargetSeconds)}`}
              value={formatReadableDuration(weekTotalSeconds)}
            />
            <div className={styles.progressTrack} aria-label="本周考核完成比例">
              <div className={styles.progressFill} style={{ width: `${weekPercent}%` }} />
            </div>
          </Card>

          <div className={styles.miniRow}>
            <Card title="团队积分" extra={<Trophy size={16} />}>
              <Statistic title="累计积分" value={points?.totalPoints ?? 0} suffix="分" />
            </Card>
            <Card
              title="专注提醒"
              extra={
                <Switch
                  checked={config.remindersEnabled}
                  onCheckedChange={(checked) => void updateConfig({ remindersEnabled: checked })}
                />
              }
            >
              <p className={styles.cardNote}>
                {config.remindersEnabled ? '已按日程开启轻柔桌面通知' : '当前已暂停本地提醒'}
              </p>
            </Card>
          </div>
        </div>
      </section>

      <Card
        title={
          <span className={styles.sectionTitle}>
            <Users size={16} /> 工作室实时在岗（{teamActive.length} 人）
          </span>
        }
        description="点击成员头像查看当前专注开始时间"
      >
        {teamActive.length === 0 ? (
          <Empty
            title={auth.authenticated ? '此刻暂无伙伴在线打卡' : '登录后查看工作室在岗伙伴'}
            description={auth.authenticated ? '成为今天第一位点亮工作室的人吧' : '点击右上角或主按钮使用 LecSSO 登录'}
          />
        ) : (
          <div className={styles.presenceList}>
            {teamActive.map((member) => (
              <button
                key={member.userId}
                type="button"
                data-presence-chip="true"
                className={`${styles.presenceChip} ${
                  selectedMember?.userId === member.userId ? styles.presenceChipActive : ''
                }`}
                onClick={(e) => openMemberDetail(member, e)}
              >
                <Avatar src={member.avatar} name={member.realName || member.displayName} size="regular" />
                <div className={styles.presenceMeta}>
                  <div className={styles.presenceNameRow}>
                    <span className={styles.presenceName}>{member.displayName}</span>
                    <TitleBadgeList titles={member.titles} size="xs" maxVisible={1} />
                  </div>
                  <span className={styles.presenceSub}>
                    <Flame size={12} /> {member.teamName || '工作室成员'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className={styles.dutyRow}>
          <strong className={styles.sectionTitle}><IdCard size={16} /> 本周值日生</strong>
          <span>{!auth.authenticated ? '登录后查看值日安排' : !auth.isStudioMember ? '仅工作室成员可查看'
            : !schedule ? (dutyMessage || '正在读取排班…') : duty.index < 0 ? '本周暂未安排值日生'
            : `第 ${duty.index + 1} 组 · ${schedule.groups[duty.index].join('、')}`}</span>
          {auth.authenticated && auth.isStudioMember && schedule && dutyMessage && <small role="status">{dutyMessage}</small>}
          <span className={styles.dutyDates}>{duty.dates}</span>
        </div>
      </Card>

      {selectedMember && popoverPos && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="成员在岗详情"
          className={`${styles.memberPopover} ${
            popoverPos.placement === 'top' ? styles.memberPopoverTop : styles.memberPopoverBottom
          }`}
          style={{ left: popoverPos.left, top: popoverPos.top }}
        >
          <div className={styles.popoverHeader}>
            <Avatar src={selectedMember.avatar} name={selectedMember.realName || selectedMember.displayName} size="regular" />
            <div className={styles.popoverTitleWrap}>
              <div className={styles.popoverNameRow}>
                <h3 className={styles.popoverTitle}>{selectedMember.displayName}</h3>
                <span className={styles.popoverLiveBadge}>专注中</span>
              </div>
              <p className={styles.popoverSub}>{selectedMember.teamName || 'LEC 工作室正式成员'}</p>
            </div>
          </div>

          {selectedMember.titles && selectedMember.titles.length > 0 && (
            <div className={styles.popoverTitles}>
              <TitleBadgeList titles={selectedMember.titles} size="xs" maxVisible={4} />
            </div>
          )}

          <div className={styles.popoverRows}>
            <div className={styles.popoverInfoRow}>
              <span>签到时间</span>
              <strong>{new Date(selectedMember.checkedInAt).toLocaleTimeString('zh-CN')}</strong>
            </div>
            {typeof selectedMember.durationSeconds === 'number' && (
              <div className={styles.popoverInfoRow}>
                <span>本次已专注</span>
                <strong>{formatReadableDuration(selectedMember.durationSeconds)}</strong>
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="glass"
              size="small"
              icon={<IdCard size={13} />}
              onClick={() => {
                const target = selectedMember;
                setSelectedMember(null);
                setPopoverPos(null);
                setProfileSeed({
                  id: target.userId,
                  username: target.username,
                  displayName: target.displayName,
                  realName: target.realName,
                  nickname: target.nickname,
                  avatar: target.avatar,
                  teamName: target.teamName,
                  titles: target.titles,
                  active: target,
                });
              }}
            >
              查看个人名片
            </Button>
          </div>
        </div>
      )}

      <MemberProfileDialog seed={profileSeed} onClose={() => setProfileSeed(null)} />
    </div>
  );
}
