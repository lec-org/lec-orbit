/** 课程表模块独立 Zustand 状态仓库：管理多课表、时间表、当前查看周次与西柚导入态。 */
import { create } from 'zustand';
import {
  INITIAL_SWPU_IMPORT_STATE,
  computeWeekFromStartDate,
  type ApplySwpuImportInput,
  type CreateScheduleInput,
  type SaveTimetableInput,
  type ScheduleDetail,
  type ScheduleSummary,
  type ScheduleTimetable,
  type SwpuImportWindowState,
  type SwpuNetworkMode,
  type UpdateScheduleInput,
  type UpsertCourseInput,
} from '@shared/schedule';
import { getOrbitClient } from '@/services/orbitClient';

interface ScheduleStoreState {
  loading: boolean;
  loaded: boolean;
  /** 最近一次成功加载课表时对应的账号 subject，防切号串数据上报。 */
  loadedSubject: string | null;
  schedules: ScheduleSummary[];
  timetables: ScheduleTimetable[];
  activeDetail: ScheduleDetail | null;
  viewingWeek: number;
  importState: SwpuImportWindowState;
  /** 导课成功后弹出的开机/开学日期确认引导 */
  importSuccessNotice: {
    open: boolean;
    scheduleName: string;
    startDate: string;
    courseCount: number;
    meetingCount: number;
  } | null;

  /** 登出或切换账号时彻底重置课表内存态。 */
  reset: () => void;
  loadAll: (preferredScheduleId?: string, options?: { forceRecalcWeek?: boolean }) => Promise<void>;
  setViewingWeek: (week: number) => void;
  jumpToCurrentWeek: () => void;
  setImportState: (state: SwpuImportWindowState) => void;
  dismissImportSuccessNotice: () => void;

  selectSchedule: (scheduleId: string) => Promise<void>;
  createSchedule: (input: CreateScheduleInput) => Promise<ScheduleSummary>;
  updateSchedule: (input: UpdateScheduleInput) => Promise<void>;
  deleteSchedule: (scheduleId: string) => Promise<void>;
  clearCourses: (scheduleId: string) => Promise<void>;
  upsertCourse: (input: UpsertCourseInput) => Promise<void>;
  deleteCourses: (scheduleId: string, courseIds: string[]) => Promise<void>;
  saveTimetable: (input: SaveTimetableInput) => Promise<ScheduleTimetable>;

  openSwpuImport: (options?: { networkMode?: SwpuNetworkMode; clearSession?: boolean }) => Promise<void>;
  fetchSwpuSchedule: (termCode?: string) => Promise<void>;
  closeSwpuImport: () => Promise<void>;
  applySwpuImport: (input: ApplySwpuImportInput) => Promise<ScheduleDetail>;
  importShareJson: (rawJson: string) => Promise<{ ok: boolean; message?: string }>;
}

function clampWeek(week: number, totalWeeks: number): number {
  return Math.max(1, Math.min(Math.max(1, totalWeeks), week));
}

let scheduleLoadSeq = 0;

export const useScheduleStore = create<ScheduleStoreState>((set, get) => ({
  loading: false,
  loaded: false,
  loadedSubject: null,
  schedules: [],
  timetables: [],
  activeDetail: null,
  viewingWeek: 1,
  importState: INITIAL_SWPU_IMPORT_STATE,
  importSuccessNotice: null,

  reset: () => {
    scheduleLoadSeq += 1;
    set({
      loading: false,
      loaded: false,
      loadedSubject: null,
      schedules: [],
      timetables: [],
      activeDetail: null,
      viewingWeek: 1,
      importState: INITIAL_SWPU_IMPORT_STATE,
      importSuccessNotice: null,
    });
  },

  loadAll: async (preferredScheduleId, options) => {
    const reqSeq = ++scheduleLoadSeq;
    set({ loading: true });
    try {
      const client = getOrbitClient();
      const api = client.schedule;
      const [schedules, timetables, detail, importState, authState] = await Promise.all([
        api.listSchedules(),
        api.listTimetables(),
        api.getDetail(preferredScheduleId),
        api.getImportState(),
        client.auth.getState().catch(() => null),
      ]);
      if (reqSeq !== scheduleLoadSeq) return;

      const resolvedSubject = authState?.authenticated ? (authState.profile?.subject ?? null) : null;
      const prevDetail = get().activeDetail;
      let nextWeek = get().viewingWeek;
      if (detail) {
        const shouldResetWeek =
          Boolean(options?.forceRecalcWeek) ||
          !get().loaded ||
          prevDetail?.schedule.id !== detail.schedule.id ||
          prevDetail?.schedule.startDate !== detail.schedule.startDate ||
          prevDetail?.schedule.weekStartDay !== detail.schedule.weekStartDay;
        if (shouldResetWeek) {
          const computed = computeWeekFromStartDate(
            detail.schedule.startDate,
            new Date(),
            detail.schedule.weekStartDay,
          );
          nextWeek = clampWeek(computed, detail.schedule.totalWeeks);
        } else {
          nextWeek = clampWeek(nextWeek, detail.schedule.totalWeeks);
        }
      } else {
        nextWeek = 1;
      }

      set({
        loading: false,
        loaded: true,
        loadedSubject: resolvedSubject,
        schedules,
        timetables,
        activeDetail: detail,
        viewingWeek: nextWeek,
        importState,
      });
    } catch {
      if (reqSeq !== scheduleLoadSeq) return;
      // 加载异常时不标记 loaded=true，防止页面把空课表快照误上报覆盖云端
      set({ loading: false });
    }
  },

  setViewingWeek: (week) => {
    const total = get().activeDetail?.schedule.totalWeeks ?? 20;
    set({ viewingWeek: clampWeek(week, total) });
  },

  jumpToCurrentWeek: () => {
    const detail = get().activeDetail;
    if (!detail) return;
    const computed = computeWeekFromStartDate(
      detail.schedule.startDate,
      new Date(),
      detail.schedule.weekStartDay,
    );
    set({ viewingWeek: clampWeek(computed, detail.schedule.totalWeeks) });
  },

  setImportState: (importState) => set({ importState }),

  dismissImportSuccessNotice: () => set({ importSuccessNotice: null }),

  selectSchedule: async (scheduleId) => {
    await getOrbitClient().schedule.setActiveSchedule(scheduleId);
    await get().loadAll(scheduleId);
  },

  createSchedule: async (input) => {
    const created = await getOrbitClient().schedule.createSchedule(input);
    await get().loadAll(created.id);
    return created;
  },

  updateSchedule: async (input) => {
    await getOrbitClient().schedule.updateSchedule(input);
    const dateChanged = input.startDate !== undefined || input.weekStartDay !== undefined;
    await get().loadAll(input.id, { forceRecalcWeek: dateChanged });
  },

  deleteSchedule: async (scheduleId) => {
    await getOrbitClient().schedule.deleteSchedule(scheduleId);
    await get().loadAll();
  },

  clearCourses: async (scheduleId) => {
    await getOrbitClient().schedule.clearCourses(scheduleId);
    await get().loadAll(scheduleId);
  },

  upsertCourse: async (input) => {
    await getOrbitClient().schedule.upsertCourse(input);
    await get().loadAll(input.scheduleId);
  },

  deleteCourses: async (scheduleId, courseIds) => {
    await getOrbitClient().schedule.deleteCourses(scheduleId, courseIds);
    await get().loadAll(scheduleId);
  },

  saveTimetable: async (input) => {
    const saved = await getOrbitClient().schedule.saveTimetable(input);
    await get().loadAll(get().activeDetail?.schedule.id);
    return saved;
  },

  openSwpuImport: async (options) => {
    const state = await getOrbitClient().schedule.openSwpuImport(options);
    set({ importState: state });
  },

  fetchSwpuSchedule: async (termCode) => {
    const state = await getOrbitClient().schedule.fetchSwpuSchedule(termCode);
    set({ importState: state });
  },

  closeSwpuImport: async () => {
    const state = await getOrbitClient().schedule.closeSwpuImport();
    set({ importState: state });
  },

  applySwpuImport: async (input) => {
    const detail = await getOrbitClient().schedule.applySwpuImport(input);
    await get().loadAll(detail.schedule.id);
    set({
      importSuccessNotice: {
        open: true,
        scheduleName: detail.schedule.name,
        startDate: detail.schedule.startDate,
        courseCount: detail.schedule.courseCount,
        meetingCount: detail.schedule.meetingCount,
      },
    });
    return detail;
  },

  importShareJson: async (rawJson) => {
    const res = await getOrbitClient().schedule.importShareJson(rawJson);
    if (res.ok && res.detail) {
      await get().loadAll(res.detail.schedule.id);
      return { ok: true };
    }
    return { ok: false, message: res.message || '导入失败' };
  },
}));
