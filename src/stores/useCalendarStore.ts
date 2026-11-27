/** 统一日历（个人本地日程 + 工作室云端共享日程 + 任务 + 订阅日历 + 视图）前端 Zustand 状态仓库。 */
import { create } from 'zustand';
import {
  DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID,
  DEFAULT_STUDIO_CALENDAR_ID,
  type CalendarCategory,
  type CalendarEvent,
  type CalendarSubscription,
  type CalendarSubscriptionItem,
  type CalendarTask,
  type CalendarViewMode,
  type ImportIcsFileInput,
  type ImportIcsFileResult,
  type SaveCalendarCategoryInput,
  type SaveCalendarSubscriptionInput,
  type UpsertCalendarEventInput,
  type UpsertCalendarTaskInput,
} from '@shared/calendar';
import { formatLocalDate, parseLocalDate } from '@shared/schedule';
import { getOrbitClient } from '@/services/orbitClient';
import {
  orbitServerApi,
  type OrbitWsEvent,
  type StudioCalendarEventDTO,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';

const VIEW_MODE_KEY = 'orbit:calendar:view-mode:v1';
const STUDIO_EVENTS_CACHE_KEY = 'studio_calendar_events_v1';
const HOLIDAY_AUTO_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const EXTERNAL_SUB_AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readInitialViewMode(): CalendarViewMode {
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_KEY);
    if (raw === 'schedule' || raw === 'day' || raw === 'week' || raw === 'month') {
      return raw;
    }
  } catch {
    // 忽略本地存储异常
  }
  // 默认进入周视图：课程卡片 + 个人日程 + 工作室日程 + 待办任务直接按时间轴同框共存
  return 'week';
}

function dtoToStudioCalendarEvent(dto: StudioCalendarEventDTO): CalendarEvent {
  return {
    id: dto.id,
    calendarId: DEFAULT_STUDIO_CALENDAR_ID,
    title: dto.title,
    description: dto.description ?? '',
    location: dto.location ?? '',
    allDay: Boolean(dto.allDay),
    startDate: dto.startDate,
    endDate: dto.endDate || dto.startDate,
    startTime: dto.startTime || '09:00',
    endTime: dto.endTime || '10:00',
    reminderMinutes: dto.reminderMinutes ?? null,
    createdAt: Date.parse(dto.createdAt) || Date.now(),
    updatedAt: Date.parse(dto.updatedAt) || Date.now(),
    source: 'studio',
    creatorId: dto.creatorId,
    creatorName: dto.creatorName || '',
    creatorAvatar: dto.creatorAvatar || '',
    attendeeUserIds: Array.isArray(dto.attendeeUserIds) ? dto.attendeeUserIds : [],
    attendeeGrades: Array.isArray(dto.attendeeGrades) ? dto.attendeeGrades : [],
    attendeeResponses: dto.attendeeResponses ?? {},
  };
}

function sortEvents(list: CalendarEvent[]): CalendarEvent[] {
  return [...list].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      Number(b.allDay) - Number(a.allDay) ||
      a.startTime.localeCompare(b.startTime),
  );
}

export interface PendingScheduleCreateDraft {
  date: string;
  startTime?: string;
  endTime?: string;
  calendarId?: string;
  attendeeUserIds?: string[];
}

interface CalendarStoreState {
  loaded: boolean;
  loading: boolean;
  categories: CalendarCategory[];
  /** 本地私有日程（个人日程及自定义日历） */
  events: CalendarEvent[];
  /** 工作室全员共享云端日程（含本地离线镜像缓存） */
  studioEvents: CalendarEvent[];
  studioSyncing: boolean;
  studioServerOnline: boolean;
  studioLastError: string | null;
  tasks: CalendarTask[];
  subscriptions: CalendarSubscription[];
  subscriptionItems: CalendarSubscriptionItem[];
  /** 正在网络同步中的订阅日历 ID 集合 */
  syncingSubscriptionIds: string[];

  viewMode: CalendarViewMode;
  selectedDate: string;
  miniMonth: { year: number; month: number };
  sidebarOpen: boolean;
  searchQuery: string;

  /** 跨页面触发「约 Ta 创建日程」时暂存的预填草稿 */
  pendingCreateDraft: PendingScheduleCreateDraft | null;
  setPendingCreateDraft: (draft: PendingScheduleCreateDraft | null) => void;
  consumePendingCreateDraft: () => PendingScheduleCreateDraft | null;

  /** 内置功能图层显隐控制 */
  showCoursesLayer: boolean;
  showTasksLayer: boolean;
  showHolidaysLayer: boolean;
  expandCoursesInMonth: boolean;

  loadSnapshot: () => Promise<void>;
  syncStudioEvents: (options?: { silent?: boolean }) => Promise<void>;
  applyStudioWsEvent: (
    event: OrbitWsEvent,
    currentUserId: string | undefined,
    onOpenSchedule?: () => void,
  ) => boolean;
  setViewMode: (mode: CalendarViewMode) => void;
  setSelectedDate: (dateStr: string) => void;
  stepSelectedDate: (deltaDays: number) => void;
  stepSelectedMonth: (deltaMonths: number) => void;
  jumpToToday: () => void;
  setMiniMonth: (year: number, month: number) => void;
  toggleSidebar: () => void;
  setSearchQuery: (q: string) => void;
  setShowCoursesLayer: (v: boolean) => void;
  setShowTasksLayer: (v: boolean) => void;
  setShowHolidaysLayer: (v: boolean) => void;
  setExpandCoursesInMonth: (v: boolean) => void;

  saveCategory: (input: SaveCalendarCategoryInput) => Promise<CalendarCategory>;
  setCategoryVisible: (categoryId: string, visible: boolean) => Promise<void>;
  deleteCategory: (categoryId: string) => Promise<void>;
  upsertEvent: (input: UpsertCalendarEventInput) => Promise<CalendarEvent>;
  rsvpStudioEvent: (
    eventId: string,
    status: 'accepted' | 'tentative' | 'declined',
  ) => Promise<CalendarEvent>;
  deleteEvent: (eventId: string) => Promise<void>;
  upsertTask: (input: UpsertCalendarTaskInput) => Promise<CalendarTask>;
  toggleTask: (taskId: string, completed: boolean) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;

  saveSubscription: (
    input: SaveCalendarSubscriptionInput,
  ) => Promise<{ subscription: CalendarSubscription; itemCount: number; warning?: string }>;
  refreshSubscription: (
    subscriptionId: string,
  ) => Promise<{ subscription: CalendarSubscription; itemCount: number; warning?: string }>;
  setSubscriptionVisible: (subscriptionId: string, visible: boolean) => Promise<void>;
  deleteSubscription: (subscriptionId: string) => Promise<void>;
  importIcsFile: (input?: ImportIcsFileInput) => Promise<ImportIcsFileResult>;
}

const initialNow = new Date();
const initialDateStr = formatLocalDate(initialNow);
let holidayAutoSyncTriggered = false;

export const useCalendarStore = create<CalendarStoreState>((set, get) => ({
  loaded: false,
  loading: false,
  categories: [],
  events: [],
  studioEvents: [],
  studioSyncing: false,
  studioServerOnline: false,
  studioLastError: null,
  tasks: [],
  subscriptions: [],
  subscriptionItems: [],
  syncingSubscriptionIds: [],

  viewMode: readInitialViewMode(),
  selectedDate: initialDateStr,
  miniMonth: { year: initialNow.getFullYear(), month: initialNow.getMonth() + 1 },
  sidebarOpen: true,
  searchQuery: '',
  pendingCreateDraft: null,

  setPendingCreateDraft: (pendingCreateDraft) => set({ pendingCreateDraft }),
  consumePendingCreateDraft: () => {
    const cur = get().pendingCreateDraft;
    if (cur) set({ pendingCreateDraft: null });
    return cur;
  },

  showCoursesLayer: true,
  showTasksLayer: true,
  showHolidaysLayer: true,
  expandCoursesInMonth: false,

  loadSnapshot: async () => {
    set({ loading: true });
    try {
      const client = getOrbitClient();
      const [snap, cachedStudio] = await Promise.all([
        client.calendar.getSnapshot(),
        client.storage.getCache<CalendarEvent[]>(STUDIO_EVENTS_CACHE_KEY).catch(() => null),
      ]);
      const cachedStudioList = Array.isArray(cachedStudio?.value) ? cachedStudio.value : null;

      set((s) => ({
        loaded: true,
        loading: false,
        categories: snap.categories,
        events: snap.events.map((e) => ({ ...e, source: 'local' as const })),
        studioEvents:
          s.studioEvents.length > 0 ? s.studioEvents : (cachedStudioList ?? []),
        tasks: snap.tasks,
        subscriptions: snap.subscriptions ?? [],
        subscriptionItems: snap.subscriptionItems ?? [],
      }));

      // 后台静默同步工作室全员共享日程
      void get().syncStudioEvents({ silent: true });

      // 首次进入或超过同步周期时，后台静默拉取并持久化订阅日历到本地 SQLite
      if (!holidayAutoSyncTriggered) {
        holidayAutoSyncTriggered = true;
        const nowTs = Date.now();
        const dueSubs = (snap.subscriptions ?? []).filter((sub) => {
          const interval =
            sub.id === DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID
              ? HOLIDAY_AUTO_SYNC_INTERVAL_MS
              : EXTERNAL_SUB_AUTO_SYNC_INTERVAL_MS;
          return !sub.lastSyncedAt || nowTs - sub.lastSyncedAt > interval;
        });
        for (const sub of dueSubs) {
          void get()
            .refreshSubscription(sub.id)
            .catch(() => {
              if (sub.id === DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID) {
                holidayAutoSyncTriggered = false;
              }
            });
        }
      }
    } catch {
      set({ loaded: true, loading: false });
    }
  },

  syncStudioEvents: async (options) => {
    set({ studioSyncing: true });
    try {
      const token = await getOrbitClient().auth.getApiToken('orbit');
      if (!token) {
        set({ studioSyncing: false, studioServerOnline: false });
        return;
      }
      const dtos = await orbitServerApi.listStudioCalendarEvents();
      const mapped = sortEvents(dtos.map(dtoToStudioCalendarEvent));
      set({
        studioEvents: mapped,
        studioSyncing: false,
        studioServerOnline: true,
        studioLastError: null,
      });
      void getOrbitClient()
        .storage.setCache(STUDIO_EVENTS_CACHE_KEY, mapped)
        .catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : '同步工作室共享日程失败';
      set({
        studioSyncing: false,
        studioServerOnline: false,
        studioLastError: message,
      });
      if (!options?.silent) {
        throw new Error(message);
      }
    }
  },

  applyStudioWsEvent: (event, currentUserId, onOpenSchedule) => {
    if (event.type === 'studio_calendar.created') {
      const dto = event.payload as unknown as StudioCalendarEventDTO;
      if (!dto?.id) return true;
      const mapped = dtoToStudioCalendarEvent(dto);
      const next = sortEvents([
        mapped,
        ...get().studioEvents.filter((e) => e.id !== mapped.id),
      ]);
      set({ studioEvents: next, studioServerOnline: true });
      void getOrbitClient().storage.setCache(STUDIO_EVENTS_CACHE_KEY, next).catch(() => undefined);

      const isMine = Boolean(currentUserId && mapped.creatorId === currentUserId);
      if (!isMine) {
        const summary = `${mapped.startDate} ${mapped.allDay ? '全天' : mapped.startTime} · ${mapped.title}`;
        void getOrbitClient().system.notify('工作室新日程', summary);
        notifyToast({
          tone: 'info',
          title: `${mapped.creatorName || '团队成员'}发布了工作室日程`,
          description: summary,
          action: onOpenSchedule ? { label: '前往查看', onClick: onOpenSchedule } : undefined,
        });
      }
      return true;
    }

    if (event.type === 'studio_calendar.updated') {
      const dto = event.payload as unknown as StudioCalendarEventDTO;
      if (!dto?.id) return true;
      const mapped = dtoToStudioCalendarEvent(dto);
      const next = sortEvents([
        mapped,
        ...get().studioEvents.filter((e) => e.id !== mapped.id),
      ]);
      set({ studioEvents: next, studioServerOnline: true });
      void getOrbitClient().storage.setCache(STUDIO_EVENTS_CACHE_KEY, next).catch(() => undefined);
      return true;
    }

    if (event.type === 'studio_calendar.deleted') {
      const id = String(event.payload?.id ?? '');
      if (!id) return true;
      const next = get().studioEvents.filter((e) => e.id !== id);
      set({ studioEvents: next });
      void getOrbitClient().storage.setCache(STUDIO_EVENTS_CACHE_KEY, next).catch(() => undefined);
      return true;
    }

    return false;
  },

  setViewMode: (mode) => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // 忽略本地存储异常
    }
    set({ viewMode: mode });
  },

  setSelectedDate: (dateStr) => {
    const parsed = parseLocalDate(dateStr);
    if (Number.isNaN(parsed.getTime())) return;
    set({
      selectedDate: dateStr,
      miniMonth: { year: parsed.getFullYear(), month: parsed.getMonth() + 1 },
    });
  },

  stepSelectedDate: (deltaDays) => {
    const cur = parseLocalDate(get().selectedDate);
    if (Number.isNaN(cur.getTime())) return;
    cur.setDate(cur.getDate() + deltaDays);
    get().setSelectedDate(formatLocalDate(cur));
  },

  stepSelectedMonth: (deltaMonths) => {
    const cur = parseLocalDate(get().selectedDate);
    if (Number.isNaN(cur.getTime())) return;
    const next = new Date(cur.getFullYear(), cur.getMonth() + deltaMonths, 1);
    const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(cur.getDate(), maxDay));
    get().setSelectedDate(formatLocalDate(next));
  },

  jumpToToday: () => {
    get().setSelectedDate(formatLocalDate(new Date()));
  },

  setMiniMonth: (year, month) => {
    const d = new Date(year, month - 1, 1);
    set({ miniMonth: { year: d.getFullYear(), month: d.getMonth() + 1 } });
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setShowCoursesLayer: (showCoursesLayer) => set({ showCoursesLayer }),
  setShowTasksLayer: (showTasksLayer) => set({ showTasksLayer }),
  setShowHolidaysLayer: (showHolidaysLayer) => set({ showHolidaysLayer }),
  setExpandCoursesInMonth: (expandCoursesInMonth) => set({ expandCoursesInMonth }),

  saveCategory: async (input) => {
    const saved = await getOrbitClient().calendar.saveCategory(input);
    await get().loadSnapshot();
    return saved;
  },

  setCategoryVisible: async (categoryId, visible) => {
    set((s) => ({
      categories: s.categories.map((c) => (c.id === categoryId ? { ...c, visible } : c)),
    }));
    await getOrbitClient().calendar.setCategoryVisible(categoryId, visible);
  },

  deleteCategory: async (categoryId) => {
    await getOrbitClient().calendar.deleteCategory(categoryId);
    await get().loadSnapshot();
  },

  upsertEvent: async (input) => {
    const targetIsStudio = input.calendarId === DEFAULT_STUDIO_CALENDAR_ID;
    const existingStudio = input.id ? get().studioEvents.find((e) => e.id === input.id) : undefined;
    const existingLocal = input.id ? get().events.find((e) => e.id === input.id) : undefined;

    // 工作室共享日程：走 Orbit 后端实时同步并广播全员
    if (targetIsStudio) {
      const payload = {
        title: input.title,
        description: input.description ?? '',
        location: input.location ?? '',
        allDay: input.allDay ?? false,
        startDate: input.startDate,
        endDate: input.endDate,
        startTime: input.startTime ?? '09:00',
        endTime: input.endTime ?? '10:00',
        reminderMinutes: input.reminderMinutes === undefined ? 15 : input.reminderMinutes,
        attendeeUserIds: input.attendeeUserIds ?? [],
        attendeeGrades: input.attendeeGrades ?? [],
      };
      const dto = existingStudio
        ? await orbitServerApi.updateStudioCalendarEvent(existingStudio.id, payload)
        : await orbitServerApi.createStudioCalendarEvent(payload);

      // 若是从本地日程迁入工作室日历，删除原本地副本避免重复
      if (existingLocal && !existingStudio) {
        await getOrbitClient().calendar.deleteEvent(existingLocal.id);
        await get().loadSnapshot();
      }

      const mapped = dtoToStudioCalendarEvent(dto);
      const next = sortEvents([
        mapped,
        ...get().studioEvents.filter((e) => e.id !== mapped.id),
      ]);
      set({ studioEvents: next, studioServerOnline: true, studioLastError: null });
      void getOrbitClient().storage.setCache(STUDIO_EVENTS_CACHE_KEY, next).catch(() => undefined);
      return mapped;
    }

    // 若将原工作室日程改回本地私有日历：先建本地再删除云端
    const saved = await getOrbitClient().calendar.upsertEvent({
      ...input,
      id: existingStudio ? undefined : input.id,
    });
    if (existingStudio) {
      await orbitServerApi.deleteStudioCalendarEvent(existingStudio.id);
      const nextStudio = get().studioEvents.filter((e) => e.id !== existingStudio.id);
      set({ studioEvents: nextStudio });
      void getOrbitClient()
        .storage.setCache(STUDIO_EVENTS_CACHE_KEY, nextStudio)
        .catch(() => undefined);
    }
    await get().loadSnapshot();
    return { ...saved, source: 'local' };
  },

  rsvpStudioEvent: async (eventId, status) => {
    const dto = await orbitServerApi.rsvpStudioCalendarEvent(eventId, status);
    const mapped = dtoToStudioCalendarEvent(dto);
    const next = sortEvents([
      mapped,
      ...get().studioEvents.filter((e) => e.id !== mapped.id),
    ]);
    set({ studioEvents: next, studioServerOnline: true });
    void getOrbitClient().storage.setCache(STUDIO_EVENTS_CACHE_KEY, next).catch(() => undefined);
    return mapped;
  },

  deleteEvent: async (eventId) => {
    const isStudio = get().studioEvents.some((e) => e.id === eventId);
    if (isStudio) {
      await orbitServerApi.deleteStudioCalendarEvent(eventId);
      const next = get().studioEvents.filter((e) => e.id !== eventId);
      set({ studioEvents: next });
      void getOrbitClient().storage.setCache(STUDIO_EVENTS_CACHE_KEY, next).catch(() => undefined);
      return;
    }
    await getOrbitClient().calendar.deleteEvent(eventId);
    await get().loadSnapshot();
  },

  upsertTask: async (input) => {
    const saved = await getOrbitClient().calendar.upsertTask(input);
    await get().loadSnapshot();
    return saved;
  },

  toggleTask: async (taskId, completed) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, completed, completedAt: completed ? Date.now() : null } : t,
      ),
    }));
    await getOrbitClient().calendar.toggleTask(taskId, completed);
    await get().loadSnapshot();
  },

  deleteTask: async (taskId) => {
    await getOrbitClient().calendar.deleteTask(taskId);
    await get().loadSnapshot();
  },

  saveSubscription: async (input) => {
    const result = await getOrbitClient().calendar.saveSubscription(input);
    await get().loadSnapshot();
    return result;
  },

  refreshSubscription: async (subscriptionId) => {
    set((s) => ({
      syncingSubscriptionIds: s.syncingSubscriptionIds.includes(subscriptionId)
        ? s.syncingSubscriptionIds
        : [...s.syncingSubscriptionIds, subscriptionId],
    }));
    try {
      const result = await getOrbitClient().calendar.refreshSubscription(subscriptionId);
      await get().loadSnapshot();
      return result;
    } finally {
      set((s) => ({
        syncingSubscriptionIds: s.syncingSubscriptionIds.filter((id) => id !== subscriptionId),
      }));
    }
  },

  setSubscriptionVisible: async (subscriptionId, visible) => {
    set((s) => ({
      subscriptions: s.subscriptions.map((sub) =>
        sub.id === subscriptionId ? { ...sub, visible } : sub,
      ),
    }));
    await getOrbitClient().calendar.setSubscriptionVisible(subscriptionId, visible);
  },

  deleteSubscription: async (subscriptionId) => {
    await getOrbitClient().calendar.deleteSubscription(subscriptionId);
    await get().loadSnapshot();
  },

  importIcsFile: async (input) => {
    const result = await getOrbitClient().calendar.importIcsFile(input);
    if (!result.canceled) {
      await get().loadSnapshot();
    }
    return result;
  },
}));
