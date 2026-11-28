/** 工作室成员个人信息卡弹窗：聚合 LecSSO 公开资料、第三方绑定（GitHub / 飞书）、在岗状态、本周考勤排名与双人日程对比视图。 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Avatar, Button, Dialog, Tag } from '@lec-space/liquidglass';
import {
  ArrowUpRight,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronLeft,
  Clock,
  Copy,
  Flame,
  Settings,
  Trophy,
} from 'lucide-react';
import {
  DEFAULT_STUDIO_CALENDAR_ID,
  eventCoversDate,
  expandCoursesForDate,
} from '@shared/calendar';
import {
  findCommonFreeSlots,
  formatMinutesToHm,
  hasConflictInRange,
  parseHmToMinutes,
  sliceFreeBusyEventForDate,
} from '@shared/freeBusy';
import type { StudioMemberCard } from '@shared/ipc';
import {
  formatReadableDuration,
  type MemberTitleBadge,
  type TeamActiveMember,
  type TeamWeeklyRankingItem,
} from '@shared/punch';
import { formatLocalDate } from '@shared/schedule';
import { BlogSiteLogo } from '@/components/BlogSiteLogo';
import { SocialBrandGlyph } from '@/components/SocialBrandGlyph';
import { TitleBadgeList } from '@/components/TitleBadge';
import { AttendeeTimelinePanel } from '@/pages/schedule/AttendeeTimelinePanel';
import { getOrbitClient } from '@/services/orbitClient';
import {
  orbitServerApi,
  type FreeBusyBlockDTO,
  type MemberFreeBusyTimelineDTO,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { useCalendarStore } from '@/stores/useCalendarStore';
import { useOrbitStore } from '@/stores/useOrbitStore';
import { useScheduleStore } from '@/stores/useScheduleStore';
import styles from './MemberProfileDialog.module.css';

/** 可从成员名录、本周排行榜或今日在岗伙伴任一卡片传入的定位种子。 */
export interface MemberProfileSeed {
  id?: string;
  username?: string | null;
  displayName?: string;
  realName?: string;
  nickname?: string;
  avatar?: string | null;
  teamName?: string;
  titles?: MemberTitleBadge[];
  studioMember?: StudioMemberCard;
  ranking?: TeamWeeklyRankingItem;
  active?: TeamActiveMember;
}

const ROLE_LABELS: Record<string, { label: string; tone: 'info' | 'warning' | 'neutral' }> = {
  captain: { label: '工作室队长', tone: 'info' },
  'lec-captain': { label: '工作室队长', tone: 'info' },
  admin: { label: '管理员', tone: 'info' },
  'senior-captain': { label: '往届队长', tone: 'warning' },
  member: { label: '正式成员', tone: 'neutral' },
};

/** 从角色列表中提炼展示优先级最高的角色徽章。 */
export function resolvePrimaryStudioRole(roles: readonly string[]): {
  label: string;
  tone: 'info' | 'warning' | 'neutral';
} {
  const lowered = roles.map((r) => r.toLowerCase());
  for (const key of ['captain', 'lec-captain', 'admin', 'senior-captain', 'member']) {
    if (lowered.includes(key)) {
      return ROLE_LABELS[key]!;
    }
  }
  return { label: '工作室成员', tone: 'neutral' };
}

/** 根据 username（优先）或真名匹配 LecSSO 成员名片与 LecPunch 数据。 */
export function matchStudioMember(
  seed: MemberProfileSeed,
  members: readonly StudioMemberCard[],
): StudioMemberCard | undefined {
  if (seed.studioMember) return seed.studioMember;
  const targetHandle = seed.username?.trim().toLowerCase();
  if (targetHandle) {
    const byHandle = members.find((m) => m.username?.toLowerCase() === targetHandle);
    if (byHandle) return byHandle;
  }
  if (seed.id) {
    const byId = members.find((m) => m.id === seed.id);
    if (byId) return byId;
  }
  const targetName = (seed.realName || seed.displayName || '').trim();
  if (targetName) {
    const exact = members.find((m) => m.name && m.name.trim() === targetName);
    if (exact) return exact;
    const stripped = targetName.replace(/[（(].*[）)]$/, '').trim();
    if (stripped) {
      return members.find((m) => m.name && m.name.trim() === stripped);
    }
  }
  return undefined;
}

function matchByMember<T extends { username?: string; realName?: string; displayName: string }>(
  member: StudioMemberCard | undefined,
  seed: MemberProfileSeed,
  list: readonly T[],
): T | undefined {
  const targetHandle = (member?.username || seed.username || '').trim().toLowerCase();
  if (targetHandle) {
    const byHandle = list.find((item) => item.username?.trim().toLowerCase() === targetHandle);
    if (byHandle) return byHandle;
  }
  const targetName = (member?.name || seed.realName || '').trim();
  if (targetName) {
    const byRealName = list.find(
      (item) =>
        item.realName?.trim() === targetName ||
        item.displayName.replace(/[（(].*[）)]$/, '').trim() === targetName,
    );
    if (byRealName) return byRealName;
  }
  return undefined;
}

function SmallSocialAvatar({
  avatar,
  target,
  alt,
}: {
  avatar: string | null;
  target: 'github' | 'feishu';
  alt: string;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatar]);

  if (avatar && !failed) {
    return (
      <span className={styles.socialAvatarWrap}>
        <img
          src={avatar}
          alt={alt}
          className={styles.socialAvatarImg}
          onError={() => setFailed(true)}
        />
        <span className={styles.socialCorner} aria-hidden="true">
          <SocialBrandGlyph target={target} size={11} />
        </span>
      </span>
    );
  }
  return (
    <span className={styles.socialIconCircle} aria-hidden="true">
      <SocialBrandGlyph target={target} size={18} />
    </span>
  );
}

export interface MemberProfileDialogProps {
  seed: MemberProfileSeed | null;
  onClose: () => void;
}

function computeNextHalfHourRange(): { startTime: string; endTime: string } {
  const now = new Date();
  const total = now.getHours() * 60 + now.getMinutes();
  const nextHalf = Math.min(22 * 60, Math.ceil((total + 1) / 30) * 30);
  const startMin = Math.max(8 * 60, nextHalf);
  const endMin = Math.min(23 * 60 + 30, startMin + 60);
  return {
    startTime: formatMinutesToHm(startMin),
    endTime: formatMinutesToHm(endMin),
  };
}

export function MemberProfileDialog({ seed, onClose }: MemberProfileDialogProps): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const studioMembers = useOrbitStore((s) => s.studioMembers);
  const studioMembersLoading = useOrbitStore((s) => s.studioMembersLoading);
  const studioMembersError = useOrbitStore((s) => s.studioMembersError);
  const teamRanking = useOrbitStore((s) => s.teamRanking);
  const teamActive = useOrbitStore((s) => s.teamActive);
  const memberBlogs = useOrbitStore((s) => s.memberBlogs);
  const openBlogTarget = useOrbitStore((s) => s.openBlogTarget);
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const refreshStudioMembers = useOrbitStore((s) => s.refreshStudioMembers);

  // 本地课表与日程状态（用于双人对比视图兜底合并“我”的实时课表与个人日程）
  const calLoaded = useCalendarStore((s) => s.loaded);
  const calCategories = useCalendarStore((s) => s.categories);
  const localEvents = useCalendarStore((s) => s.events);
  const studioEvents = useCalendarStore((s) => s.studioEvents);
  const loadCalendarSnapshot = useCalendarStore((s) => s.loadSnapshot);
  const setPendingCreateDraft = useCalendarStore((s) => s.setPendingCreateDraft);
  const activeScheduleDetail = useScheduleStore((s) => s.activeDetail);
  const loadSchedules = useScheduleStore((s) => s.loadAll);

  const [copiedHandle, setCopiedHandle] = useState(false);
  const [view, setView] = useState<'profile' | 'schedule'>('profile');
  const [scheduleDate, setScheduleDate] = useState(() => formatLocalDate(new Date()));
  const [slotRange, setSlotRange] = useState(() => computeNextHalfHourRange());
  const [timelineMembers, setTimelineMembers] = useState<MemberFreeBusyTimelineDTO[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineFallback, setTimelineFallback] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // 关闭或切换目标成员时重置视图状态
  useEffect(() => {
    setView('profile');
    setScheduleDate(formatLocalDate(new Date()));
    setSlotRange(computeNextHalfHourRange());
    setTimelineMembers([]);
    setTimelineFallback(null);
  }, [seed?.id, seed?.username, seed?.displayName, Boolean(seed)]);

  // 切入日程对比视图时确保本机课表与日历已加载（防止尚未访问过日程页时“我”一列为空）
  useEffect(() => {
    if (view !== 'schedule') return;
    if (!calLoaded) void loadCalendarSnapshot();
    if (!activeScheduleDetail) void loadSchedules();
  }, [view, calLoaded, loadCalendarSnapshot, activeScheduleDetail, loadSchedules]);

  // 打开名片时若尚未拉取过工作室成员目录，自动补拉一次以展示 GitHub / 飞书信息
  useEffect(() => {
    if (
      seed &&
      auth.authenticated &&
      studioMembers.length === 0 &&
      !studioMembersLoading &&
      !studioMembersError
    ) {
      void refreshStudioMembers();
    }
  }, [
    seed,
    auth.authenticated,
    studioMembers.length,
    studioMembersLoading,
    studioMembersError,
    refreshStudioMembers,
  ]);

  const resolved = useMemo(() => {
    if (!seed) return null;
    const member = matchStudioMember(seed, studioMembers);
    const ranking = seed.ranking ?? matchByMember(member, seed, teamRanking);
    const active = seed.active ?? matchByMember(member, seed, teamActive);

    const handle = member?.username ?? seed.username ?? ranking?.username ?? active?.username ?? null;
    const realName = member?.name ?? seed.realName ?? ranking?.realName ?? active?.realName ?? null;
    const displayName =
      seed.displayName ||
      ranking?.displayName ||
      active?.displayName ||
      realName ||
      handle ||
      '工作室成员';
    const avatar = member?.avatar ?? seed.avatar ?? ranking?.avatar ?? active?.avatar ?? undefined;
    const enrollYearLabel = member?.enrollYear
      ? `${member.enrollYear} 级`
      : seed.teamName || ranking?.teamName || active?.teamName || null;
    const role = resolvePrimaryStudioRole(member?.roles ?? []);
    const titles = seed.titles ?? active?.titles ?? ranking?.titles ?? [];
    const isSelf = Boolean(
      (member?.id && auth.profile?.subject && member.id === auth.profile.subject) ||
        (handle &&
          auth.profile?.username &&
          handle.toLowerCase() === auth.profile.username.toLowerCase()),
    );

    return {
      member,
      ranking,
      active,
      handle,
      realName,
      displayName,
      avatar,
      enrollYearLabel,
      role,
      titles,
      isSelf,
    };
  }, [seed, studioMembers, teamRanking, teamActive, auth.profile]);

  const handleCopyHandle = async (value: string) => {
    await getOrbitClient().system.copyText(value);
    setCopiedHandle(true);
    notifyToast({ tone: 'success', title: '已复制 Handle', description: value });
    window.setTimeout(() => setCopiedHandle(false), 1800);
  };

  const github = resolved?.member?.social.github ?? null;
  const feishu = resolved?.member?.social.feishu ?? null;
  const memberBlog = useMemo(() => {
    if (!resolved) return null;
    if (resolved.member?.id) {
      const byId = memberBlogs.find((b) => b.userId === resolved.member!.id);
      if (byId) return byId;
    }
    if (resolved.handle) {
      const lower = resolved.handle.toLowerCase();
      const byHandle = memberBlogs.find((b) => b.username?.toLowerCase() === lower);
      if (byHandle) return byHandle;
    }
    return null;
  }, [resolved, memberBlogs]);
  const githubLabel = github
    ? github.username
      ? github.name && github.name !== github.username
        ? `${github.name}（@${github.username}）`
        : `@${github.username}`
      : github.name || '已绑定 GitHub'
    : null;
  const feishuLabel = feishu
    ? [feishu.name, feishu.enName]
        .filter((v, idx, arr): v is string => Boolean(v) && arr.indexOf(v) === idx)
        .join(' · ') || '已绑定飞书'
    : null;

  const targetUserId = resolved?.member?.id ?? seed?.id ?? null;
  const myUserId = auth.profile?.subject ?? null;

  // 构造本地实时兜底时间轴（左侧「Ta」+ 右侧「我」，本机课表与个人日程实时补齐）
  const buildLocalPairTimelines = useCallback(
    (dateStr: string): MemberFreeBusyTimelineDTO[] => {
      if (!resolved) return [];
      const catById = new Map(calCategories.map((c) => [c.id, c]));
      const dayStudioEvents = studioEvents.filter((ev) => eventCoversDate(ev, dateStr));

      const buildOne = (
        uid: string,
        meta: {
          displayName: string;
          username: string;
          avatar: string;
          enrollYear: number | null;
          isCaptain: boolean;
        },
        isMe: boolean,
      ): MemberFreeBusyTimelineDTO => {
        const blocks: FreeBusyBlockDTO[] = [];

        if (isMe && activeScheduleDetail) {
          for (const occ of expandCoursesForDate(activeScheduleDetail, dateStr)) {
            blocks.push({
              id: `crs:${occ.course.id}:${occ.meeting.id}`,
              kind: 'course',
              title: occ.course.name,
              location: occ.meeting.location || '',
              allDay: false,
              startTime: occ.startTime,
              endTime: occ.endTime,
              color: occ.course.color || '#6366F1',
              status: 'accepted',
              meta: `第${occ.meeting.startSection}-${occ.meeting.endSection}节`,
            });
          }
        }

        if (isMe) {
          for (const ev of localEvents) {
            if (!eventCoversDate(ev, dateStr)) continue;
            const cat = catById.get(ev.calendarId);
            const sliced = sliceFreeBusyEventForDate(ev, dateStr);
            blocks.push({
              id: `per:${ev.id}`,
              kind: 'personal',
              title: ev.title,
              location: ev.location || '',
              allDay: sliced.allDay,
              startTime: sliced.startTime,
              endTime: sliced.endTime,
              color: cat?.color ?? '#2563EB',
              status: 'accepted',
              meta: cat?.name ?? '个人日程',
            });
          }
        }

        for (const ev of dayStudioEvents) {
          const uIds = ev.attendeeUserIds ?? [];
          const grds = ev.attendeeGrades ?? [];
          const involved =
            (uIds.length === 0 && grds.length === 0) ||
            ev.creatorId === uid ||
            uIds.includes(uid) ||
            (meta.enrollYear != null && grds.includes(meta.enrollYear));
          if (!involved) continue;
          const resp =
            ev.attendeeResponses?.[uid] ?? (ev.creatorId === uid ? 'accepted' : 'tentative');
          const sliced = sliceFreeBusyEventForDate(ev, dateStr);
          blocks.push({
            id: `std:${ev.id}`,
            kind: 'studio',
            title: ev.title,
            location: ev.location || '',
            allDay: sliced.allDay,
            startTime: sliced.startTime,
            endTime: sliced.endTime,
            color: '#7C3AED',
            status: resp,
            meta: resp === 'tentative' ? '未回复' : '工作室',
          });
        }

        return {
          userId: uid,
          username: meta.username,
          displayName: meta.displayName,
          avatar: meta.avatar,
          enrollYear: meta.enrollYear,
          isCaptain: meta.isCaptain,
          hasScheduleSynced: Boolean(isMe && activeScheduleDetail?.courses.length),
          snapshotUpdatedAt: null,
          blocks,
        };
      };

      const rows: MemberFreeBusyTimelineDTO[] = [];
      if (!resolved.isSelf && targetUserId) {
        rows.push(
          buildOne(
            targetUserId,
            {
              displayName: resolved.displayName,
              username: resolved.handle ?? targetUserId,
              avatar: resolved.avatar ?? '',
              enrollYear: resolved.member?.enrollYear ?? null,
              isCaptain: (resolved.member?.roles ?? []).some((r) => /captain|admin/i.test(r)),
            },
            false,
          ),
        );
      }
      if (myUserId) {
        const myCard = studioMembers.find((m) => m.id === myUserId);
        rows.push(
          buildOne(
            myUserId,
            {
              displayName: '我',
              username: auth.profile?.username || 'me',
              avatar: myCard?.avatar || auth.profile?.avatar || '',
              enrollYear: myCard?.enrollYear ?? null,
              isCaptain: auth.isAdmin,
            },
            true,
          ),
        );
      }
      return rows;
    },
    [
      resolved,
      targetUserId,
      myUserId,
      calCategories,
      studioEvents,
      activeScheduleDetail,
      localEvents,
      studioMembers,
      auth.profile,
      auth.isAdmin,
    ],
  );

  // 用 ref 持有最新本地时间轴构建器，避免 60s 轮询或 WS 刷新导致 queryFreeBusy 频繁重发
  const buildLocalPairTimelinesRef = useRef(buildLocalPairTimelines);
  buildLocalPairTimelinesRef.current = buildLocalPairTimelines;
  const hasSeed = Boolean(seed);
  const resolvedIsSelf = Boolean(resolved?.isSelf);
  const hasResolved = Boolean(resolved);

  // 拉取「Ta」和「我」的双人日程对比数据
  useEffect(() => {
    if (!hasSeed || !hasResolved || view !== 'schedule') return;
    const queryIds = Array.from(
      new Set([
        ...(!resolvedIsSelf && targetUserId ? [targetUserId] : []),
        ...(myUserId ? [myUserId] : []),
      ]),
    );
    if (queryIds.length === 0) {
      setTimelineMembers([]);
      return;
    }

    let cancelled = false;
    setTimelineLoading(true);
    void orbitServerApi
      .queryFreeBusy({ date: scheduleDate, userIds: queryIds })
      .then((res) => {
        if (cancelled) return;
        const localPair = buildLocalPairTimelinesRef.current(scheduleDate);
        const localMe = myUserId ? localPair.find((m) => m.userId === myUserId) : undefined;
        const mapped = (res.members ?? []).map((m) => {
          if (myUserId && m.userId === myUserId) {
            const existingIds = new Set(m.blocks.map((b) => b.id));
            const extra =
              !m.hasScheduleSynced && localMe
                ? localMe.blocks.filter((b) => !existingIds.has(b.id))
                : [];
            return {
              ...m,
              displayName: '我',
              hasScheduleSynced: m.hasScheduleSynced || Boolean(localMe?.hasScheduleSynced),
              blocks: [...m.blocks, ...extra],
            };
          }
          return m;
        });
        setTimelineMembers(mapped.length > 0 ? mapped : localPair);
        setTimelineFallback(null);
      })
      .catch(() => {
        if (cancelled) return;
        setTimelineMembers(buildLocalPairTimelinesRef.current(scheduleDate));
        setTimelineFallback(
          '当前为本地预览模式（已实时展示你的本机课表与工作室共享日程，服务端升级后自动拉取对方课表）',
        );
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    hasSeed,
    hasResolved,
    resolvedIsSelf,
    view,
    scheduleDate,
    targetUserId,
    myUserId,
    reloadTick,
  ]);

  const pairConflictInfo = useMemo(() => {
    if (view !== 'schedule' || timelineMembers.length === 0) {
      return { hasConflict: false, nextFree: null as { startTime: string; endTime: string } | null };
    }
    const sMin = parseHmToMinutes(slotRange.startTime);
    const eMin = Math.max(sMin + 30, parseHmToMinutes(slotRange.endTime));
    const hasConflict = timelineMembers.some((m) =>
      hasConflictInRange(m.blocks, sMin, eMin, false),
    );
    const nextFree = hasConflict
      ? (findCommonFreeSlots(timelineMembers, Math.max(30, eMin - sMin), 1)[0] ?? null)
      : null;
    return { hasConflict, nextFree };
  }, [view, timelineMembers, slotRange]);

  const handleScheduleWithMember = () => {
    if (!resolved) return;
    if (!resolved.isSelf && targetUserId) {
      setPendingCreateDraft({
        date: scheduleDate,
        startTime: slotRange.startTime,
        endTime: slotRange.endTime,
        calendarId: DEFAULT_STUDIO_CALENDAR_ID,
        attendeeUserIds: [targetUserId],
      });
    }
    onClose();
    setActiveTab('schedule');
  };

  const isScheduleView = view === 'schedule';

  return (
    <Dialog
      open={Boolean(seed && resolved)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size={isScheduleView ? 'large' : 'regular'}
      className={isScheduleView ? styles.scheduleDialog : undefined}
      title={
        isScheduleView && resolved ? (
          <div className={styles.scheduleHeaderTitle}>
            <Button
              variant="glass"
              size="small"
              icon={<ChevronLeft size={14} />}
              onClick={() => setView('profile')}
            >
              返回名片
            </Button>
            <span>
              {resolved.isSelf ? '我的日程' : `${resolved.displayName} 与我的日程`}
            </span>
          </div>
        ) : (
          '成员名片'
        )
      }
      description={
        isScheduleView
          ? '并排对比双方今日课表与日程，点击空闲时间格可直接约时间。'
          : resolved?.isSelf
            ? '你在 LEC 软件工作室的公开名片预览'
            : 'LEC 软件工作室成员公开资料'
      }
      footer={
        resolved ? (
          isScheduleView ? (
            <div className={styles.scheduleFooterRow}>
              <div className={styles.scheduleFooterHint}>
                {pairConflictInfo.hasConflict ? (
                  <>
                    <span className={styles.conflictText}>
                      {slotRange.startTime}–{slotRange.endTime} 存在冲突
                    </span>
                    {pairConflictInfo.nextFree && (
                      <button
                        type="button"
                        className={styles.quickSlotChip}
                        onClick={() => setSlotRange(pairConflictInfo.nextFree!)}
                      >
                        换到共同空闲 {pairConflictInfo.nextFree.startTime}–
                        {pairConflictInfo.nextFree.endTime}
                      </button>
                    )}
                  </>
                ) : (
                  <span className={styles.freeText}>
                    {slotRange.startTime}–{slotRange.endTime} 双方空闲
                  </span>
                )}
              </div>
              <div className={styles.footerRow}>
                <Button variant="glass" size="small" onClick={onClose}>
                  关闭
                </Button>
                <Button
                  variant="filled"
                  size="small"
                  icon={<CalendarPlus size={14} />}
                  onClick={handleScheduleWithMember}
                >
                  {resolved.isSelf ? '前往日程工作台' : '约 Ta 这个时段'}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.footerRow}>
              {resolved.isSelf && (
                <Button
                  variant="glass"
                  size="small"
                  icon={<Settings size={14} />}
                  onClick={() => {
                    onClose();
                    setActiveTab('settings');
                  }}
                >
                  去设置页管理绑定
                </Button>
              )}
              <Button variant="filled" size="small" onClick={onClose}>
                关闭
              </Button>
            </div>
          )
        ) : undefined
      }
    >
      {resolved && isScheduleView ? (
        <div className={styles.scheduleTimelineWrap}>
          <AttendeeTimelinePanel
            date={scheduleDate}
            onDateChange={setScheduleDate}
            allDay={false}
            startTime={slotRange.startTime}
            endTime={slotRange.endTime}
            onSelectTimeRange={(startTime, endTime) => setSlotRange({ startTime, endTime })}
            members={timelineMembers}
            loading={timelineLoading}
            fallbackNotice={timelineFallback}
            onRefresh={() => setReloadTick((t) => t + 1)}
          />
        </div>
      ) : resolved ? (
        <div className={styles.body}>
          <div className={styles.hero}>
            <div className={styles.heroAvatarWrap}>
              <Avatar src={resolved.avatar} name={resolved.realName || resolved.displayName} size="large" />
              {resolved.active && <span className={styles.onlineDot} title="此刻正在工作室专注中" />}
            </div>
            <div className={styles.heroInfo}>
              <div className={styles.nameRow}>
                <h3 className={styles.name}>{resolved.displayName}</h3>
                <Tag tone={resolved.role.tone}>{resolved.role.label}</Tag>
                {resolved.enrollYearLabel && <Tag tone="neutral">{resolved.enrollYearLabel}</Tag>}
              </div>

              {resolved.handle && (
                <button
                  type="button"
                  className={styles.handleChip}
                  onClick={() => void handleCopyHandle(resolved.handle!)}
                  title="点击复制 LecSSO Handle"
                >
                  <span>@{resolved.handle}</span>
                  {copiedHandle ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}

              {resolved.titles.length > 0 && (
                <div className={styles.titlesRow}>
                  <TitleBadgeList titles={resolved.titles} size="xs" maxVisible={4} />
                </div>
              )}
            </div>
          </div>

          <div className={styles.statsGrid}>
            <div className={styles.statBox}>
              <div className={styles.statLabel}>
                <Flame size={13} /> 当前状态
              </div>
              {resolved.active ? (
                <>
                  <div className={styles.statValueActive}>工作室专注中</div>
                  <div className={styles.statSub}>
                    {typeof resolved.active.durationSeconds === 'number'
                      ? `已专注 ${formatReadableDuration(resolved.active.durationSeconds)}`
                      : `签到于 ${new Date(resolved.active.checkedInAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.statValueMuted}>暂未打卡</div>
                  <div className={styles.statSub}>当前不在工作室计时中</div>
                </>
              )}
            </div>

            <div className={styles.statBox}>
              <div className={styles.statLabel}>
                <Trophy size={13} /> 本周专注
              </div>
              {resolved.ranking ? (
                <>
                  <div className={styles.statValue}>
                    {formatReadableDuration(resolved.ranking.totalDurationSeconds)}
                  </div>
                  <div className={styles.statSub}>
                    {typeof resolved.ranking.rank === 'number'
                      ? `本周第 ${resolved.ranking.rank} 名`
                      : '本周已上榜'}
                    {resolved.ranking.qualified ? ' · 已达标' : ''}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.statValueMuted}>暂无记录</div>
                  <div className={styles.statSub}>本周尚未产生专注统计</div>
                </>
              )}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              <Clock size={13} /> 关联社交名片
            </div>

            <div className={styles.socialCards}>
              <div className={styles.socialItem}>
                <div className={styles.socialLeft}>
                  <span className={styles.calendarIconCircle} aria-hidden="true">
                    <CalendarDays size={17} />
                  </span>
                  <div className={styles.socialText}>
                    <div className={styles.socialHead}>
                      <span className={styles.socialName}>日历</span>
                      <Tag tone="info">公开课表与日程</Tag>
                    </div>
                    <div className={styles.socialDesc}>
                      {resolved.isSelf
                        ? '查看我的今日课表与日程安排'
                        : `对比 ${resolved.displayName} 与我的今日空余时间`}
                    </div>
                  </div>
                </div>
                <Button
                  variant="glass"
                  size="small"
                  icon={<CalendarDays size={13} />}
                  onClick={() => setView('schedule')}
                >
                  查看日程
                </Button>
              </div>

              <div className={styles.socialItem}>
                <div className={styles.socialLeft}>
                  <SmallSocialAvatar
                    avatar={github?.avatar ?? null}
                    target="github"
                    alt="GitHub"
                  />
                  <div className={styles.socialText}>
                    <div className={styles.socialHead}>
                      <span className={styles.socialName}>GitHub</span>
                      <Tag tone={github ? 'success' : 'neutral'}>
                        {github ? '已绑定' : '未绑定'}
                      </Tag>
                    </div>
                    <div className={styles.socialDesc}>
                      {github ? githubLabel : '对方尚未绑定 GitHub 账号'}
                    </div>
                  </div>
                </div>
                {github?.profileUrl && (
                  <Button
                    variant="glass"
                    size="small"
                    icon={<ArrowUpRight size={13} />}
                    onClick={() => void getOrbitClient().system.openExternal(github.profileUrl!)}
                  >
                    访问主页
                  </Button>
                )}
              </div>

              <div className={styles.socialItem}>
                <div className={styles.socialLeft}>
                  <SmallSocialAvatar
                    avatar={feishu?.avatar ?? null}
                    target="feishu"
                    alt="飞书"
                  />
                  <div className={styles.socialText}>
                    <div className={styles.socialHead}>
                      <span className={styles.socialName}>飞书</span>
                      <Tag tone={feishu ? 'success' : 'neutral'}>
                        {feishu ? '已绑定' : '未绑定'}
                      </Tag>
                    </div>
                    <div className={styles.socialDesc}>
                      {feishu ? `${feishuLabel} · 乐程软件工作室` : '对方尚未绑定工作室飞书'}
                    </div>
                  </div>
                </div>
              </div>

              {memberBlog && (
                <div className={styles.socialItem}>
                  <div className={styles.socialLeft}>
                    <span className={styles.socialIconCircle} aria-hidden="true">
                      <BlogSiteLogo blogUrl={memberBlog.blogUrl} size={18} />
                    </span>
                    <div className={styles.socialText}>
                      <div className={styles.socialHead}>
                        <span className={styles.socialName}>个人博客</span>
                        <Tag tone="info">已开通</Tag>
                      </div>
                      <div className={styles.socialDesc}>
                        {memberBlog.blogTitle || memberBlog.blogUrl}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="glass"
                    size="small"
                    icon={<ArrowUpRight size={13} />}
                    onClick={() => {
                      openBlogTarget(memberBlog.userId, memberBlog.blogUrl);
                      onClose();
                      setActiveTab('blogs');
                    }}
                  >
                    阅读博客
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
