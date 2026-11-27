/**
 * Orbit 统一「日程课表」工作台（左主画布 + 右侧上下双栏联动布局）：
 * - 左/中主画布：
 *   - 默认「周」视图基于 `@lec-space/liquidglass` 官方 `<ScheduleCalendar showSidebar={false} />`，
 *     将西南石油大学课程、个人/工作室日程、待办任务与节假日融于同一 7 天时间轴画布（同时支持月/日视图）；
 *   - 「节次」模式保留 WakeUp 1–12 节离散作息周视图与本周日程提示条，并依然与右侧联动面板无缝共存；
 * - 右侧可折叠联动双栏（ScheduleRightRail）：
 *   - 右上：官方 `<Calendar />` 迷你月历，点选任意日期即联动主画布日期与课表教学周；
 *   - 右下：三合一联动面板（当日议程 / 全部待办 / 搜索与图层筛选），支持直接勾选与回车速记待办。
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  Button,
  CloseButton,
  Dialog,
  Empty,
  Menu,
  ScheduleCalendar,
  SegmentedControl,
  Slider,
  Tag,
  type MenuEntry,
  type ScheduleCalendarView,
  type ScheduleEvent,
  type ScheduleSlotSelection,
} from '@lec-space/liquidglass';
import { layoutOverlappingIntervals } from '@shared/overlapLayout';
import {
  Bell,
  BellOff,
  BookOpen,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  EyeOff,
  FolderKanban,
  FolderPlus,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  SlidersHorizontal,
  Sun,
  Trash2,
} from 'lucide-react';
import {
  buildMonthGrid,
  eventCoversDate,
  expandCoursesForDate,
  type CalendarCategory,
  type CalendarEvent,
  type CalendarSubscription,
  type CalendarTask,
} from '@shared/calendar';
import {
  addMinutesToTime,
  computeScheduleNowLineTop,
  computeWeekFromStartDate,
  ensureSlotsUpTo,
  formatLocalDate,
  getWeekDayColumns,
  getWeekdayName,
  parseLocalDate,
  type ScheduleCourseWithMeetings,
  type ScheduleMeeting,
} from '@shared/schedule';
import { orbitServerApi } from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { useCalendarStore } from '@/stores/useCalendarStore';
import { useOrbitStore } from '@/stores/useOrbitStore';
import { useScheduleStore } from '@/stores/useScheduleStore';
import {
  CategoryEditorDialog,
  EventTaskEditorDialog,
  type CategoryEditorDraft,
  type ItemEditorDraft,
} from './CalendarItemDialogs';
import { CourseEditorDialog } from './CourseEditorDialog';
import {
  CourseListDialog,
  ScheduleListDialog,
  ScheduleSettingsDialog,
  ShareScheduleDialog,
  TimetableEditorDialog,
} from './ScheduleManageDialogs';
import { ScheduleRightRail } from './ScheduleRightRail';
import { SwpuImportDialog } from './SwpuImportDialog';
import styles from './Schedule.module.css';

const SLOT_ROW_HEIGHT = 56;

interface LocalScheduleDayBadge {
  label: string;
  tone?: 'holiday' | 'workday' | 'neutral';
}

interface RenderMeetingCard {
  course: ScheduleCourseWithMeetings;
  meeting: ScheduleMeeting;
}

export function SchedulePage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const config = useOrbitStore((s) => s.config);
  const studioMembers = useOrbitStore((s) => s.studioMembers);
  const refreshStudioMembers = useOrbitStore((s) => s.refreshStudioMembers);
  const updateConfig = useOrbitStore((s) => s.updateConfig);
  const pushOverlay = useOrbitStore((s) => s.pushOverlay);
  const popOverlay = useOrbitStore((s) => s.popOverlay);

  // ── 课表 Store ──
  const scheduleLoaded = useScheduleStore((s) => s.loaded);
  const scheduleLoadedSubject = useScheduleStore((s) => s.loadedSubject);
  const schedules = useScheduleStore((s) => s.schedules);
  const timetables = useScheduleStore((s) => s.timetables);
  const activeDetail = useScheduleStore((s) => s.activeDetail);
  const viewingWeek = useScheduleStore((s) => s.viewingWeek);
  const importSuccessNotice = useScheduleStore((s) => s.importSuccessNotice);
  const loadSchedules = useScheduleStore((s) => s.loadAll);
  const setViewingWeek = useScheduleStore((s) => s.setViewingWeek);
  const jumpToCurrentWeek = useScheduleStore((s) => s.jumpToCurrentWeek);
  const dismissImportSuccessNotice = useScheduleStore((s) => s.dismissImportSuccessNotice);
  const selectSchedule = useScheduleStore((s) => s.selectSchedule);
  const createSchedule = useScheduleStore((s) => s.createSchedule);
  const updateSchedule = useScheduleStore((s) => s.updateSchedule);
  const deleteSchedule = useScheduleStore((s) => s.deleteSchedule);
  const clearCourses = useScheduleStore((s) => s.clearCourses);
  const upsertCourse = useScheduleStore((s) => s.upsertCourse);
  const deleteCourses = useScheduleStore((s) => s.deleteCourses);
  const saveTimetable = useScheduleStore((s) => s.saveTimetable);

  // ── 统一日历（个人日程 + 工作室共享日程 + 任务 + 图层 + 订阅日历）Store ──
  const calendarLoaded = useCalendarStore((s) => s.loaded);
  const calendarLoadedSubject = useCalendarStore((s) => s.loadedSubject);
  const categories = useCalendarStore((s) => s.categories);
  const localEvents = useCalendarStore((s) => s.events);
  const studioEvents = useCalendarStore((s) => s.studioEvents);
  const studioSyncing = useCalendarStore((s) => s.studioSyncing);
  const calTasks = useCalendarStore((s) => s.tasks);
  const subscriptions = useCalendarStore((s) => s.subscriptions);
  const subscriptionItems = useCalendarStore((s) => s.subscriptionItems);
  const syncingSubscriptionIds = useCalendarStore((s) => s.syncingSubscriptionIds);
  const viewMode = useCalendarStore((s) => s.viewMode);
  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const rightRailOpen = useCalendarStore((s) => s.sidebarOpen);
  const searchQuery = useCalendarStore((s) => s.searchQuery);
  const showCoursesLayer = useCalendarStore((s) => s.showCoursesLayer);
  const showTasksLayer = useCalendarStore((s) => s.showTasksLayer);
  const loadCalendar = useCalendarStore((s) => s.loadSnapshot);
  const syncStudioEvents = useCalendarStore((s) => s.syncStudioEvents);
  const setViewMode = useCalendarStore((s) => s.setViewMode);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const stepSelectedDate = useCalendarStore((s) => s.stepSelectedDate);
  const stepSelectedMonth = useCalendarStore((s) => s.stepSelectedMonth);
  const jumpToToday = useCalendarStore((s) => s.jumpToToday);
  const toggleRightRail = useCalendarStore((s) => s.toggleSidebar);
  const setSearchQuery = useCalendarStore((s) => s.setSearchQuery);
  const setShowCoursesLayer = useCalendarStore((s) => s.setShowCoursesLayer);
  const setShowTasksLayer = useCalendarStore((s) => s.setShowTasksLayer);
  const saveCategory = useCalendarStore((s) => s.saveCategory);
  const setCategoryVisible = useCalendarStore((s) => s.setCategoryVisible);
  const deleteCategory = useCalendarStore((s) => s.deleteCategory);
  const upsertEvent = useCalendarStore((s) => s.upsertEvent);
  const rsvpStudioEvent = useCalendarStore((s) => s.rsvpStudioEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const upsertTask = useCalendarStore((s) => s.upsertTask);
  const toggleTask = useCalendarStore((s) => s.toggleTask);
  const deleteTask = useCalendarStore((s) => s.deleteTask);
  const pendingCreateDraft = useCalendarStore((s) => s.pendingCreateDraft);
  const consumePendingCreateDraft = useCalendarStore((s) => s.consumePendingCreateDraft);
  const saveSubscription = useCalendarStore((s) => s.saveSubscription);
  const refreshSubscription = useCalendarStore((s) => s.refreshSubscription);
  const setSubscriptionVisible = useCalendarStore((s) => s.setSubscriptionVisible);
  const deleteSubscription = useCalendarStore((s) => s.deleteSubscription);
  const importIcsFile = useCalendarStore((s) => s.importIcsFile);

  // 记住组件库 ScheduleCalendar 的子视图（week / month / day），默认周视图以便课表与日程直接同框
  const [calSubView, setCalSubView] = useState<ScheduleCalendarView>(() =>
    viewMode === 'month' || viewMode === 'day' ? viewMode : 'week',
  );
  const workspaceMode: 'calendar' | 'schedule' =
    viewMode === 'schedule' ? 'schedule' : 'calendar';

  // 弹窗态
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [courseEditorOpen, setCourseEditorOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState<ScheduleCourseWithMeetings | null>(null);
  const [initialSlot, setInitialSlot] = useState<{ dayOfWeek: number; section: number } | null>(null);
  const [courseListOpen, setCourseListOpen] = useState(false);
  const [timetableDialogOpen, setTimetableDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [scheduleListOpen, setScheduleListOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [itemDraft, setItemDraft] = useState<ItemEditorDraft | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState<CategoryEditorDraft | null>(null);

  useEffect(() => {
    void Promise.all([loadSchedules(), loadCalendar()]);
  }, [loadSchedules, loadCalendar]);

  useEffect(() => {
    if (auth.authenticated && studioMembers.length === 0) {
      void refreshStudioMembers();
    }
  }, [auth.authenticated, studioMembers.length, refreshStudioMembers]);

  // 响应从「成员名片 → 查看日程 / 约 Ta 日程」跳入时的预填日程草稿
  useEffect(() => {
    if (!pendingCreateDraft) return;
    const draft = consumePendingCreateDraft();
    if (!draft) return;
    setSelectedDate(draft.date);
    setItemDraft({
      kind: 'event',
      defaultDate: draft.date,
      defaultStartTime: draft.startTime ?? '14:00',
      defaultEndTime: draft.endTime ?? '15:00',
      defaultCalendarId: draft.calendarId,
      defaultAttendeeUserIds: draft.attendeeUserIds,
    });
    setItemDialogOpen(true);
  }, [pendingCreateDraft, consumePendingCreateDraft, setSelectedDate]);

  // 自动防抖上报当前成员的公开课表规则与近期脱敏个人忙碌时段，供他人创建日程时在右侧实时查看空余时间：
  // 1. 仅当课表与日历 Store 均已成功加载且归属当前登录账号 subject 时才允许上报，严防切号串号或空快照覆盖；
  // 2. 跳过已隐藏日历分类（visible === false），个人日程默认脱敏为「忙碌」仅共享时段不泄露私有标题与地点；
  // 3. 按 [today - 7d, today + 90d] 近期滑动窗口过滤再裁剪，并对 courses/meetings/slots 对齐后端上限防 400。
  useEffect(() => {
    const currentSubject = auth.profile?.subject ?? null;
    if (
      !auth.authenticated ||
      !currentSubject ||
      !scheduleLoaded ||
      !calendarLoaded ||
      scheduleLoadedSubject !== currentSubject ||
      calendarLoadedSubject !== currentSubject
    ) {
      return;
    }
    const catById = new Map(categories.map((c) => [c.id, c]));
    const timer = window.setTimeout(() => {
      const schedulePayload = activeDetail
        ? {
            scheduleName: activeDetail.schedule.name.slice(0, 100),
            startDate: activeDetail.schedule.startDate,
            totalWeeks: Math.max(1, Math.min(30, activeDetail.schedule.totalWeeks)),
            weekStartDay: activeDetail.schedule.weekStartDay,
            slots: activeDetail.timetable.slots.slice(0, 30).map((s) => ({
              section: s.section,
              startTime: s.startTime,
              endTime: s.endTime,
            })),
            courses: activeDetail.courses.slice(0, 120).map((c) => ({
              id: c.id.slice(0, 100),
              name: c.name.slice(0, 120),
              color: (c.color || '#6366F1').slice(0, 32),
              meetings: c.meetings.slice(0, 30).map((m) => ({
                id: m.id.slice(0, 100),
                dayOfWeek: m.dayOfWeek,
                startSection: Math.max(1, Math.min(24, m.startSection)),
                endSection: Math.max(1, Math.min(24, m.endSection)),
                weeks: m.weeks.filter((w) => w >= 1 && w <= 30).slice(0, 30),
                location: (m.location || '').slice(0, 120),
                teacher: (m.teacher || '').slice(0, 80),
              })),
            })),
          }
        : null;

      const now = new Date();
      const winStart = formatLocalDate(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7),
      );
      const winEnd = formatLocalDate(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 90),
      );

      const personalEvents = localEvents
        .filter((ev) => {
          const cat = catById.get(ev.calendarId);
          // 跳过用户已隐藏的私有日历分类，且仅上报近期滑动窗口内活跃日程
          if (cat && !cat.visible) return false;
          return ev.endDate >= winStart && ev.startDate <= winEnd;
        })
        .slice(0, 400)
        .map((ev) => {
          const cat = catById.get(ev.calendarId);
          return {
            id: ev.id.slice(0, 100),
            // 个人私有日程默认仅共享忙碌时段，避免无提示明文上报私人标题与地点
            title: '忙碌',
            location: '',
            allDay: ev.allDay,
            startDate: ev.startDate,
            endDate: ev.endDate,
            startTime: ev.startTime,
            endTime: ev.endTime,
            color: (cat?.color ?? '#2563EB').slice(0, 32),
            calendarName: '个人日程',
          };
        });

      void orbitServerApi
        .upsertFreeBusySnapshot({ schedule: schedulePayload, personalEvents })
        .catch(() => undefined);
    }, 1400);

    return () => window.clearTimeout(timer);
  }, [
    auth.authenticated,
    auth.profile?.subject,
    scheduleLoaded,
    scheduleLoadedSubject,
    calendarLoaded,
    calendarLoadedSubject,
    activeDetail,
    localEvents,
    categories,
  ]);

  const anyModalOpen =
    quickPanelOpen ||
    importDialogOpen ||
    courseEditorOpen ||
    courseListOpen ||
    timetableDialogOpen ||
    settingsDialogOpen ||
    scheduleListOpen ||
    shareDialogOpen ||
    itemDialogOpen ||
    categoryDialogOpen ||
    Boolean(importSuccessNotice?.open);

  useEffect(() => {
    if (!anyModalOpen) return;
    pushOverlay();
    return () => popOverlay();
  }, [anyModalOpen, pushOverlay, popOverlay]);

  useEffect(() => {
    if (!quickPanelOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQuickPanelOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [quickPanelOpen]);

  const [nowMinutes, setNowMinutes] = useState<number>(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNowMinutes(d.getHours() * 60 + d.getMinutes());
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const now = useMemo(() => new Date(), [selectedDate, viewingWeek, nowMinutes]);
  const todayStr = formatLocalDate(now);

  // 当前焦点日期对应的教学周
  const focusTeachWeek = useMemo(() => {
    if (!activeDetail) return null;
    const dateObj = parseLocalDate(selectedDate);
    if (Number.isNaN(dateObj.getTime())) return null;
    const w = computeWeekFromStartDate(
      activeDetail.schedule.startDate,
      dateObj,
      activeDetail.schedule.weekStartDay,
    );
    return w >= 1 && w <= activeDetail.schedule.totalWeeks ? w : null;
  }, [activeDetail, selectedDate]);

  // 选中日期变化时：同步更新选中日，且若处于学期内同步更新节次课表周次，保证两视图无缝联动
  const handleSelectDateSynced = (dateStr: string) => {
    setSelectedDate(dateStr);
    if (!activeDetail) return;
    const parsed = parseLocalDate(dateStr);
    if (Number.isNaN(parsed.getTime())) return;
    const w = computeWeekFromStartDate(
      activeDetail.schedule.startDate,
      parsed,
      activeDetail.schedule.weekStartDay,
    );
    if (w >= 1 && w <= activeDetail.schedule.totalWeeks) {
      setViewingWeek(w);
    }
  };

  const handleJumpTodaySynced = () => {
    jumpToToday();
    jumpToCurrentWeek();
  };

  const handleStepPeriod = (dir: -1 | 1) => {
    if (workspaceMode === 'schedule') {
      if (!activeDetail) return;
      const nextWeek = Math.max(1, Math.min(activeDetail.schedule.totalWeeks, viewingWeek + dir));
      if (nextWeek === viewingWeek) return;
      setViewingWeek(nextWeek);
      stepSelectedDate(dir * 7);
      return;
    }

    const base = parseLocalDate(selectedDate);
    if (Number.isNaN(base.getTime())) return;
    if (viewMode === 'day') {
      base.setDate(base.getDate() + dir);
      handleSelectDateSynced(formatLocalDate(base));
    } else if (viewMode === 'week') {
      base.setDate(base.getDate() + dir * 7);
      handleSelectDateSynced(formatLocalDate(base));
    } else {
      stepSelectedMonth(dir);
      const nextDateStr = useCalendarStore.getState().selectedDate;
      handleSelectDateSynced(nextDateStr);
    }
  };

  // 合并本地私有日程与工作室全员共享云端日程
  const calEvents = useMemo(
    () => [...localEvents, ...studioEvents],
    [localEvents, studioEvents],
  );

  // 建立实体索引，供点击事件玻璃浮层精确反查
  const eventById = useMemo(() => new Map(calEvents.map((e) => [e.id, e])), [calEvents]);
  const taskById = useMemo(() => new Map(calTasks.map((t) => [t.id, t])), [calTasks]);
  const courseById = useMemo(
    () => new Map((activeDetail?.courses ?? []).map((c) => [c.id, c])),
    [activeDetail?.courses],
  );
  const categoryColorMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c.color])),
    [categories],
  );
  const visibleCatSet = useMemo(
    () => new Set(categories.filter((c) => c.visible).map((c) => c.id)),
    [categories],
  );
  const subscriptionById = useMemo(
    () => new Map(subscriptions.map((s) => [s.id, s])),
    [subscriptions],
  );
  const subscriptionItemById = useMemo(
    () => new Map(subscriptionItems.map((i) => [i.id, i])),
    [subscriptionItems],
  );
  // 从已开启的订阅日历中提取法定休假日与调休补班日，并同步生成日/周/月表头「休 / 班」角标映射
  const { holidayOffDateSet, holidayWorkDateSet, dayBadges } = useMemo(() => {
    const offSet = new Set<string>(activeDetail?.schedule.holidays ?? []);
    const workSet = new Set<string>();
    const badges: Record<string, LocalScheduleDayBadge> = {};
    for (const d of activeDetail?.schedule.holidays ?? []) {
      badges[d] = { label: '休', tone: 'holiday' };
    }
    for (const item of subscriptionItems) {
      const sub = subscriptionById.get(item.subscriptionId);
      if (!sub || !sub.visible) continue;
      if (item.badge === 'off') {
        offSet.add(item.startDate);
        badges[item.startDate] = { label: '休', tone: 'holiday' };
      } else if (item.badge === 'work') {
        workSet.add(item.startDate);
        if (!offSet.has(item.startDate)) {
          badges[item.startDate] = { label: '班', tone: 'workday' };
        }
      }
    }
    return { holidayOffDateSet: offSet, holidayWorkDateSet: workSet, dayBadges: badges };
  }, [activeDetail?.schedule.holidays, subscriptionItems, subscriptionById]);

  // 将「本地日程 + 任务 + 当前月份可视区课程 + 订阅日历（含默认法定节假日）+ 手动停课日」统一映射并按图层/搜索过滤
  const unifiedEvents = useMemo<ScheduleEvent[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchQuery = (...parts: Array<string | undefined>) =>
      !q || parts.some((p) => (p ?? '').toLowerCase().includes(q));

    const list: ScheduleEvent[] = [];

    // 1. 本地日程 + 工作室共享日程
    const mySubject = auth.profile?.subject;
    for (const ev of calEvents) {
      if (!visibleCatSet.has(ev.calendarId)) continue;
      if (!matchQuery(ev.title, ev.location, ev.description)) continue;
      const myStatus =
        ev.source === 'studio' && mySubject
          ? ev.attendeeResponses?.[mySubject] ??
            (ev.creatorId === mySubject ? 'accepted' : 'tentative')
          : 'accepted';
      list.push({
        id: `evt:${ev.id}`,
        title: ev.title,
        color: categoryColorMap.get(ev.calendarId) ?? '#2563EB',
        allDay: ev.allDay,
        start: ev.allDay ? ev.startDate : `${ev.startDate}T${ev.startTime}`,
        end: ev.allDay ? ev.endDate : `${ev.endDate}T${ev.endTime}`,
        location: ev.location || undefined,
        description: ev.description || undefined,
        status: myStatus,
      });
    }

    // 2. 带截止日期的待办任务
    if (showTasksLayer) {
      for (const task of calTasks) {
        if (!task.dueDate) continue;
        if (!matchQuery(task.title, task.description)) continue;
        const hasTime = Boolean(task.dueTime);
        const endTime = hasTime ? addMinutesToTime(task.dueTime!, 30) : undefined;
        list.push({
          id: `tsk:${task.id}`,
          title: `${task.completed ? '✓' : '☐'} ${task.title}`,
          color: '#10B981',
          allDay: !hasTime,
          start: hasTime ? `${task.dueDate}T${task.dueTime}` : task.dueDate,
          end: hasTime && endTime ? `${task.dueDate}T${endTime}` : task.dueDate,
          description: task.description || undefined,
          status: task.completed ? 'declined' : task.priority === 'high' ? 'tentative' : 'accepted',
        });
      }
    }

    // 3. 当前浏览月份（42 格）内的课表展开（自动跳过法定与手动休假日）
    if (activeDetail && showCoursesLayer) {
      const focusObj = parseLocalDate(selectedDate);
      const year = Number.isNaN(focusObj.getTime()) ? now.getFullYear() : focusObj.getFullYear();
      const month = Number.isNaN(focusObj.getTime()) ? now.getMonth() + 1 : focusObj.getMonth() + 1;
      const gridCells = buildMonthGrid(year, month, activeDetail.schedule.weekStartDay, now);
      for (const cell of gridCells) {
        const occs = expandCoursesForDate(activeDetail, cell.dateStr, holidayOffDateSet);
        for (const occ of occs) {
          if (!matchQuery(occ.course.name, occ.meeting.location, occ.meeting.teacher)) continue;
          list.push({
            id: `crs:${occ.course.id}:${occ.meeting.id}:${cell.dateStr}`,
            title: occ.course.name,
            color: occ.course.color,
            allDay: false,
            start: `${cell.dateStr}T${occ.startTime}`,
            end: `${cell.dateStr}T${occ.endTime}`,
            location: occ.meeting.location || undefined,
            attendees: occ.meeting.teacher ? [occ.meeting.teacher] : undefined,
            description: `第 ${occ.week} 周 · 第 ${occ.meeting.startSection}-${occ.meeting.endSection} 节（${occ.meeting.weeksText}）`,
            status: 'accepted',
          });
        }
      }
    }

    // 4. 订阅日历（包含默认的「中国法定节假日与调休」以及用户订阅的外部 .ics 日历）
    const coveredHolidayDates = new Set<string>();
    for (const item of subscriptionItems) {
      const sub = subscriptionById.get(item.subscriptionId);
      if (!sub || !sub.visible) continue;
      if (!matchQuery(item.title, item.location, item.description, sub.name)) continue;
      if (item.badge === 'off') coveredHolidayDates.add(item.startDate);
      const color = item.badge === 'work' ? '#EF4444' : sub.color;
      list.push({
        id: `sub:${item.id}`,
        title: item.title,
        color,
        allDay: item.allDay,
        start: item.allDay ? item.startDate : `${item.startDate}T${item.startTime}`,
        end: item.allDay ? item.endDate : `${item.endDate}T${item.endTime}`,
        location: item.location || undefined,
        description: item.description || sub.name,
        status: 'accepted',
      });
    }

    // 5. 课表设置中额外手动追加的停课/放假日（避免与法定节假日重复）
    if (activeDetail) {
      for (const holidayDate of activeDetail.schedule.holidays) {
        if (coveredHolidayDates.has(holidayDate)) continue;
        if (!matchQuery('节假日', '休', holidayDate)) continue;
        list.push({
          id: `hol:${holidayDate}`,
          title: '自定义停课 · 休',
          color: '#F59E0B',
          allDay: true,
          start: holidayDate,
          end: holidayDate,
          status: 'accepted',
        });
      }
    }

    return list;
  }, [
    calEvents,
    calTasks,
    activeDetail,
    selectedDate,
    now,
    searchQuery,
    visibleCatSet,
    categoryColorMap,
    showTasksLayer,
    showCoursesLayer,
    subscriptionItems,
    subscriptionById,
    holidayOffDateSet,
    auth.profile?.subject,
  ]);

  // ── 节次课表模式数据 ──
  const currentActualWeek = useMemo(() => {
    if (!activeDetail) return 1;
    return computeWeekFromStartDate(
      activeDetail.schedule.startDate,
      now,
      activeDetail.schedule.weekStartDay,
    );
  }, [activeDetail, now]);

  const weekColumns = useMemo(() => {
    if (!activeDetail) return [];
    return getWeekDayColumns(
      activeDetail.schedule.startDate,
      viewingWeek,
      activeDetail.schedule.weekStartDay,
      now,
    );
  }, [activeDetail, viewingWeek, now]);

  const slots = useMemo(() => {
    if (!activeDetail) return [];
    return ensureSlotsUpTo(
      activeDetail.timetable.slots,
      activeDetail.schedule.maxSections,
      activeDetail.timetable.defaultDurationMinutes,
    );
  }, [activeDetail]);

  const meetingsByDay = useMemo(() => {
    const map = new Map<number, RenderMeetingCard[]>();
    if (!activeDetail) return map;
    for (const course of activeDetail.courses) {
      for (const meeting of course.meetings) {
        if (!meeting.weeks.includes(viewingWeek)) continue;
        const list = map.get(meeting.dayOfWeek) ?? [];
        list.push({ course, meeting });
        map.set(meeting.dayOfWeek, list);
      }
    }
    return map;
  }, [activeDetail, viewingWeek]);

  const holidaySet = useMemo(
    () => new Set(activeDetail?.schedule.holidays ?? []),
    [activeDetail?.schedule.holidays],
  );

  const isDarkTheme =
    config.theme === 'dark' ||
    (config.theme === 'system' &&
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false));

  // ── 交互处理 ──
  const openNewCourse = (slot?: { dayOfWeek: number; section: number }) => {
    if (!activeDetail) {
      void createSchedule({ name: '我的课表', setActive: true }).then(() => {
        setEditingCourse(null);
        setInitialSlot(slot ?? null);
        setCourseEditorOpen(true);
      });
      return;
    }
    setEditingCourse(null);
    setInitialSlot(slot ?? null);
    setCourseEditorOpen(true);
  };

  const openEditCourse = (course: ScheduleCourseWithMeetings) => {
    setEditingCourse(course);
    setInitialSlot(null);
    setCourseEditorOpen(true);
  };

  const openCreateItem = (
    kind: 'event' | 'task',
    dateStr = selectedDate,
    startTime?: string,
    endTime?: string,
    defaultCalendarId?: string,
  ) => {
    setItemDraft({
      kind,
      defaultDate: dateStr,
      defaultStartTime: startTime,
      defaultEndTime: endTime,
      defaultCalendarId,
    });
    setItemDialogOpen(true);
  };

  const openCategoryDialog = (draft?: CategoryEditorDraft) => {
    setCategoryDraft(draft ?? { initialTab: 'local' });
    setCategoryDialogOpen(true);
  };

  const handleDeleteCategoryQuick = async (cat: CalendarCategory) => {
    if (cat.isBuiltin) return;
    await deleteCategory(cat.id);
    notifyToast({
      tone: 'info',
      title: `已删除日历「${cat.name}」`,
      description: '该日历下原有日程已安全移入「个人日程」。',
    });
  };

  const handleRefreshSubscriptionQuick = async (subscriptionId: string) => {
    try {
      const res = await refreshSubscription(subscriptionId);
      notifyToast({
        tone: res.warning ? 'warning' : 'success',
        title: `已同步「${res.subscription.name}」（共 ${res.itemCount} 条）`,
        description: res.warning,
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '同步订阅日历失败',
        description: err instanceof Error ? err.message : '请检查网络后重试',
      });
    }
  };

  const handleDeleteSubscriptionQuick = async (sub: CalendarSubscription) => {
    if (sub.isBuiltin) return;
    await deleteSubscription(sub.id);
    notifyToast({ tone: 'info', title: `已退订「${sub.name}」` });
  };

  const canManageEvent = (ev: CalendarEvent): boolean => {
    if (ev.source !== 'studio') return true;
    if (auth.isAdmin) return true;
    return Boolean(auth.profile?.subject && ev.creatorId === auth.profile.subject);
  };

  const openEditEvent = (ev: CalendarEvent) => {
    if (!canManageEvent(ev)) {
      notifyToast({
        tone: 'info',
        title: '团队共享日程（只读）',
        description: `由「${ev.creatorName || '团队成员'}」发起，仅发起人或工作室队长可修改。`,
      });
      return;
    }
    setItemDraft({ kind: 'event', editingEvent: ev, defaultDate: ev.startDate });
    setItemDialogOpen(true);
  };

  const handleRefreshStudioQuick = async () => {
    try {
      await syncStudioEvents({ silent: false });
      notifyToast({
        tone: 'success',
        title: `已同步工作室共享日程（共 ${useCalendarStore.getState().studioEvents.length} 条）`,
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '同步工作室日程失败',
        description: err instanceof Error ? err.message : '请检查 Orbit 服务连接',
      });
    }
  };

  const openEditTask = (task: CalendarTask) => {
    setItemDraft({ kind: 'task', editingTask: task, defaultDate: task.dueDate ?? selectedDate });
    setItemDialogOpen(true);
  };

  const handleSlotClick = (slot: ScheduleSlotSelection) => {
    handleSelectDateSynced(slot.date);
    const startTime = slot.time;
    const endTime = startTime ? addMinutesToTime(startTime, 60) : undefined;
    openCreateItem('event', slot.date, startTime, endTime);
  };

  const handleQuickAddTask = async (title: string, dueDate: string | null) => {
    await upsertTask({
      title,
      dueDate,
      dueTime: null,
      priority: 'medium',
      reminderMinutes: null,
    });
    notifyToast({ tone: 'success', title: `已添加待办「${title}」` });
  };

  const handleToggleCompact = async () => {
    if (!activeDetail) return;
    await updateSchedule({
      id: activeDetail.schedule.id,
      compactMode: !activeDetail.schedule.compactMode,
    });
  };

  const handleToggleReminder = async () => {
    if (!activeDetail) return;
    const next = !activeDetail.schedule.reminderEnabled;
    await updateSchedule({ id: activeDetail.schedule.id, reminderEnabled: next });
    notifyToast({
      tone: 'info',
      title: next
        ? `已开启课前 ${activeDetail.schedule.reminderMinutes} 分钟提醒`
        : '已关闭当前课表上课提醒',
    });
  };

  const handleToggleTheme = () => {
    void updateConfig({ theme: isDarkTheme ? 'light' : 'dark' });
  };

  // 统一收拢顶栏「+ 新建」下拉菜单（减少按钮拥挤感，一键创建日程/任务/课程/导入西柚课表）
  const createMenuItems = useMemo<MenuEntry[]>(
    () => [
      {
        label: '新建日程',
        icon: <CalendarPlus size={14} />,
        onSelect: () => openCreateItem('event', selectedDate),
      },
      {
        label: '新建待办任务',
        icon: <CheckSquare size={14} />,
        onSelect: () => openCreateItem('task', selectedDate),
      },
      {
        label: '添加课程',
        icon: <BookOpen size={14} />,
        onSelect: () => openNewCourse(),
      },
      'separator',
      {
        label: '导入西柚课表',
        icon: <Download size={14} />,
        onSelect: () => setImportDialogOpen(true),
      },
      {
        label: '添加 / 订阅日历',
        icon: <FolderPlus size={14} />,
        onSelect: () => openCategoryDialog({ initialTab: 'subscribe' }),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedDate, activeDetail],
  );

  // 自定义 ScheduleCalendar 玻璃详情浮层：按 课程 / 日程 / 任务 提供原生操作
  const renderEventPopover = (
    ev: ScheduleEvent,
    { close }: { close: () => void },
  ): JSX.Element => {
    if (ev.id.startsWith('evt:')) {
      const real = eventById.get(ev.id.slice(4));
      const color = real ? (categoryColorMap.get(real.calendarId) ?? '#2563EB') : '#2563EB';
      const editable = real ? canManageEvent(real) : false;
      return (
        <div className={styles.popoverCard}>
          <div className={styles.popoverCardHead}>
            <span className={styles.colorDot} style={{ backgroundColor: color }} />
            <strong className={styles.popoverCardTitle}>{ev.title}</strong>
            <CloseButton size="small" variant="subtle" onClick={close} />
          </div>
          <div className={styles.popoverCardMeta}>
            <div>
              {real?.startDate}
              {real && real.endDate !== real.startDate ? ` 至 ${real.endDate}` : ''}
              {real?.allDay ? ' · 全天' : real ? ` · ${real.startTime}–${real.endTime}` : ''}
            </div>
            {real?.source === 'studio' && (
              <div>
                工作室共享日程 · 发起人：{real.creatorName || '团队成员'}
                {real.attendeeGrades?.length || real.attendeeUserIds?.length ? (
                  <>
                    {' · 参与范围：'}
                    {[
                      ...(real.attendeeGrades ?? []).map((g) => `${g}级`),
                      ...(real.attendeeUserIds?.length
                        ? [`${real.attendeeUserIds.length} 名指定成员`]
                        : []),
                    ].join('、')}
                  </>
                ) : (
                  ' · 全员'
                )}
              </div>
            )}
            {real?.location && <div>地点：{real.location}</div>}
            {real?.description && <div className={styles.popoverCardDesc}>{real.description}</div>}
          </div>
          {real?.source === 'studio' && auth.profile?.subject && (
            <div className={styles.popoverCardActions}>
              {(
                [
                  { value: 'accepted', label: '接受' },
                  { value: 'tentative', label: '待定' },
                  { value: 'declined', label: '谢绝' },
                ] as const
              ).map((opt) => {
                const curStatus =
                  real.attendeeResponses?.[auth.profile!.subject] ??
                  (real.creatorId === auth.profile!.subject ? 'accepted' : 'tentative');
                return (
                  <Button
                    key={opt.value}
                    variant={curStatus === opt.value ? 'filled' : 'glass'}
                    size="small"
                    onClick={async () => {
                      try {
                        await rsvpStudioEvent(real.id, opt.value);
                        notifyToast({ tone: 'success', title: `已更新参会状态为「${opt.label}」` });
                      } catch (err) {
                        notifyToast({
                          tone: 'error',
                          title: '更新参会状态失败',
                          description: err instanceof Error ? err.message : '请稍后重试',
                        });
                      }
                    }}
                  >
                    {opt.label}
                  </Button>
                );
              })}
            </div>
          )}
          {real && (
            <div className={styles.popoverCardActions}>
              {editable ? (
                <>
                  <Button
                    variant="glass"
                    size="small"
                    icon={<Pencil size={12} />}
                    onClick={() => {
                      close();
                      openEditEvent(real);
                    }}
                  >
                    编辑日程
                  </Button>
                  <Button
                    variant="glass"
                    size="small"
                    destructive
                    icon={<Trash2 size={12} />}
                    onClick={async () => {
                      close();
                      try {
                        await deleteEvent(real.id);
                      } catch (err) {
                        notifyToast({
                          tone: 'error',
                          title: '删除日程失败',
                          description: err instanceof Error ? err.message : '请稍后重试',
                        });
                      }
                    }}
                  >
                    删除
                  </Button>
                </>
              ) : (
                <span className={styles.hintText}>仅发起人或工作室队长可修改</span>
              )}
            </div>
          )}
        </div>
      );
    }

    if (ev.id.startsWith('tsk:')) {
      const real = taskById.get(ev.id.slice(4));
      return (
        <div className={styles.popoverCard}>
          <div className={styles.popoverCardHead}>
            <span className={styles.colorDot} style={{ backgroundColor: '#10B981' }} />
            <strong className={styles.popoverCardTitle}>{real?.title ?? ev.title}</strong>
            <CloseButton size="small" variant="subtle" onClick={close} />
          </div>
          <div className={styles.popoverCardMeta}>
            <div>
              截止：{real?.dueDate ?? '无日期'} {real?.dueTime ?? '全天'}
            </div>
            {real?.description && <div className={styles.popoverCardDesc}>{real.description}</div>}
          </div>
          {real && (
            <div className={styles.popoverCardActions}>
              <Button
                variant="filled"
                size="small"
                icon={<Check size={12} />}
                onClick={() => {
                  void toggleTask(real.id, !real.completed);
                  close();
                }}
              >
                {real.completed ? '标记未完成' : '标记完成'}
              </Button>
              <Button
                variant="glass"
                size="small"
                icon={<Pencil size={12} />}
                onClick={() => {
                  close();
                  openEditTask(real);
                }}
              >
                编辑
              </Button>
              <Button
                variant="glass"
                size="small"
                destructive
                icon={<Trash2 size={12} />}
                onClick={() => {
                  close();
                  void deleteTask(real.id);
                }}
              >
                删除
              </Button>
            </div>
          )}
        </div>
      );
    }

    if (ev.id.startsWith('crs:')) {
      const courseId = ev.id.split(':')[1] ?? '';
      const course = courseById.get(courseId);
      return (
        <div className={styles.popoverCard}>
          <div className={styles.popoverCardHead}>
            <span className={styles.colorDot} style={{ backgroundColor: ev.color ?? '#6366F1' }} />
            <strong className={styles.popoverCardTitle}>{ev.title}</strong>
            <CloseButton size="small" variant="subtle" onClick={close} />
          </div>
          <div className={styles.popoverCardMeta}>
            {ev.description && <div>{ev.description}</div>}
            {ev.location && <div>地点：{ev.location}</div>}
            {ev.attendees?.[0] && <div>教师：{ev.attendees[0]}</div>}
          </div>
          {course && (
            <div className={styles.popoverCardActions}>
              <Button
                variant="glass"
                size="small"
                icon={<Pencil size={12} />}
                onClick={() => {
                  close();
                  openEditCourse(course);
                }}
              >
                编辑课程
              </Button>
              <Button
                variant="glass"
                size="small"
                onClick={() => {
                  close();
                  setViewMode('schedule');
                }}
              >
                切至节次表
              </Button>
            </div>
          )}
        </div>
      );
    }

    if (ev.id.startsWith('sub:')) {
      const item = subscriptionItemById.get(ev.id.slice(4));
      const sub = item ? subscriptionById.get(item.subscriptionId) : undefined;
      return (
        <div className={styles.popoverCard}>
          <div className={styles.popoverCardHead}>
            <span className={styles.colorDot} style={{ backgroundColor: ev.color ?? '#F59E0B' }} />
            <strong className={styles.popoverCardTitle}>{ev.title}</strong>
            <CloseButton size="small" variant="subtle" onClick={close} />
          </div>
          <div className={styles.popoverCardMeta}>
            <div>
              {item?.startDate ?? ev.start}
              {item && item.endDate !== item.startDate ? ` 至 ${item.endDate}` : ''}
              {item?.allDay ? ' · 全天' : item ? ` · ${item.startTime}–${item.endTime}` : ''}
            </div>
            {sub && <div>来源订阅：{sub.name}</div>}
            {item?.location && <div>地点：{item.location}</div>}
            {item?.description && <div className={styles.popoverCardDesc}>{item.description}</div>}
          </div>
          {sub && (
            <div className={styles.popoverCardActions}>
              <Button
                variant="glass"
                size="small"
                onClick={() => {
                  close();
                  void handleRefreshSubscriptionQuick(sub.id);
                }}
              >
                刷新同步
              </Button>
              <Button
                variant="glass"
                size="small"
                onClick={() => {
                  close();
                  openCategoryDialog({ editingSubscription: sub });
                }}
              >
                管理订阅
              </Button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={styles.popoverCard}>
        <div className={styles.popoverCardHead}>
          <span className={styles.colorDot} style={{ backgroundColor: '#F59E0B' }} />
          <strong className={styles.popoverCardTitle}>{ev.title}</strong>
          <CloseButton size="small" variant="subtle" onClick={close} />
        </div>
        <div className={styles.popoverCardMeta}>
          <div>{ev.start} · 当日自动跳过课表提醒</div>
        </div>
      </div>
    );
  };

  const monthNumber = weekColumns[0]?.month ?? now.getMonth() + 1;
  const totalHeight = slots.length * SLOT_ROW_HEIGHT;
  const scheduleNowLineTop = useMemo(
    () => computeScheduleNowLineTop(slots, nowMinutes, SLOT_ROW_HEIGHT),
    [slots, nowMinutes],
  );
  const isViewingActualWeek =
    activeDetail != null &&
    viewingWeek === Math.max(1, Math.min(activeDetail.schedule.totalWeeks, currentActualWeek));

  // 统一顶栏标题（日视图带日期星期，周/月/节次视图统一展示「YYYY 年 M 月」以彻底消除切换跳变）
  const toolbarHeading = useMemo(() => {
    if (workspaceMode === 'schedule' && weekColumns.length > 0) {
      const first = weekColumns[0]!;
      return `${first.dateStr.slice(0, 4)} 年 ${first.month} 月`;
    }
    const parsed = parseLocalDate(selectedDate);
    if (Number.isNaN(parsed.getTime())) return selectedDate;
    const y = parsed.getFullYear();
    const m = parsed.getMonth() + 1;
    const d = parsed.getDate();
    if (viewMode === 'day') {
      const isoDay = parsed.getDay() === 0 ? 7 : parsed.getDay();
      return `${y} 年 ${m} 月 ${d} 日 · ${getWeekdayName(isoDay)}`;
    }
    return `${y} 年 ${m} 月`;
  }, [workspaceMode, weekColumns, selectedDate, viewMode]);

  const activeTeachWeekBadge =
    workspaceMode === 'schedule' ? (activeDetail ? viewingWeek : null) : focusTeachWeek;

  // 课表视图表头每日融合胶囊（订阅日历节假日/调休 + 本地日程 + 待办任务，与周视图表头风格保持一致）
  const weekHeaderExtrasMap = useMemo(() => {
    const map = new Map<
      string,
      {
        subs: Array<{ id: string; title: string; color: string; sub?: CalendarSubscription }>;
        evs: CalendarEvent[];
        tsks: CalendarTask[];
      }
    >();
    if (workspaceMode !== 'schedule' || weekColumns.length === 0) return map;

    const q = searchQuery.trim().toLowerCase();
    const matchQuery = (...parts: Array<string | undefined>) =>
      !q || parts.some((p) => (p ?? '').toLowerCase().includes(q));

    for (const col of weekColumns) {
      const coveredHoliday = new Set<string>();
      const subs: Array<{ id: string; title: string; color: string; sub?: CalendarSubscription }> = [];

      for (const item of subscriptionItems) {
        const sub = subscriptionById.get(item.subscriptionId);
        if (!sub || !sub.visible) continue;
        if (!eventCoversDate(item, col.dateStr)) continue;
        if (!matchQuery(item.title, item.location, item.description, sub.name)) continue;
        if (item.badge === 'off') coveredHoliday.add(col.dateStr);
        subs.push({
          id: item.id,
          title: item.title,
          color: item.badge === 'work' ? '#EF4444' : sub.color,
          sub,
        });
      }

      if (
        activeDetail?.schedule.holidays.includes(col.dateStr) &&
        !coveredHoliday.has(col.dateStr) &&
        matchQuery('自定义停课', '休', col.dateStr)
      ) {
        subs.push({
          id: `hol:${col.dateStr}`,
          title: '自定义停课 · 休',
          color: '#F59E0B',
        });
      }

      const evs = calEvents.filter(
        (e) =>
          visibleCatSet.has(e.calendarId) &&
          eventCoversDate(e, col.dateStr) &&
          matchQuery(e.title, e.location, e.description),
      );
      const tsks = showTasksLayer
        ? calTasks.filter((t) => t.dueDate === col.dateStr && matchQuery(t.title, t.description))
        : [];

      if (subs.length > 0 || evs.length > 0 || tsks.length > 0) {
        map.set(col.dateStr, { subs, evs, tsks });
      }
    }
    return map;
  }, [
    workspaceMode,
    weekColumns,
    searchQuery,
    subscriptionItems,
    subscriptionById,
    activeDetail?.schedule.holidays,
    calEvents,
    visibleCatSet,
    showTasksLayer,
    calTasks,
  ]);

  const rightRailToggleBtn = (
    <Button
      variant="glass"
      size="small"
      icon={rightRailOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
      aria-label={rightRailOpen ? '收起右侧联动栏' : '展开右侧联动栏'}
      title={rightRailOpen ? '收起右侧月历与议程' : '展开右侧月历与议程'}
      onClick={toggleRightRail}
    />
  );

  const canStepPrev = workspaceMode !== 'schedule' || viewingWeek > 1;
  const canStepNext =
    workspaceMode !== 'schedule' || !activeDetail || viewingWeek < activeDetail.schedule.totalWeeks;

  return (
    <div className={styles.page}>
      <div className={styles.workspaceSplit}>
        {/* 左侧主画布：展开时预留右侧 300px 空间（单次重排，避免逐帧 width 动画触发全屏折射重绘导致掉帧） */}
        <main
          className={`${styles.mainCanvasPane} ${
            rightRailOpen ? styles.mainCanvasWithRail : ''
          }`}
        >
          <div className={styles.mainBoardCard}>
            <header className={styles.unifiedToolbar}>
              <div className={styles.unifiedToolbarLeft}>
                <Button variant="glass" size="small" onClick={handleJumpTodaySynced}>
                  今天
                </Button>
                <div className={styles.unifiedNavArrows}>
                  <button
                    type="button"
                    className={styles.unifiedNavBtn}
                    disabled={!canStepPrev}
                    aria-label="上一周期"
                    onClick={() => handleStepPeriod(-1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    type="button"
                    className={styles.unifiedNavBtn}
                    disabled={!canStepNext}
                    aria-label="下一周期"
                    onClick={() => handleStepPeriod(1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <h2 className={styles.unifiedHeading}>{toolbarHeading}</h2>
                {activeTeachWeekBadge != null && (
                  <Tag tone={workspaceMode === 'schedule' && !isViewingActualWeek ? 'warning' : 'info'}>
                    第 {activeTeachWeekBadge} 周
                  </Tag>
                )}
                {searchQuery.trim() && (
                  <Tag tone="warning">筛选：{searchQuery.trim()}</Tag>
                )}
              </div>

              <div className={styles.unifiedToolbarRight}>
                <SegmentedControl
                  value={viewMode}
                  onValueChange={(next) => {
                    if (next === 'schedule') {
                      setViewMode('schedule');
                    } else if (next === 'day' || next === 'week' || next === 'month') {
                      setCalSubView(next);
                      setViewMode(next);
                    }
                  }}
                  items={[
                    { value: 'day', label: '日' },
                    { value: 'week', label: '周' },
                    { value: 'month', label: '月' },
                    { value: 'schedule', label: '节次' },
                  ]}
                />
                <Menu
                  aria-label="新建日程、待办或导入课表"
                  label="新建"
                  icon={<Plus size={14} />}
                  chevron
                  align="end"
                  trigger={{ variant: 'filled', size: 'small' }}
                  items={createMenuItems}
                />
                {activeDetail && (
                  <Menu
                    aria-label="课表快捷设置"
                    icon={<SlidersHorizontal size={14} />}
                    align="end"
                    open={quickPanelOpen}
                    onOpenChange={setQuickPanelOpen}
                    trigger={{
                      variant: 'glass',
                      size: 'small',
                      title: '课表快捷设置',
                    }}
                    renderContent={({ close }) => (
                      <div className={styles.quickPanelInner}>
                        <div className={styles.panelSection}>
                          <div className={styles.panelSectionHead}>
                            <span className={styles.panelSectionTitle}>周数</span>
                            <button
                              type="button"
                              className={styles.panelLinkBtn}
                              onClick={() => {
                                close();
                                setShareDialogOpen(true);
                              }}
                            >
                              分享当前课表 / 导出 .ics
                            </button>
                          </div>
                          <div className={styles.sliderRow}>
                            <div className={styles.sliderWrap}>
                              <Slider
                                min={1}
                                max={activeDetail.schedule.totalWeeks}
                                value={viewingWeek}
                                onValueChange={(w) => {
                                  setViewingWeek(w);
                                  if (workspaceMode !== 'schedule') setViewMode('schedule');
                                }}
                              />
                            </div>
                            <span className={styles.sliderValueBadge}>第 {viewingWeek} 周</span>
                          </div>
                        </div>

                        <div className={styles.panelSection}>
                          <div className={styles.panelSectionHead}>
                            <span className={styles.panelSectionTitle}>切换课表</span>
                            <button
                              type="button"
                              className={styles.panelLinkBtn}
                              onClick={() => {
                                close();
                                setScheduleListOpen(true);
                              }}
                            >
                              新建 / 管理课表
                            </button>
                          </div>
                          <div className={styles.scheduleCardsRow}>
                            {schedules.map((item) => {
                              const active = item.id === activeDetail.schedule.id;
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  className={`${styles.scheduleTile} ${active ? styles.scheduleTileActive : ''}`}
                                  onClick={() => void selectSchedule(item.id)}
                                >
                                  <span className={styles.scheduleTileBox}>
                                    {active ? <Check size={20} /> : <CalendarDays size={18} />}
                                  </span>
                                  <span className={styles.scheduleTileName}>{item.name}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className={styles.toolGrid}>
                          <button
                            type="button"
                            className={styles.toolTile}
                            onClick={() => {
                              close();
                              setTimetableDialogOpen(true);
                            }}
                          >
                            <Clock3 size={17} />
                            <span>上课时间</span>
                          </button>
                          <button
                            type="button"
                            className={styles.toolTile}
                            onClick={() => {
                              close();
                              setSettingsDialogOpen(true);
                            }}
                          >
                            <SlidersHorizontal size={17} />
                            <span>课表设置</span>
                          </button>
                          <button
                            type="button"
                            className={styles.toolTile}
                            onClick={() => {
                              close();
                              setCourseListOpen(true);
                            }}
                          >
                            <FolderKanban size={17} />
                            <span>已添课程 ({activeDetail.courses.length})</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.toolTile} ${
                              activeDetail.schedule.reminderEnabled ? styles.toolTileActive : ''
                            }`}
                            onClick={() => void handleToggleReminder()}
                          >
                            {activeDetail.schedule.reminderEnabled ? (
                              <Bell size={17} />
                            ) : (
                              <BellOff size={17} />
                            )}
                            <span>上课提醒</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.toolTile} ${isDarkTheme ? styles.toolTileActive : ''}`}
                            onClick={handleToggleTheme}
                          >
                            {isDarkTheme ? <Moon size={17} /> : <Sun size={17} />}
                            <span>{isDarkTheme ? '浅色模式' : '夜间模式'}</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.toolTile} ${
                              activeDetail.schedule.compactMode ? styles.toolTileActive : ''
                            }`}
                            onClick={() => void handleToggleCompact()}
                          >
                            <EyeOff size={17} />
                            <span>简洁模式</span>
                          </button>
                        </div>
                      </div>
                    )}
                  />
                )}
                {rightRailToggleBtn}
              </div>
            </header>

            <div className={styles.mainBoardBody}>
              {workspaceMode === 'calendar' ? (
                <div className={styles.scheduleCalendarHost}>
                  <ScheduleCalendar
                    height="100%"
                    events={unifiedEvents}
                    view={calSubView}
                    onViewChange={(next) => {
                      setCalSubView(next);
                      setViewMode(next);
                    }}
                    date={selectedDate}
                    onDateChange={handleSelectDateSynced}
                    today={todayStr}
                    weekStartsOn={activeDetail?.schedule.weekStartDay === 7 ? 0 : 1}
                    showSidebar={false}
                    maxEventsPerDay={4}
                    {...({ dayBadges } as Record<string, unknown>)}
                    onSlotClick={handleSlotClick}
                    renderEventPopover={renderEventPopover}
                  />
                </div>
              ) : !activeDetail ? (
                <div className={styles.emptyState}>
                  <Empty
                    title="导入西南石油大学课表"
                    description="登录西南石油大学统一身份认证即可一键导入本学期课程、成都校区作息与开学日期，并与日程、待办任务统一呈现。"
                  >
                    <div className={styles.emptyActions}>
                      <Button
                        variant="filled"
                        icon={<Download size={15} />}
                        onClick={() => setImportDialogOpen(true)}
                      >
                        一键导入西柚课表
                      </Button>
                      <Button
                        variant="glass"
                        icon={<Plus size={15} />}
                        onClick={() => openNewCourse()}
                      >
                        手动新建课表
                      </Button>
                    </div>
                  </Empty>
                </div>
              ) : (
                <>
                  <div className={styles.dayHeaderRow}>
                    <div className={styles.monthCell}>
                      <span>{monthNumber}</span>
                      <span>月</span>
                    </div>
                    {weekColumns.map((col) => {
                      const isOffDay = holidayOffDateSet.has(col.dateStr);
                      const isWorkDay = holidayWorkDateSet.has(col.dateStr);
                      const isSelected = col.dateStr === selectedDate;
                      const extras = weekHeaderExtrasMap.get(col.dateStr);
                      return (
                        <div
                          key={col.dateStr}
                          role="button"
                          tabIndex={0}
                          className={`${styles.dayHeaderCell} ${styles.dayHeaderClickable} ${
                            col.isToday ? styles.dayHeaderToday : ''
                          } ${isSelected && !col.isToday ? styles.dayHeaderSelected : ''}`}
                          onClick={() => setSelectedDate(col.dateStr)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedDate(col.dateStr);
                            }
                          }}
                        >
                          <span className={styles.dayHeaderLabel}>
                            {col.label}
                            {isOffDay && <span className={styles.holidayDot}> 休</span>}
                            {!isOffDay && isWorkDay && (
                              <span className={styles.workdayDot}> 班</span>
                            )}
                          </span>
                          <span className={styles.dayHeaderDate}>{col.dayOfMonth}</span>

                          {extras && (
                            <div className={styles.scheduleHeaderPills}>
                              {extras.subs.map((entry) => (
                                <button
                                  key={entry.id}
                                  type="button"
                                  className={styles.scheduleHeaderPill}
                                  style={
                                    { '--pill-color': entry.color } as React.CSSProperties
                                  }
                                  title={entry.title}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedDate(col.dateStr);
                                    if (entry.sub) {
                                      openCategoryDialog({ editingSubscription: entry.sub });
                                    }
                                  }}
                                >
                                  <span>{entry.title}</span>
                                </button>
                              ))}

                              {extras.evs.map((ev) => {
                                const color = categoryColorMap.get(ev.calendarId) ?? '#2563EB';
                                return (
                                  <button
                                    key={ev.id}
                                    type="button"
                                    className={styles.scheduleHeaderPill}
                                    style={{ '--pill-color': color } as React.CSSProperties}
                                    title={`${ev.allDay ? '全天' : ev.startTime} ${ev.title}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedDate(col.dateStr);
                                      openEditEvent(ev);
                                    }}
                                  >
                                    <span>
                                      {ev.allDay ? '' : `${ev.startTime} `}
                                      {ev.title}
                                    </span>
                                  </button>
                                );
                              })}

                              {extras.tsks.map((t) => (
                                <div
                                  key={t.id}
                                  className={`${styles.monthLineItem} ${
                                    t.completed ? styles.monthItemDone : ''
                                  }`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedDate(col.dateStr);
                                    openEditTask(t);
                                  }}
                                >
                                  <button
                                    type="button"
                                    className={`${styles.miniTaskCheck} ${
                                      t.completed ? styles.miniTaskCheckDone : ''
                                    }`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void toggleTask(t.id, !t.completed);
                                    }}
                                  >
                                    {t.completed && <Check size={9} strokeWidth={3} />}
                                  </button>
                                  <span className={styles.monthItemText}>{t.title}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className={styles.gridScroll}>
                    <div
                      className={`${styles.gridBody} ${
                        activeDetail.schedule.compactMode ? styles.compactGrid : ''
                      }`}
                      style={{ minHeight: totalHeight }}
                    >
                      <div className={styles.timeAxisCol}>
                        {slots.map((slot) => (
                          <div
                            key={slot.section}
                            className={styles.timeSlotCell}
                            style={{ height: SLOT_ROW_HEIGHT }}
                          >
                            <span className={styles.sectionNumber}>{slot.section}</span>
                            {!activeDetail.schedule.compactMode && (
                              <>
                                <span className={styles.sectionClock}>{slot.startTime}</span>
                                <span className={styles.sectionClock}>{slot.endTime}</span>
                              </>
                            )}
                          </div>
                        ))}
                      </div>

                      {weekColumns.map((col) => {
                        const dayItems = meetingsByDay.get(col.dayOfWeek) ?? [];
                        const courseOverlapMap = layoutOverlappingIntervals(
                          dayItems.map(({ meeting }) => ({
                            id: meeting.id,
                            start: meeting.startSection,
                            end: Math.max(meeting.startSection + 1, meeting.endSection + 1),
                          })),
                        );
                        return (
                          <div
                            key={col.dateStr}
                            className={`${styles.dayCol} ${col.isToday ? styles.dayColToday : ''}`}
                            style={{ height: totalHeight }}
                          >
                            {slots.map((slot) => (
                              <div
                                key={slot.section}
                                className={styles.gridRowCell}
                                style={{ height: SLOT_ROW_HEIGHT }}
                                onClick={() => setSelectedDate(col.dateStr)}
                                onDoubleClick={() =>
                                  openNewCourse({
                                    dayOfWeek: col.dayOfWeek,
                                    section: slot.section,
                                  })
                                }
                                title="单击选中当日议程，双击此格添加课程"
                              />
                            ))}

                            {dayItems.map(({ course, meeting }) => {
                              const startIdx = Math.max(0, meeting.startSection - 1);
                              const span = Math.max(
                                1,
                                Math.min(slots.length, meeting.endSection) -
                                  meeting.startSection +
                                  1,
                              );
                              const top = startIdx * SLOT_ROW_HEIGHT + 3;
                              const height = span * SLOT_ROW_HEIGHT - 6;
                              const box = courseOverlapMap.get(meeting.id);
                              const leftPct = box?.leftPercent ?? 0;
                              const widthPct = box?.widthPercent ?? 100;
                              return (
                                <button
                                  key={meeting.id}
                                  type="button"
                                  className={styles.courseCard}
                                  style={{
                                    top,
                                    height,
                                    left: `calc(${leftPct}% + 3px)`,
                                    width: `calc(${widthPct}% - 6px)`,
                                    zIndex: box?.zIndex ?? 2,
                                    background: `linear-gradient(160deg, ${course.color}ee, ${course.color}cc)`,
                                  }}
                                  onClick={() => {
                                    setSelectedDate(col.dateStr);
                                    openEditCourse(course);
                                  }}
                                >
                                  <span className={styles.courseCardName}>{course.name}</span>
                                  {meeting.location && (
                                    <span className={styles.courseCardMeta}>
                                      @{meeting.location}
                                    </span>
                                  )}
                                  {!activeDetail.schedule.compactMode &&
                                    meeting.teacher &&
                                    span >= 2 && (
                                      <span className={styles.courseCardTeacher}>
                                        {meeting.teacher}
                                      </span>
                                    )}
                                </button>
                              );
                            })}

                            {col.isToday && scheduleNowLineTop !== null && (
                              <div
                                className={styles.scheduleNowLine}
                                style={{ top: scheduleNowLineTop }}
                                aria-hidden="true"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </main>

        {/* 右侧可折叠双栏：定宽内层 + 外层宽度/透明度/位移平滑过渡，收起时内容不挤压变形 */}
        <div
          className={`${styles.rightRailWrap} ${
            !rightRailOpen ? styles.rightRailWrapCollapsed : ''
          }`}
          aria-hidden={!rightRailOpen}
        >
          <ScheduleRightRail
            selectedDate={selectedDate}
            todayStr={todayStr}
            focusTeachWeek={focusTeachWeek}
            activeDetail={activeDetail}
            categories={categories}
            events={calEvents}
            tasks={calTasks}
            subscriptions={subscriptions}
            subscriptionItems={subscriptionItems}
            syncingSubscriptionIds={syncingSubscriptionIds}
            studioSyncing={studioSyncing}
            holidayOffDateSet={holidayOffDateSet}
            searchQuery={searchQuery}
            showCoursesLayer={showCoursesLayer}
            showTasksLayer={showTasksLayer}
            onSelectDate={handleSelectDateSynced}
            onSearchChange={setSearchQuery}
            onToggleCategory={(id, visible) => void setCategoryVisible(id, visible)}
            onEditCategory={(cat) => openCategoryDialog({ editingCategory: cat })}
            onDeleteCategory={(cat) => void handleDeleteCategoryQuick(cat)}
            onCreateEventInCategory={(categoryId) =>
              openCreateItem('event', selectedDate, undefined, undefined, categoryId)
            }
            onRefreshStudioEvents={() => void handleRefreshStudioQuick()}
            onToggleSubscription={(id, visible) => void setSubscriptionVisible(id, visible)}
            onRefreshSubscription={(id) => void handleRefreshSubscriptionQuick(id)}
            onEditSubscription={(sub) => openCategoryDialog({ editingSubscription: sub })}
            onDeleteSubscription={(sub) => void handleDeleteSubscriptionQuick(sub)}
            onToggleCoursesLayer={setShowCoursesLayer}
            onToggleTasksLayer={setShowTasksLayer}
            onQuickAddTask={handleQuickAddTask}
            onToggleTask={toggleTask}
            onDeleteTask={deleteTask}
            onEditTask={openEditTask}
            onEditEvent={openEditEvent}
            onEditCourse={openEditCourse}
            onCreateEventForDate={(dateStr) => openCreateItem('event', dateStr)}
            onOpenAddCategory={() => openCategoryDialog({ initialTab: 'local' })}
            onOpenManageSchedules={() => setScheduleListOpen(true)}
          />
        </div>
      </div>

      {/* 弹窗集合 */}
      <SwpuImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />

      <EventTaskEditorDialog
        open={itemDialogOpen}
        onOpenChange={setItemDialogOpen}
        draft={itemDraft}
        categories={categories}
        studioMembers={studioMembers}
        currentUser={
          auth.profile?.subject
            ? {
                userId: auth.profile.subject,
                displayName: auth.profile.name || auth.profile.username || '我',
                avatar: auth.profile.avatar || '',
              }
            : null
        }
        activeScheduleDetail={activeDetail}
        localEvents={localEvents}
        studioEvents={studioEvents}
        onSaveEvent={upsertEvent}
        onDeleteEvent={deleteEvent}
        onSaveTask={upsertTask}
        onDeleteTask={deleteTask}
        onSwitchToAddCourse={() => openNewCourse()}
      />

      <CategoryEditorDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        draft={categoryDraft}
        onSaveCategory={async (input) => {
          const saved = await saveCategory(input);
          notifyToast({
            tone: 'success',
            title: input.id ? `已更新日历「${saved.name}」` : `已添加日历「${saved.name}」`,
          });
        }}
        onDeleteCategory={async (categoryId) => {
          const target = categories.find((c) => c.id === categoryId);
          await deleteCategory(categoryId);
          notifyToast({
            tone: 'info',
            title: `已删除日历「${target?.name ?? ''}」`,
            description: '原日程已安全迁回「个人日程」。',
          });
        }}
        onSaveSubscription={async (input) => {
          const res = await saveSubscription(input);
          notifyToast({
            tone: 'success',
            title: input.id
              ? `已更新订阅「${res.subscription.name}」`
              : `已订阅「${res.subscription.name}」（同步 ${res.itemCount} 条）`,
          });
        }}
        onRefreshSubscription={async (subscriptionId) => {
          await handleRefreshSubscriptionQuick(subscriptionId);
        }}
        onDeleteSubscription={async (subscriptionId) => {
          const target = subscriptions.find((s) => s.id === subscriptionId);
          await deleteSubscription(subscriptionId);
          notifyToast({ tone: 'info', title: `已退订「${target?.name ?? ''}」` });
        }}
        onImportIcsFile={async (input) => {
          const res = await importIcsFile(input);
          if (!res.canceled && res.category) {
            notifyToast({
              tone: 'success',
              title: `已导入日历「${res.category.name}」（共 ${res.importedCount ?? 0} 条）`,
            });
          }
          return res;
        }}
      />

      <Dialog
        open={Boolean(importSuccessNotice?.open)}
        onOpenChange={(open) => {
          if (!open) dismissImportSuccessNotice();
        }}
        size="small"
        title="导课成功"
      >
        <div className={styles.dialogContainer}>
          <div className={styles.dialogBody}>
            <p className={styles.hintText} style={{ margin: 0, fontSize: 13.5 }}>
              已导入「{importSuccessNotice?.scheduleName}」（共{' '}
              <strong>{importSuccessNotice?.courseCount ?? 0}</strong> 门课程，
              <strong>{importSuccessNotice?.meetingCount ?? 0}</strong> 条排课）。
              <br />
              当前默认开学第一周第一天为{' '}
              <strong>{importSuccessNotice?.startDate.replace(/-/g, '/')}</strong>
              ，可在课表设置里随时调节。
            </p>
          </div>
          <div className={styles.dialogFooter}>
            <div className={styles.dialogFooterRight}>
              <Button variant="glass" onClick={dismissImportSuccessNotice}>
                我知道了
              </Button>
              <Button
                variant="filled"
                onClick={() => {
                  dismissImportSuccessNotice();
                  setSettingsDialogOpen(true);
                }}
              >
                设置开学日期
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      {activeDetail && (
        <>
          <CourseEditorDialog
            open={courseEditorOpen}
            onOpenChange={setCourseEditorOpen}
            scheduleId={activeDetail.schedule.id}
            totalWeeks={activeDetail.schedule.totalWeeks}
            maxSections={activeDetail.schedule.maxSections}
            editingCourse={editingCourse}
            initialSlot={initialSlot}
            onSave={upsertCourse}
            onDelete={(courseId) => deleteCourses(activeDetail.schedule.id, [courseId])}
          />

          <CourseListDialog
            open={courseListOpen}
            onOpenChange={setCourseListOpen}
            detail={activeDetail}
            onSelectCourse={openEditCourse}
            onAddCourse={() => openNewCourse()}
            onDeleteCourses={(ids) => deleteCourses(activeDetail.schedule.id, ids)}
            onClearAll={() => clearCourses(activeDetail.schedule.id)}
          />

          <TimetableEditorDialog
            open={timetableDialogOpen}
            onOpenChange={setTimetableDialogOpen}
            timetable={activeDetail.timetable}
            onSave={async (input) => {
              await saveTimetable(input);
            }}
          />

          <ScheduleSettingsDialog
            open={settingsDialogOpen}
            onOpenChange={setSettingsDialogOpen}
            detail={activeDetail}
            timetables={timetables}
            onSave={updateSchedule}
            onOpenTimetable={() => setTimetableDialogOpen(true)}
          />

          <ShareScheduleDialog
            open={shareDialogOpen}
            onOpenChange={setShareDialogOpen}
            detail={activeDetail}
          />
        </>
      )}

      <ScheduleListDialog
        open={scheduleListOpen}
        onOpenChange={setScheduleListOpen}
        schedules={schedules}
        onSelect={selectSchedule}
        onCreate={async (name) => {
          await createSchedule({ name, setActive: true });
        }}
        onDelete={deleteSchedule}
      />
    </div>
  );
}
