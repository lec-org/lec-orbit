/**
 * 统一日历业务弹窗集合：
 * 1. EventTaskEditorDialog（创建 / 编辑日程或待办任务，支持顶部一键切换类型）
 * 2. CategoryEditorDialog（新建自定义日历分组）
 * 3. DayDetailDialog（月视图点击某日「+N 项」或「N 节课」弹出当日完整时间线）
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  Avatar,
  Button,
  Checkbox,
  ColorSwatchPicker,
  DatePicker,
  Dialog,
  Input,
  Message,
  SegmentedControl,
  Select,
  Switch,
  Tag,
  TextArea,
  TimeField,
} from '@lec-space/liquidglass';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  EyeOff,
  Globe,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  CALENDAR_COLOR_PALETTE,
  DEFAULT_PERSONAL_CALENDAR_ID,
  DEFAULT_STUDIO_CALENDAR_ID,
  eventCoversDate,
  expandCoursesForDate,
  type CalendarCategory,
  type CalendarEvent,
  type CalendarSubscription,
  type CalendarTask,
  type CalendarTaskPriority,
  type ExpandedCourseOccurrence,
  type ImportIcsFileInput,
  type ImportIcsFileResult,
  type SaveCalendarCategoryInput,
  type SaveCalendarSubscriptionInput,
  type UpsertCalendarEventInput,
  type UpsertCalendarTaskInput,
} from '@shared/calendar';
import type { StudioMemberCard } from '@shared/ipc';
import type { ScheduleCourseWithMeetings, ScheduleDetail } from '@shared/schedule';
import {
  orbitServerApi,
  type FreeBusyBlockDTO,
  type MemberFreeBusyTimelineDTO,
} from '@/services/orbitServerApi';
import {
  AttendeeTimelinePanel,
  findCommonFreeSlots,
  hasConflictInRange,
  parseHmToMinutes,
} from './AttendeeTimelinePanel';
import styles from './Schedule.module.css';

// ── 1. 统一创建 / 编辑「日程 / 任务」弹窗 ──────────────────────────────────

export interface ItemEditorDraft {
  kind: 'event' | 'task';
  editingEvent?: CalendarEvent | null;
  editingTask?: CalendarTask | null;
  defaultDate: string;
  defaultStartTime?: string;
  defaultEndTime?: string;
  /** 新建日程时预选的日历分组 ID */
  defaultCalendarId?: string;
  /** 新建日程时预选的参与人 userId 列表（如从成员名片点击「约 Ta 日程」） */
  defaultAttendeeUserIds?: string[];
}

export interface EditorCurrentUser {
  userId: string;
  displayName: string;
  avatar: string;
}

interface EventTaskEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ItemEditorDraft | null;
  categories: CalendarCategory[];
  studioMembers?: StudioMemberCard[];
  currentUser?: EditorCurrentUser | null;
  activeScheduleDetail?: ScheduleDetail | null;
  localEvents?: CalendarEvent[];
  studioEvents?: CalendarEvent[];
  onSaveEvent: (input: UpsertCalendarEventInput) => Promise<unknown>;
  onDeleteEvent: (eventId: string) => Promise<void>;
  onSaveTask: (input: UpsertCalendarTaskInput) => Promise<unknown>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onSwitchToAddCourse?: () => void;
}

const REMINDER_OPTIONS = [
  { value: 'none', label: '不提醒' },
  { value: '0', label: '准时提醒' },
  { value: '5', label: '提前 5 分钟' },
  { value: '10', label: '提前 10 分钟' },
  { value: '15', label: '提前 15 分钟' },
  { value: '30', label: '提前 30 分钟' },
  { value: '60', label: '提前 1 小时' },
];

export function EventTaskEditorDialog({
  open,
  onOpenChange,
  draft,
  categories,
  studioMembers = [],
  currentUser = null,
  activeScheduleDetail = null,
  localEvents = [],
  studioEvents = [],
  onSaveEvent,
  onDeleteEvent,
  onSaveTask,
  onDeleteTask,
  onSwitchToAddCourse,
}: EventTaskEditorDialogProps): JSX.Element {
  const isEditing = Boolean(draft?.editingEvent || draft?.editingTask);
  const [kind, setKind] = useState<'event' | 'task'>('event');

  // 日程表单字段
  const [evTitle, setEvTitle] = useState('');
  const [evCalendarId, setEvCalendarId] = useState(DEFAULT_PERSONAL_CALENDAR_ID);
  const [evAllDay, setEvAllDay] = useState(false);
  const [evStartDate, setEvStartDate] = useState('');
  const [evEndDate, setEvEndDate] = useState('');
  const [evStartTime, setEvStartTime] = useState('09:00');
  const [evEndTime, setEvEndTime] = useState('10:00');
  const [evLocation, setEvLocation] = useState('');
  const [evReminder, setEvReminder] = useState('15');
  const [evDesc, setEvDesc] = useState('');

  // 参与人（按年级区分 + 单独挑人）与右侧多人时间轴状态
  const [selectedGrades, setSelectedGrades] = useState<number[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [hiddenUserIds, setHiddenUserIds] = useState<string[]>([]);
  const [expandedGrades, setExpandedGrades] = useState<number[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberSearchOpen, setMemberSearchOpen] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  const [freeBusyLoading, setFreeBusyLoading] = useState(false);
  const [freeBusyMembers, setFreeBusyMembers] = useState<MemberFreeBusyTimelineDTO[]>([]);
  const [freeBusyFallback, setFreeBusyFallback] = useState<string | null>(null);
  const [freeBusyReloadTick, setFreeBusyReloadTick] = useState(0);

  // 任务表单字段
  const [tskTitle, setTskTitle] = useState('');
  const [tskDueDate, setTskDueDate] = useState('');
  const [tskDueTime, setTskDueTime] = useState('');
  const [tskPriority, setTskPriority] = useState<CalendarTaskPriority>('medium');
  const [tskCompleted, setTskCompleted] = useState(false);
  const [tskReminder, setTskReminder] = useState('15');
  const [tskDesc, setTskDesc] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 合并当前用户与工作室花名册，确保花名册加载慢或离线时仍至少包含自己
  const normalizedMembers = useMemo(() => {
    const byId = new Map<
      string,
      {
        userId: string;
        username: string;
        displayName: string;
        avatar: string;
        enrollYear: number | null;
        isCaptain: boolean;
      }
    >();
    for (const m of studioMembers) {
      byId.set(m.id, {
        userId: m.id,
        username: m.username ?? '',
        displayName: m.name || m.username || m.id,
        avatar: m.avatar ?? '',
        enrollYear: m.enrollYear ?? null,
        isCaptain: (m.roles ?? []).some((r) => /captain|admin|leader/i.test(r)),
      });
    }
    if (currentUser?.userId && !byId.has(currentUser.userId)) {
      byId.set(currentUser.userId, {
        userId: currentUser.userId,
        username: currentUser.displayName,
        displayName: currentUser.displayName || '我',
        avatar: currentUser.avatar || '',
        enrollYear: null,
        isCaptain: false,
      });
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.userId === currentUser?.userId) return -1;
      if (b.userId === currentUser?.userId) return 1;
      const ya = a.enrollYear ?? 0;
      const yb = b.enrollYear ?? 0;
      if (ya !== yb) return yb - ya;
      return a.displayName.localeCompare(b.displayName, 'zh-CN');
    });
  }, [studioMembers, currentUser]);

  const memberById = useMemo(() => {
    const map = new Map<string, (typeof normalizedMembers)[number]>();
    for (const m of normalizedMembers) map.set(m.userId, m);
    return map;
  }, [normalizedMembers]);

  // 按年级聚合可用成员分组（例如 2025 级、2024 级、2023 级、2022 级）
  const gradeGroups = useMemo(() => {
    const map = new Map<number, typeof normalizedMembers>();
    for (const m of normalizedMembers) {
      if (m.enrollYear == null) continue;
      const list = map.get(m.enrollYear) ?? [];
      list.push(m);
      map.set(m.enrollYear, list);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([grade, members]) => ({ grade, members }));
  }, [normalizedMembers]);

  useEffect(() => {
    if (!open || !draft) return;
    setError(null);
    setKind(draft.kind);
    setMemberSearch('');
    setMemberSearchOpen(false);
    setHiddenUserIds([]);
    setExpandedGrades([]);

    if (draft.editingEvent) {
      const e = draft.editingEvent;
      setEvTitle(e.title);
      setEvCalendarId(e.calendarId);
      setEvAllDay(e.allDay);
      setEvStartDate(e.startDate);
      setEvEndDate(e.endDate);
      setEvStartTime(e.startTime);
      setEvEndTime(e.endTime);
      setEvLocation(e.location);
      setEvReminder(e.reminderMinutes == null ? 'none' : String(e.reminderMinutes));
      setEvDesc(e.description);
      const initGrades = e.attendeeGrades ?? [];
      const initUsers = e.attendeeUserIds ?? [];
      setSelectedGrades(initGrades);
      setSelectedUserIds(
        initUsers.length > 0
          ? initUsers
          : currentUser?.userId
            ? [currentUser.userId]
            : [],
      );
      setTimelineExpanded(
        e.calendarId === DEFAULT_STUDIO_CALENDAR_ID ||
          initGrades.length > 0 ||
          initUsers.length > 1,
      );
    } else {
      const initCalId =
        draft.defaultCalendarId && categories.some((c) => c.id === draft.defaultCalendarId)
          ? draft.defaultCalendarId
          : categories[0]?.id ?? DEFAULT_PERSONAL_CALENDAR_ID;
      setEvTitle('');
      setEvCalendarId(initCalId);
      setEvAllDay(false);
      setEvStartDate(draft.defaultDate);
      setEvEndDate(draft.defaultDate);
      setEvStartTime(draft.defaultStartTime ?? '09:00');
      setEvEndTime(draft.defaultEndTime ?? '10:00');
      setEvLocation('');
      setEvReminder('15');
      setEvDesc('');
      const initUsers = Array.from(
        new Set([
          ...(currentUser?.userId ? [currentUser.userId] : []),
          ...(draft.defaultAttendeeUserIds ?? []),
        ]),
      );
      setSelectedGrades([]);
      setSelectedUserIds(initUsers);
      setTimelineExpanded(
        initCalId === DEFAULT_STUDIO_CALENDAR_ID || initUsers.length > 1,
      );
    }

    if (draft.editingTask) {
      const t = draft.editingTask;
      setTskTitle(t.title);
      setTskDueDate(t.dueDate ?? '');
      setTskDueTime(t.dueTime ?? '');
      setTskPriority(t.priority);
      setTskCompleted(t.completed);
      setTskReminder(t.reminderMinutes == null ? 'none' : String(t.reminderMinutes));
      setTskDesc(t.description);
    } else {
      setTskTitle('');
      setTskDueDate(draft.defaultDate);
      setTskDueTime(draft.defaultStartTime ?? '');
      setTskPriority('medium');
      setTskCompleted(false);
      setTskReminder('15');
      setTskDesc('');
    }
  }, [open, draft, categories, currentUser?.userId]);

  // 合并最终解析出的参与人 ID 列表（自己置顶 + 年级成员 + 单独挑选成员，去重）
  const resolvedAttendeeIds = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    if (currentUser?.userId && selectedUserIds.includes(currentUser.userId)) {
      push(currentUser.userId);
    }
    for (const id of selectedUserIds) push(id);
    for (const g of selectedGrades) {
      const grp = gradeGroups.find((item) => item.grade === g);
      if (grp) {
        for (const m of grp.members) push(m.userId);
      }
    }
    return ordered;
  }, [selectedUserIds, selectedGrades, gradeGroups, currentUser?.userId]);

  // 是否开启右侧多人时间轴双栏视图
  const showTimelineSplit =
    kind === 'event' &&
    (timelineExpanded ||
      evCalendarId === DEFAULT_STUDIO_CALENDAR_ID ||
      selectedGrades.length > 0 ||
      resolvedAttendeeIds.length > 1);

  // 单独挑人过滤（剔除已作为单人选中的，搜索匹配姓名/用户名/年级）
  const searchCandidates = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return normalizedMembers
      .filter((m) => {
        if (!q) return true;
        return (
          m.displayName.toLowerCase().includes(q) ||
          m.username.toLowerCase().includes(q) ||
          (m.enrollYear != null && `${m.enrollYear}级`.includes(q))
        );
      })
      .slice(0, 12);
  }, [normalizedMembers, memberSearch]);

  // 构造本地兜底时间轴（后端离线/尚未升级时，当前用户实时展示本机课表+个人日程+工作室日程）
  const buildLocalFallbackTimelines = useCallback(
    (dateStr: string, targetIds: string[]): MemberFreeBusyTimelineDTO[] => {
      const excludeId = draft?.editingEvent?.id;
      const categoryById = new Map(categories.map((c) => [c.id, c]));
      const dayStudioEvents = studioEvents.filter(
        (ev) => ev.id !== excludeId && eventCoversDate(ev, dateStr),
      );

      return targetIds.map((uid) => {
        const meta = memberById.get(uid);
        const isMe = Boolean(currentUser?.userId && uid === currentUser.userId);
        const blocks: FreeBusyBlockDTO[] = [];

        if (isMe && activeScheduleDetail) {
          const courseOccs = expandCoursesForDate(activeScheduleDetail, dateStr);
          for (const occ of courseOccs) {
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
            if (ev.id === excludeId) continue;
            if (!eventCoversDate(ev, dateStr)) continue;
            const cat = categoryById.get(ev.calendarId);
            blocks.push({
              id: `per:${ev.id}`,
              kind: 'personal',
              title: ev.title,
              location: ev.location || '',
              allDay: ev.allDay || ev.endDate > ev.startDate,
              startTime: ev.startTime,
              endTime: ev.endTime,
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
            (meta?.enrollYear != null && grds.includes(meta.enrollYear));
          if (!involved) continue;
          const resp =
            ev.attendeeResponses?.[uid] ??
            (ev.creatorId === uid ? 'accepted' : 'tentative');
          blocks.push({
            id: `std:${ev.id}`,
            kind: 'studio',
            title: ev.title,
            location: ev.location || '',
            allDay: ev.allDay || ev.endDate > ev.startDate,
            startTime: ev.startTime,
            endTime: ev.endTime,
            color: '#7C3AED',
            status: resp,
            meta: resp === 'tentative' ? '未回复' : '工作室',
          });
        }

        return {
          userId: uid,
          username: meta?.username ?? uid,
          displayName: meta?.displayName ?? (isMe ? currentUser?.displayName ?? '我' : uid),
          avatar: meta?.avatar ?? (isMe ? currentUser?.avatar ?? '' : ''),
          enrollYear: meta?.enrollYear ?? null,
          isCaptain: meta?.isCaptain ?? false,
          hasScheduleSynced: Boolean(isMe && activeScheduleDetail?.courses.length),
          snapshotUpdatedAt: null,
          blocks,
        };
      });
    },
    [
      draft?.editingEvent?.id,
      categories,
      studioEvents,
      memberById,
      currentUser,
      activeScheduleDetail,
      localEvents,
    ],
  );

  // 拉取右侧多人忙闲数据（防抖 + 后端优先 + 本机课表兜底）
  useEffect(() => {
    if (!open || !showTimelineSplit || !evStartDate) return;
    const queryUserIds =
      resolvedAttendeeIds.length > 0
        ? resolvedAttendeeIds
        : normalizedMembers.slice(0, 8).map((m) => m.userId);
    if (queryUserIds.length === 0) {
      setFreeBusyMembers([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setFreeBusyLoading(true);
      try {
        const res = await orbitServerApi.queryFreeBusy({
          date: evStartDate,
          userIds: queryUserIds,
          grades: selectedGrades,
          excludeEventId: draft?.editingEvent?.source === 'studio' ? draft.editingEvent.id : undefined,
        });
        if (cancelled) return;

        // 对当前用户自己：若服务端尚未收到本机最新课表快照，自动用本机实时课表与个人日程补全合并
        const localSelf = currentUser?.userId
          ? buildLocalFallbackTimelines(evStartDate, [currentUser.userId])[0]
          : undefined;
        const merged = (res.members ?? []).map((m) => {
          if (currentUser?.userId && m.userId === currentUser.userId && localSelf && !m.hasScheduleSynced) {
            const existingIds = new Set(m.blocks.map((b) => b.id));
            const extra = localSelf.blocks.filter((b) => !existingIds.has(b.id));
            return {
              ...m,
              hasScheduleSynced: localSelf.hasScheduleSynced,
              blocks: [...m.blocks, ...extra],
            };
          }
          return m;
        });

        setFreeBusyMembers(merged);
        setFreeBusyFallback(null);
      } catch {
        if (cancelled) return;
        setFreeBusyMembers(buildLocalFallbackTimelines(evStartDate, queryUserIds));
        setFreeBusyFallback('当前处于本地预览模式（已展示本机课表与工作室共享日程，服务端升级后自动拉取全员课表）');
      } finally {
        if (!cancelled) setFreeBusyLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    open,
    showTimelineSplit,
    evStartDate,
    resolvedAttendeeIds,
    selectedGrades,
    normalizedMembers,
    draft?.editingEvent?.id,
    draft?.editingEvent?.source,
    currentUser?.userId,
    buildLocalFallbackTimelines,
    freeBusyReloadTick,
  ]);

  // 过滤掉用户手动点击「隐藏眼睛」的成员列
  const visibleTimelineMembers = useMemo(
    () => freeBusyMembers.filter((m) => !hiddenUserIds.includes(m.userId)),
    [freeBusyMembers, hiddenUserIds],
  );

  // 实时冲突检测与共同空闲时段推荐
  const conflictAnalysis = useMemo(() => {
    if (!showTimelineSplit || visibleTimelineMembers.length === 0) {
      return { conflictNames: [] as string[], suggestions: [] as Array<{ startTime: string; endTime: string }> };
    }
    const sMin = parseHmToMinutes(evStartTime);
    const eMin = Math.max(sMin + 15, parseHmToMinutes(evEndTime));
    const conflictNames = visibleTimelineMembers
      .filter((m) => hasConflictInRange(m.blocks, sMin, eMin, evAllDay))
      .map((m) => m.displayName);
    const suggestions =
      conflictNames.length > 0 && !evAllDay
        ? findCommonFreeSlots(visibleTimelineMembers, Math.max(30, eMin - sMin), 3)
        : [];
    return { conflictNames, suggestions };
  }, [showTimelineSplit, visibleTimelineMembers, evStartTime, evEndTime, evAllDay]);

  const toggleGrade = (grade: number) => {
    setSelectedGrades((prev) => {
      const exists = prev.includes(grade);
      const next = exists ? prev.filter((g) => g !== grade) : [...prev, grade].sort((a, b) => b - a);
      if (!exists) {
        setTimelineExpanded(true);
        if (evCalendarId !== DEFAULT_STUDIO_CALENDAR_ID) {
          setEvCalendarId(DEFAULT_STUDIO_CALENDAR_ID);
        }
      }
      return next;
    });
  };

  const toggleAllGrades = () => {
    const allGrades = gradeGroups.map((g) => g.grade);
    const allSelected = allGrades.length > 0 && allGrades.every((g) => selectedGrades.includes(g));
    if (allSelected) {
      setSelectedGrades([]);
    } else {
      setSelectedGrades(allGrades);
      setTimelineExpanded(true);
      if (evCalendarId !== DEFAULT_STUDIO_CALENDAR_ID) {
        setEvCalendarId(DEFAULT_STUDIO_CALENDAR_ID);
      }
    }
  };

  const addIndividualUser = (userId: string) => {
    setSelectedUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    setHiddenUserIds((prev) => prev.filter((id) => id !== userId));
    setMemberSearch('');
    setMemberSearchOpen(false);
    setTimelineExpanded(true);
    if (userId !== currentUser?.userId && evCalendarId !== DEFAULT_STUDIO_CALENDAR_ID) {
      setEvCalendarId(DEFAULT_STUDIO_CALENDAR_ID);
    }
  };

  const removeIndividualUser = (userId: string) => {
    setSelectedUserIds((prev) => prev.filter((id) => id !== userId));
  };

  const toggleHideUser = (userId: string) => {
    setHiddenUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const toggleHideGrade = (grade: number) => {
    const grp = gradeGroups.find((g) => g.grade === grade);
    if (!grp) return;
    const ids = grp.members.map((m) => m.userId);
    const allHidden = ids.length > 0 && ids.every((id) => hiddenUserIds.includes(id));
    setHiddenUserIds((prev) =>
      allHidden
        ? prev.filter((id) => !ids.includes(id))
        : Array.from(new Set([...prev, ...ids])),
    );
  };

  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.id, label: c.name })),
    [categories],
  );

  const handleSubmit = async () => {
    setError(null);
    if (kind === 'event') {
      if (!evTitle.trim()) {
        setError('请输入日程标题');
        return;
      }
      if (!evStartDate) {
        setError('请选择开始日期');
        return;
      }
      const safeEndDate = evEndDate && evEndDate >= evStartDate ? evEndDate : evStartDate;
      if (!evAllDay && safeEndDate === evStartDate && evEndTime <= evStartTime) {
        setError('同一天的结束时间必须晚于开始时间');
        return;
      }
      setSaving(true);
      try {
        const isStudioTarget = evCalendarId === DEFAULT_STUDIO_CALENDAR_ID;
        await onSaveEvent({
          id: draft?.editingEvent?.id,
          calendarId: evCalendarId,
          title: evTitle.trim(),
          description: evDesc.trim(),
          location: evLocation.trim(),
          allDay: evAllDay,
          startDate: evStartDate,
          endDate: safeEndDate,
          startTime: evStartTime,
          endTime: evEndTime,
          reminderMinutes: evReminder === 'none' ? null : Number(evReminder),
          ...(isStudioTarget
            ? {
                attendeeUserIds: selectedUserIds,
                attendeeGrades: selectedGrades,
              }
            : {}),
        });
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存日程失败');
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!tskTitle.trim()) {
      setError('请输入任务标题');
      return;
    }
    setSaving(true);
    try {
      await onSaveTask({
        id: draft?.editingTask?.id,
        title: tskTitle.trim(),
        description: tskDesc.trim(),
        dueDate: tskDueDate.trim() || null,
        dueTime: tskDueTime.trim() || null,
        priority: tskPriority,
        completed: tskCompleted,
        reminderMinutes: tskReminder === 'none' ? null : Number(tskReminder),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存任务失败');
    } finally {
      setSaving(false);
    }
  };

  // 只列作为「单人选择」加入的成员（若某成员已包含在选中年级内且不是自己，不重复占单人行）
  const selectedGradeMemberSet = useMemo(() => {
    const s = new Set<string>();
    for (const g of selectedGrades) {
      const grp = gradeGroups.find((item) => item.grade === g);
      grp?.members.forEach((m) => s.add(m.userId));
    }
    return s;
  }, [selectedGrades, gradeGroups]);

  const standaloneUsers = useMemo(
    () =>
      selectedUserIds
        .filter((id) => id === currentUser?.userId || !selectedGradeMemberSet.has(id))
        .map((id) => memberById.get(id))
        .filter((m): m is NonNullable<typeof m> => Boolean(m)),
    [selectedUserIds, currentUser?.userId, selectedGradeMemberSet, memberById],
  );

  const formContent = (
    <>
      {!isEditing && (
        <div className={styles.inlineRow} style={{ justifyContent: 'space-between' }}>
          <SegmentedControl
            value={kind}
            onValueChange={(v) => {
              setKind(v as 'event' | 'task');
              setError(null);
            }}
            items={[
              { value: 'event', label: '新建日程' },
              { value: 'task', label: '创建任务' },
            ]}
          />
          <div className={styles.inlineRow}>
            {kind === 'event' && (
              <Button
                variant="glass"
                size="small"
                icon={<Users size={13} />}
                onClick={() => setTimelineExpanded((v) => !v)}
              >
                {showTimelineSplit ? '收起时间对比' : '对比大家时间'}
              </Button>
            )}
            {onSwitchToAddCourse && (
              <Button
                variant="glass"
                size="small"
                icon={<Plus size={13} />}
                onClick={() => {
                  onOpenChange(false);
                  onSwitchToAddCourse();
                }}
              >
                添加课程
              </Button>
            )}
          </div>
        </div>
      )}

      {kind === 'event' ? (
        <>
          <div className={styles.fieldRowTitle}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>日程标题 *</span>
              <Input
                variant="fill"
                value={evTitle}
                onValueChange={setEvTitle}
                placeholder="例如：2024 级项目评审 / 工作室周会"
              />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>归属日历</span>
              <Select
                options={categoryOptions}
                value={evCalendarId}
                onValueChange={(nextId) => {
                  setEvCalendarId(nextId);
                  if (nextId === DEFAULT_STUDIO_CALENDAR_ID) {
                    setTimelineExpanded(true);
                  }
                }}
              />
            </div>
          </div>

          {/* 参与人选择（按年级批量 + 单独挑人，自动展开右侧时间轴） */}
          <div className={styles.attendeeSection}>
            <div className={styles.attendeeSectionHead}>
              <span className={styles.attendeeTitle}>
                <Users size={13} />
                参与人（{resolvedAttendeeIds.length || 1}）
              </span>
              {evCalendarId === DEFAULT_STUDIO_CALENDAR_ID && (
                <Tag tone="info">工作室云端共享</Tag>
              )}
            </div>

            {/* 单独挑人搜索框 */}
            <div className={styles.attendeeSearchWrap}>
              <Input
                variant="fill"
                value={memberSearch}
                onValueChange={(val) => {
                  setMemberSearch(val);
                  setMemberSearchOpen(true);
                }}
                onFocus={() => setMemberSearchOpen(true)}
                onBlur={() => window.setTimeout(() => setMemberSearchOpen(false), 160)}
                placeholder="搜索成员姓名、用户名或年级（如 2024）单独添加…"
              />
              {memberSearchOpen && searchCandidates.length > 0 && (
                <div className={styles.attendeeDropdown}>
                  {searchCandidates.map((m) => {
                    const already = resolvedAttendeeIds.includes(m.userId);
                    return (
                      <button
                        key={m.userId}
                        type="button"
                        className={styles.attendeeOptionBtn}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (already) {
                            removeIndividualUser(m.userId);
                          } else {
                            addIndividualUser(m.userId);
                          }
                        }}
                      >
                        <Avatar size={22} src={m.avatar || undefined} name={m.displayName} />
                        <span>{m.displayName}</span>
                        {m.enrollYear && (
                          <Tag tone="neutral">{m.enrollYear}级</Tag>
                        )}
                        <span className={styles.attendeeOptionMeta}>
                          {already ? '已添加' : '+ 添加'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 按年级一键批量选择 */}
            {gradeGroups.length > 0 && (
              <div className={styles.gradeChipRow}>
                <button
                  type="button"
                  className={`${styles.gradeChip} ${
                    gradeGroups.every((g) => selectedGrades.includes(g.grade))
                      ? styles.gradeChipActive
                      : ''
                  }`}
                  onClick={toggleAllGrades}
                >
                  全员 ({normalizedMembers.length})
                </button>
                {gradeGroups.map((g) => {
                  const active = selectedGrades.includes(g.grade);
                  return (
                    <button
                      key={g.grade}
                      type="button"
                      className={`${styles.gradeChip} ${active ? styles.gradeChipActive : ''}`}
                      onClick={() => toggleGrade(g.grade)}
                    >
                      {g.grade}级 ({g.members.length})
                    </button>
                  );
                })}
              </div>
            )}

            {/* 已选参与人胶囊列表（年级组 + 单独成员，仿飞书眼睛显隐/移除） */}
            {(selectedGrades.length > 0 || standaloneUsers.length > 0) && (
              <div className={styles.attendeeSelectedList}>
                {selectedGrades.map((grade) => {
                  const grp = gradeGroups.find((g) => g.grade === grade);
                  const members = grp?.members ?? [];
                  const expanded = expandedGrades.includes(grade);
                  const allHidden =
                    members.length > 0 &&
                    members.every((m) => hiddenUserIds.includes(m.userId));
                  return (
                    <div key={grade} className={styles.attendeeGroupCard}>
                      <div className={styles.attendeeGroupRow}>
                        <span className={styles.attendeeGroupIcon}>
                          {String(grade).slice(-2)}
                        </span>
                        <button
                          type="button"
                          className={styles.attendeeMiniBtn}
                          style={{ width: 'auto', flex: 1, justifyContent: 'flex-start', gap: 4 }}
                          onClick={() =>
                            setExpandedGrades((prev) =>
                              prev.includes(grade)
                                ? prev.filter((x) => x !== grade)
                                : [...prev, grade],
                            )
                          }
                        >
                          <span className={styles.attendeeRowLabel}>
                            {grade} 级成员 ({members.length})
                          </span>
                          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                        <div className={styles.attendeeMiniActions}>
                          <button
                            type="button"
                            className={styles.attendeeMiniBtn}
                            title={allHidden ? '在右侧时间轴显示该年级' : '在右侧时间轴隐藏该年级'}
                            onClick={() => toggleHideGrade(grade)}
                          >
                            {allHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button
                            type="button"
                            className={styles.attendeeMiniBtn}
                            title="移除该年级"
                            onClick={() => toggleGrade(grade)}
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                      {expanded && members.length > 0 && (
                        <div className={styles.attendeeGroupMembers}>
                          {members.map((m) => {
                            const isHidden = hiddenUserIds.includes(m.userId);
                            return (
                              <button
                                key={m.userId}
                                type="button"
                                className={`${styles.attendeeSubPill} ${
                                  isHidden ? styles.attendeeSubPillHidden : ''
                                }`}
                                title={isHidden ? '点击在右侧时间轴显示' : '点击在右侧时间轴隐藏'}
                                onClick={() => toggleHideUser(m.userId)}
                              >
                                <Avatar size={16} src={m.avatar || undefined} name={m.displayName} />
                                <span>{m.displayName}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {standaloneUsers.map((m) => {
                  const isMe = m.userId === currentUser?.userId;
                  const isHidden = hiddenUserIds.includes(m.userId);
                  return (
                    <div key={m.userId} className={styles.attendeeItemRow}>
                      <Avatar size={22} src={m.avatar || undefined} name={m.displayName} />
                      <span className={styles.attendeeRowLabel}>
                        {m.displayName}
                        {isMe && <span className={styles.attendeeRowSub}>（我）</span>}
                        {!isMe && m.enrollYear && (
                          <span className={styles.attendeeRowSub}>{m.enrollYear}级</span>
                        )}
                      </span>
                      <div className={styles.attendeeMiniActions}>
                        <button
                          type="button"
                          className={styles.attendeeMiniBtn}
                          title={isHidden ? '在右侧时间轴显示此人' : '在右侧时间轴隐藏此人'}
                          onClick={() => toggleHideUser(m.userId)}
                        >
                          {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        {!isMe && (
                          <button
                            type="button"
                            className={styles.attendeeMiniBtn}
                            title="移除参与人"
                            onClick={() => removeIndividualUser(m.userId)}
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingMeta}>
              <span className={styles.settingTitle}>全天日程</span>
              <span className={styles.settingDesc}>开启后以胶囊条展示在日期顶部，支持跨多天</span>
            </div>
            <Switch checked={evAllDay} onCheckedChange={setEvAllDay} />
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>开始日期</span>
              <DatePicker
                value={evStartDate}
                clearable={false}
                onValueChange={(v) => {
                  if (!v) return;
                  setEvStartDate(v);
                  if (!evEndDate || evEndDate < v) setEvEndDate(v);
                }}
                aria-label="日程开始日期"
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>结束日期</span>
              <DatePicker
                value={evEndDate}
                min={evStartDate}
                clearable={false}
                onValueChange={(v) => v && setEvEndDate(v)}
                aria-label="日程结束日期"
              />
            </div>
          </div>

          {!evAllDay && (
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>开始时间</span>
                <TimeField
                  hourCycle={24}
                  value={evStartTime}
                  onValueChange={(v) => v && setEvStartTime(v)}
                  aria-label="日程开始时间"
                />
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>结束时间</span>
                <TimeField
                  hourCycle={24}
                  value={evEndTime}
                  onValueChange={(v) => v && setEvEndTime(v)}
                  aria-label="日程结束时间"
                />
              </div>
            </div>
          )}

          {/* 实时冲突提示 + 一键推荐空档 */}
          {showTimelineSplit && visibleTimelineMembers.length > 0 && (
            <div
              className={`${styles.conflictBar} ${
                conflictAnalysis.conflictNames.length === 0 ? styles.conflictBarFree : ''
              }`}
            >
              {conflictAnalysis.conflictNames.length === 0 ? (
                <span>
                  当前时段全员空闲（已核对 {visibleTimelineMembers.length} 人）
                </span>
              ) : (
                <>
                  <span>
                    当前时段 {conflictAnalysis.conflictNames.length} 人冲突：
                    {conflictAnalysis.conflictNames.slice(0, 4).join('、')}
                    {conflictAnalysis.conflictNames.length > 4 ? ' 等' : ''}
                  </span>
                  {conflictAnalysis.suggestions.length > 0 && (
                    <div className={styles.conflictSlotRow}>
                      <span>推荐共同空闲：</span>
                      {conflictAnalysis.suggestions.map((slot) => (
                        <button
                          key={`${slot.startTime}-${slot.endTime}`}
                          type="button"
                          className={styles.conflictSlotBtn}
                          onClick={() => {
                            setEvStartTime(slot.startTime);
                            setEvEndTime(slot.endTime);
                          }}
                        >
                          {slot.startTime}–{slot.endTime}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>地点 / 会议室（可选）</span>
              <Input
                variant="fill"
                value={evLocation}
                onValueChange={setEvLocation}
                placeholder="例如：明理楼 B305 / 线上"
              />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>系统提醒</span>
              <Select
                options={REMINDER_OPTIONS}
                value={evReminder}
                onValueChange={setEvReminder}
              />
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>备注（可选）</span>
            <TextArea
              variant="fill"
              rows={2}
              value={evDesc}
              onValueChange={setEvDesc}
              placeholder="议程、链接或准备工作…"
            />
          </div>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>任务标题 *</span>
            <Input
              variant="fill"
              value={tskTitle}
              onValueChange={setTskTitle}
              placeholder="例如：提交操作系统实验报告 / 整理本周周报"
            />
          </label>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>截止日期（留空则为无日期收集箱）</span>
              <DatePicker
                value={tskDueDate}
                clearable
                onValueChange={setTskDueDate}
                placeholder="选择截止日期"
                aria-label="任务截止日期"
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>截止时间（可选）</span>
              <TimeField
                hourCycle={24}
                value={tskDueTime}
                onValueChange={setTskDueTime}
                aria-label="任务截止时间"
              />
            </div>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>优先级</span>
              <SegmentedControl
                value={tskPriority}
                onValueChange={(v) => setTskPriority(v as CalendarTaskPriority)}
                items={[
                  { value: 'low', label: '低' },
                  { value: 'medium', label: '中' },
                  { value: 'high', label: '高' },
                ]}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>截止前提醒</span>
              <Select
                options={REMINDER_OPTIONS}
                value={tskReminder}
                onValueChange={setTskReminder}
              />
            </div>
          </div>

          {draft?.editingTask && (
            <div className={styles.settingRow}>
              <span className={styles.settingTitle}>标记为已完成</span>
              <Switch checked={tskCompleted} onCheckedChange={setTskCompleted} />
            </div>
          )}

          <div className={styles.field}>
            <span className={styles.fieldLabel}>任务说明（可选）</span>
            <TextArea
              variant="fill"
              rows={3}
              value={tskDesc}
              onValueChange={setTskDesc}
              placeholder="拆解步骤或提交要求…"
            />
          </div>
        </>
      )}

      {error && <Message tone="error">{error}</Message>}
    </>
  );

  const footerNode = (
    <div className={styles.dialogFooterBar}>
      {draft?.editingEvent ? (
        <Button
          variant="glass"
          destructive
          icon={<Trash2 size={14} />}
          onClick={() => void onDeleteEvent(draft.editingEvent!.id).then(() => onOpenChange(false))}
        >
          删除日程
        </Button>
      ) : draft?.editingTask ? (
        <Button
          variant="glass"
          destructive
          icon={<Trash2 size={14} />}
          onClick={() => void onDeleteTask(draft.editingTask!.id).then(() => onOpenChange(false))}
        >
          删除任务
        </Button>
      ) : (
        <span />
      )}

      <div className={styles.dialogFooterRight}>
        <Button variant="glass" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="filled" loading={saving} onClick={() => void handleSubmit()}>
          {kind === 'event' ? '保存日程' : '保存任务'}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size={showTimelineSplit ? 'large' : 'regular'}
      className={showTimelineSplit ? styles.eventDialogWide : undefined}
      title={
        isEditing
          ? draft?.editingEvent
            ? '编辑日程'
            : '编辑任务'
          : '新建安排'
      }
      description={
        showTimelineSplit
          ? '按年级或单独挑选参与人，右侧实时对比大家的课表与日程，点击空闲时间格即可快速排期。'
          : '统一管理个人日程、工作室会议、全天事件与带截止时间的待办任务。'
      }
      footer={footerNode}
    >
      {showTimelineSplit ? (
        <div className={styles.eventSplitLayout}>
          <div className={styles.eventSplitLeft}>{formContent}</div>
          <div className={styles.eventSplitRight}>
            <AttendeeTimelinePanel
              date={evStartDate}
              onDateChange={(nextDate) => {
                setEvStartDate(nextDate);
                if (!evEndDate || evEndDate < nextDate || evEndDate === evStartDate) {
                  setEvEndDate(nextDate);
                }
              }}
              allDay={evAllDay}
              startTime={evStartTime}
              endTime={evEndTime}
              onSelectTimeRange={(s, e) => {
                setEvAllDay(false);
                setEvStartTime(s);
                setEvEndTime(e);
              }}
              members={visibleTimelineMembers}
              loading={freeBusyLoading}
              fallbackNotice={freeBusyFallback}
              onRefresh={() => setFreeBusyReloadTick((t) => t + 1)}
              onHideMember={toggleHideUser}
            />
          </div>
        </div>
      ) : (
        <div className={styles.dialogBody}>{formContent}</div>
      )}
    </Dialog>
  );
}

// ── 2. 添加自定义日历分组弹窗 ──────────────────────────────────────────────

// ── 2. 统一「添加 / 编辑日历」弹窗（本地日历 / URL 订阅 / 导入 .ics） ────

export type CalendarManageTab = 'local' | 'subscribe' | 'import';

export interface CategoryEditorDraft {
  initialTab?: CalendarManageTab;
  editingCategory?: CalendarCategory | null;
  editingSubscription?: CalendarSubscription | null;
}

interface CategoryEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft?: CategoryEditorDraft | null;
  onSaveCategory: (input: SaveCalendarCategoryInput) => Promise<void>;
  onDeleteCategory: (categoryId: string) => Promise<void>;
  onSaveSubscription: (input: SaveCalendarSubscriptionInput) => Promise<void>;
  onRefreshSubscription: (subscriptionId: string) => Promise<void>;
  onDeleteSubscription: (subscriptionId: string) => Promise<void>;
  onImportIcsFile: (input: ImportIcsFileInput) => Promise<ImportIcsFileResult>;
}

const PRESET_SUBSCRIPTIONS = [
  {
    label: 'Apple 中国节日与节气',
    name: '中国传统节日与节气',
    url: 'https://calendars.icloud.com/holidays/cn_zh.ics',
    color: '#EC4899',
  },
] as const;

export function CategoryEditorDialog({
  open,
  onOpenChange,
  draft,
  onSaveCategory,
  onDeleteCategory,
  onSaveSubscription,
  onRefreshSubscription,
  onDeleteSubscription,
  onImportIcsFile,
}: CategoryEditorDialogProps): JSX.Element {
  const editingCategory = draft?.editingCategory ?? null;
  const editingSubscription = draft?.editingSubscription ?? null;
  const isEditing = Boolean(editingCategory || editingSubscription);

  const [tab, setTab] = useState<CalendarManageTab>('local');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState<string>(CALENDAR_COLOR_PALETTE[2]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingCategory) {
      setTab('local');
      setName(editingCategory.name);
      setUrl('');
      setColor(editingCategory.color);
    } else if (editingSubscription) {
      setTab('subscribe');
      setName(editingSubscription.name);
      setUrl(editingSubscription.url);
      setColor(editingSubscription.color);
    } else {
      setTab(draft?.initialTab ?? 'local');
      setName('');
      setUrl('');
      setColor(CALENDAR_COLOR_PALETTE[Math.floor(Math.random() * CALENDAR_COLOR_PALETTE.length)]!);
    }
  }, [open, draft, editingCategory, editingSubscription]);

  const handleSubmitLocal = async () => {
    if (!name.trim()) {
      setError('请输入日历名称');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSaveCategory({
        id: editingCategory?.id,
        name: name.trim(),
        color,
        visible: editingCategory?.visible ?? true,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存日历失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitSubscribe = async () => {
    const isBuiltinHoliday = editingSubscription?.kind === 'cn-holiday';
    if (!isBuiltinHoliday && !url.trim()) {
      setError('请输入 https:// 或 webcal:// 日历订阅链接');
      return;
    }
    const finalName = name.trim() || (isBuiltinHoliday ? '中国法定节假日与调休' : '外部订阅日历');
    setError(null);
    setBusy(true);
    try {
      await onSaveSubscription({
        id: editingSubscription?.id,
        name: finalName,
        url: isBuiltinHoliday ? editingSubscription.url : url.trim(),
        color,
        visible: editingSubscription?.visible ?? true,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '拉取订阅日历失败，请检查链接是否可访问');
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await onImportIcsFile({
        name: name.trim() || undefined,
        color,
      });
      if (!res.canceled) {
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入 .ics 文件失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setError(null);
    setBusy(true);
    try {
      if (editingCategory && !editingCategory.isBuiltin) {
        await onDeleteCategory(editingCategory.id);
        onOpenChange(false);
      } else if (editingSubscription && !editingSubscription.isBuiltin) {
        await onDeleteSubscription(editingSubscription.id);
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const dialogTitle = editingCategory
    ? '编辑本地日历'
    : editingSubscription
      ? '管理订阅日历'
      : '添加日历';

  const dialogDesc =
    tab === 'subscribe'
      ? '订阅外部 .ics / webcal:// 日历（支持 Apple 日历、校历、赛事安排），自动只读同步。'
      : tab === 'import'
        ? '从本机导入 .ics 文件生成独立本地日历，导入后的日程可自由编辑。'
        : '新建本地日程分类（如比赛、社团、面试），新建日程时可选归属并在图层中独立显隐或删除。';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={dialogTitle}
      description={dialogDesc}
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
          {!isEditing && (
            <SegmentedControl
              value={tab}
              onValueChange={(v) => {
                setTab(v as CalendarManageTab);
                setError(null);
              }}
              items={[
                { value: 'local', label: '本地日历' },
                { value: 'subscribe', label: '订阅 URL' },
                { value: 'import', label: '导入 .ics' },
              ]}
            />
          )}

          {tab === 'subscribe' && editingSubscription?.kind !== 'cn-holiday' && (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>订阅地址（https:// 或 webcal://）*</span>
                <Input
                  variant="fill"
                  value={url}
                  onValueChange={setUrl}
                  placeholder="https://.../*.ics 或 webcal://..."
                />
              </label>

              {!editingSubscription && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>常用公开订阅快捷填入</span>
                  <div className={styles.inlineRow}>
                    {PRESET_SUBSCRIPTIONS.map((preset) => (
                      <Button
                        key={preset.url}
                        variant="glass"
                        size="small"
                        icon={<Globe size={12} />}
                        onClick={() => {
                          setName(preset.name);
                          setUrl(preset.url);
                          setColor(preset.color);
                          setError(null);
                        }}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {editingSubscription?.kind === 'cn-holiday' && (
            <Message tone="info">
              全员默认订阅的中国法定节假日与调休源，首次进入自动拉取并持久化到本地，之后每 7 天自动同步更新；放假日自动标「休」并跳过上课提醒，补班日标「班」。
            </Message>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {tab === 'import' ? '导入后日历名称（留空自动读取文件）' : '日历名称 *'}
            </span>
            <Input
              variant="fill"
              value={name}
              onValueChange={setName}
              placeholder={
                tab === 'subscribe'
                  ? '例如：中国传统节日与节气 / 学校校历'
                  : tab === 'import'
                    ? '留空则使用 .ics 内部日历名'
                    : '例如：竞赛项目 / 社团活动 / 面试安排'
              }
            />
          </label>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>日历色标</span>
            <ColorSwatchPicker
              colors={CALENDAR_COLOR_PALETTE}
              value={color}
              onValueChange={setColor}
              aria-label="选择日历色标"
            />
          </div>

          {editingSubscription?.lastError && (
            <Message tone="info">上次同步提示：{editingSubscription.lastError}</Message>
          )}
          {error && <Message tone="error">{error}</Message>}
        </div>

        <div className={styles.dialogFooter}>
          <div>
            {editingCategory && !editingCategory.isBuiltin && (
              <Button
                variant="glass"
                destructive
                size="small"
                icon={<Trash2 size={13} />}
                loading={busy}
                onClick={() => void handleDelete()}
              >
                删除日历
              </Button>
            )}
            {editingSubscription && !editingSubscription.isBuiltin && (
              <Button
                variant="glass"
                destructive
                size="small"
                icon={<Trash2 size={13} />}
                loading={busy}
                onClick={() => void handleDelete()}
              >
                退订删除
              </Button>
            )}
            {editingSubscription?.isBuiltin && (
              <Button
                variant="glass"
                size="small"
                icon={<RefreshCw size={13} />}
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onRefreshSubscription(editingSubscription.id);
                    onOpenChange(false);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : '同步失败');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                立即同步
              </Button>
            )}
          </div>

          <div className={styles.dialogFooterRight}>
            <Button variant="glass" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            {tab === 'local' && (
              <Button
                variant="filled"
                loading={busy}
                disabled={!name.trim()}
                onClick={() => void handleSubmitLocal()}
              >
                {editingCategory ? '保存修改' : '创建日历'}
              </Button>
            )}
            {tab === 'subscribe' && (
              <Button
                variant="filled"
                icon={<Download size={14} />}
                loading={busy}
                disabled={
                  editingSubscription?.kind === 'cn-holiday'
                    ? !name.trim()
                    : !url.trim()
                }
                onClick={() => void handleSubmitSubscribe()}
              >
                {editingSubscription ? '保存设置' : '订阅并同步'}
              </Button>
            )}
            {tab === 'import' && (
              <Button
                variant="filled"
                icon={<Upload size={14} />}
                loading={busy}
                onClick={() => void handleImportFile()}
              >
                选择 .ics 文件并导入
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── 3. 单日全部事项详情弹窗（月视图点开更多 / 课程胶囊） ───────────────────

interface DayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateStr: string;
  weekLabel?: string;
  courses: ExpandedCourseOccurrence[];
  events: CalendarEvent[];
  tasks: CalendarTask[];
  categoryColorMap: Map<string, string>;
  onEditCourse: (course: ScheduleCourseWithMeetings) => void;
  onEditEvent: (ev: CalendarEvent) => void;
  onEditTask: (task: CalendarTask) => void;
  onToggleTask: (taskId: string, completed: boolean) => void;
  onQuickCreate: (kind: 'event' | 'task', dateStr: string) => void;
}

export function DayDetailDialog({
  open,
  onOpenChange,
  dateStr,
  weekLabel,
  courses,
  events,
  tasks,
  categoryColorMap,
  onEditCourse,
  onEditEvent,
  onEditTask,
  onToggleTask,
  onQuickCreate,
}: DayDetailDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="regular"
      title={`${dateStr}${weekLabel ? ` · ${weekLabel}` : ''}`}
      description={`共 ${courses.length} 节课程 · ${events.length} 条日程 · ${tasks.length} 项任务`}
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
          {courses.length > 0 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>课程安排 ({courses.length})</span>
              <div className={styles.previewList} style={{ maxHeight: 'none' }}>
                {courses.map((item) => (
                  <div
                    key={`${item.meeting.id}-${item.dateStr}`}
                    className={styles.courseDirItem}
                    onClick={() => {
                      onOpenChange(false);
                      onEditCourse(item.course);
                    }}
                  >
                    <div className={styles.previewItemLeft}>
                      <span
                        className={styles.colorDot}
                        style={{ backgroundColor: item.course.color }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className={styles.previewItemTitle}>{item.course.name}</div>
                        <div className={styles.previewItemSub}>
                          <Clock3 size={11} style={{ verticalAlign: -1 }} /> {item.startTime}–
                          {item.endTime}（第 {item.meeting.startSection}-{item.meeting.endSection} 节）
                          {item.meeting.location ? ` · ${item.meeting.location}` : ''}
                        </div>
                      </div>
                    </div>
                    <Tag tone="info">课程</Tag>
                  </div>
                ))}
              </div>
            </div>
          )}

          {events.length > 0 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>日程 ({events.length})</span>
              <div className={styles.previewList} style={{ maxHeight: 'none' }}>
                {events.map((ev) => {
                  const color = categoryColorMap.get(ev.calendarId) ?? '#2563EB';
                  return (
                    <div
                      key={ev.id}
                      className={styles.courseDirItem}
                      onClick={() => {
                        onOpenChange(false);
                        onEditEvent(ev);
                      }}
                    >
                      <div className={styles.previewItemLeft}>
                        <span className={styles.colorDot} style={{ backgroundColor: color }} />
                        <div style={{ minWidth: 0 }}>
                          <div className={styles.previewItemTitle}>{ev.title}</div>
                          <div className={styles.previewItemSub}>
                            {ev.allDay ? '全天' : `${ev.startTime}–${ev.endTime}`}
                            {ev.location ? (
                              <>
                                {' '}
                                · <MapPin size={11} style={{ verticalAlign: -1 }} /> {ev.location}
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <Tag tone="neutral">日程</Tag>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tasks.length > 0 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>任务 ({tasks.length})</span>
              <div className={styles.previewList} style={{ maxHeight: 'none' }}>
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={styles.courseDirItem}
                    onClick={() => {
                      onOpenChange(false);
                      onEditTask(task);
                    }}
                  >
                    <div className={styles.previewItemLeft}>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={task.completed}
                          onCheckedChange={(checked) => onToggleTask(task.id, checked)}
                        />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div
                          className={styles.previewItemTitle}
                          style={
                            task.completed
                              ? { textDecoration: 'line-through', opacity: 0.55 }
                              : undefined
                          }
                        >
                          {task.title}
                        </div>
                        <div className={styles.previewItemSub}>
                          {task.dueTime ? `截止 ${task.dueTime}` : '全天待办'}
                        </div>
                      </div>
                    </div>
                    <Tag tone={task.priority === 'high' ? 'warning' : 'success'}>
                      {task.priority === 'high' ? '高优先' : '任务'}
                    </Tag>
                  </div>
                ))}
              </div>
            </div>
          )}

          {courses.length === 0 && events.length === 0 && tasks.length === 0 && (
            <Message tone="info">
              <CalendarDays size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              这一天暂时没有安排，可以在下方快捷新建日程或任务。
            </Message>
          )}
        </div>

        <div className={styles.dialogFooter}>
          <div className={styles.dialogFooterRight}>
            <Button
              variant="glass"
              size="small"
              icon={<Plus size={13} />}
              onClick={() => {
                onOpenChange(false);
                onQuickCreate('task', dateStr);
              }}
            >
              添加任务
            </Button>
            <Button
              variant="filled"
              size="small"
              icon={<Plus size={13} />}
              onClick={() => {
                onOpenChange(false);
                onQuickCreate('event', dateStr);
              }}
            >
              新建日程
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
