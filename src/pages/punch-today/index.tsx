/** LecPunch 今日专注主屏：Apple HIG 风格原生考勤计时卡片、网络白名单状态、本周考核与实时在岗伙伴。 */
import { useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react';
import { Avatar, Button, Card, Empty, Statistic, Switch, Tag } from '@lec-space/liquidglass';
import { Clock3, Flame, ShieldCheck, Trophy, Users } from '@lec-space/icons';
import {
  formatClockDuration,
  formatReadableDuration,
  getCurrentIsoWeek,
  type TeamActiveMember,
} from '@shared/punch';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchToday.module.css';

export function PunchTodayPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const config = useOrbitStore((s) => s.config);
  const attendance = useOrbitStore((s) => s.attendance);
  const networkStatus = useOrbitStore((s) => s.networkStatus);
  const teamActive = useOrbitStore((s) => s.teamActive);
  const weeklyStats = useOrbitStore((s) => s.weeklyStats);
  const points = useOrbitStore((s) => s.points);
  const toggleCheckInOut = useOrbitStore((s) => s.toggleCheckInOut);
  const updateConfig = useOrbitStore((s) => s.updateConfig);
  const setLoginModalOpen = useOrbitStore((s) => s.setLoginModalOpen);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [selectedMember, setSelectedMember] = useState<TeamActiveMember | null>(null);
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
          <h1 className={styles.heading}>今日专注</h1>
          <p className={styles.subheading}>
            {todayLabel} · {getCurrentIsoWeek()}
          </p>
        </div>
        <div className={styles.headerActions}>
          {networkStatus ? (
            <Tag tone={networkStatus.allowed ? 'success' : 'warning'} icon={<ShieldCheck size={14} />}>
              {networkStatus.allowed
                ? `允许签到网络${networkStatus.clientIp ? ` (${networkStatus.clientIp})` : ''}`
                : '当前网络禁止签到（仅可浏览）'}
            </Tag>
          ) : (
            <Tag tone="neutral">等待同步网络策略</Tag>
          )}
        </div>
      </header>

      <section className={styles.heroGrid}>
        <Card className={styles.heroCard} padding="large">
          <div className={styles.heroTop}>
            <Tag tone={attendance?.isCheckedIn ? 'success' : 'neutral'} icon={<Clock3 size={14} />}>
              {attendance?.isCheckedIn ? '专注计时中' : '尚未签到'}
            </Tag>
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
              disabled={!auth.authenticated ? false : !attendance?.isCheckedIn && networkStatus?.allowed === false}
            >
              {!auth.authenticated
                ? '登录 LecSSO 后开始签到'
                : attendance?.isCheckedIn
                  ? '结束专注并签退'
                  : '开始今日签到'}
            </Button>
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
                  <span className={styles.presenceName}>{member.displayName}</span>
                  <span className={styles.presenceSub}>
                    <Flame size={12} /> {member.teamName || '工作室成员'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
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
        </div>
      )}
    </div>
  );
}
