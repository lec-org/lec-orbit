/**
 * Orbit 统一日历（日程 + 待办任务 + 课程融合）共享领域层：
 * - 定义自定义日历分组、日程事件、待办任务的 Zod Schema 与默认配色
 * - 提供月历网格构建、按日期展开课表、跨日日程判定、连续时间轴重叠分栏算法与日程/任务统一提醒引擎
 */
import { z } from 'zod';
import {
  computeWeekFromStartDate,
  formatLocalDate,
  parseLocalDate,
  resolveMeetingTimeRange,
  timeToMinutes,
  type ScheduleCourseWithMeetings,
  type ScheduleDetail,
  type ScheduleMeeting,
} from './schedule';

export const CALENDAR_COLOR_PALETTE = [
  '#2563EB', // 飞书蓝
  '#7C3AED', // 优雅紫
  '#10B981', // 翡翠绿
  '#F59E0B', // 琥珀橙
  '#EF4444', // 珊瑚红
  '#06B6D4', // 冰川青
  '#EC4899', // 玫瑰粉
  '#6366F1', // 靛青蓝
] as const;

export const DEFAULT_PERSONAL_CALENDAR_ID = 'cal_personal';
export const DEFAULT_STUDIO_CALENDAR_ID = 'cal_studio';
export const DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID = 'sub_cn_holidays';

export const CalendarViewModeSchema = z.enum(['schedule', 'day', 'week', 'month']);
export type CalendarViewMode = z.infer<typeof CalendarViewModeSchema>;

export const CalendarSubscriptionKindSchema = z.enum(['cn-holiday', 'ics-url']);
export type CalendarSubscriptionKind = z.infer<typeof CalendarSubscriptionKindSchema>;

export const CalendarSubscriptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, '订阅日历名称不能为空').max(40),
  kind: CalendarSubscriptionKindSchema,
  url: z.string().default(''),
  color: z.string().min(4).max(32),
  visible: z.boolean().default(true),
  isBuiltin: z.boolean().default(false),
  lastSyncedAt: z.number().int().nullable().default(null),
  lastError: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
});
export type CalendarSubscription = z.infer<typeof CalendarSubscriptionSchema>;

export const SaveCalendarSubscriptionInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, '请输入订阅日历名称').max(40),
  url: z.string().trim().min(1, '请输入订阅地址'),
  color: z.string().min(4).max(32).default(CALENDAR_COLOR_PALETTE[3]),
  visible: z.boolean().optional().default(true),
});
export type SaveCalendarSubscriptionInput = z.input<typeof SaveCalendarSubscriptionInputSchema>;

export const CalendarSubscriptionItemSchema = z.object({
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  uid: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  location: z.string().default(''),
  allDay: z.boolean().default(true),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).default('23:59'),
  badge: z.enum(['off', 'work']).nullable().default(null),
});
export type CalendarSubscriptionItem = z.infer<typeof CalendarSubscriptionItemSchema>;

export const ImportIcsFileInputSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.string().min(4).max(32).optional(),
});
export type ImportIcsFileInput = z.input<typeof ImportIcsFileInputSchema>;

export interface ImportIcsFileResult {
  canceled: boolean;
  category?: CalendarCategory;
  importedCount?: number;
}

export const CalendarCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, '日历名称不能为空').max(40),
  color: z.string().min(4).max(32),
  visible: z.boolean().default(true),
  isBuiltin: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
});
export type CalendarCategory = z.infer<typeof CalendarCategorySchema>;

export const SaveCalendarCategoryInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, '请输入日历名称').max(40),
  color: z.string().min(4).max(32).default(CALENDAR_COLOR_PALETTE[0]),
  visible: z.boolean().optional().default(true),
});
export type SaveCalendarCategoryInput = z.input<typeof SaveCalendarCategoryInputSchema>;

export type AttendeeResponseStatus = 'accepted' | 'tentative' | 'declined';

export const CalendarEventSchema = z.object({
  id: z.string().min(1),
  calendarId: z.string().min(1),
  title: z.string().trim().min(1, '日程标题不能为空').max(120),
  description: z.string().max(1000).default(''),
  location: z.string().max(120).default(''),
  allDay: z.boolean().default(false),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '开始日期须为 YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '结束日期须为 YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).default('10:00'),
  reminderMinutes: z.number().int().min(0).max(1440).nullable().default(15),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
  /** 日程来源：local 为本地私有日程，studio 为工作室共享云端日程 */
  source: z.enum(['local', 'studio']).optional(),
  creatorId: z.string().optional(),
  creatorName: z.string().optional(),
  creatorAvatar: z.string().optional(),
  /** 指定受邀成员 userId 列表（与 attendeeGrades 均为空时表示全员） */
  attendeeUserIds: z.array(z.string()).optional(),
  /** 按年级批量邀请的入学年份（如 [2023, 2024]） */
  attendeeGrades: z.array(z.number().int()).optional(),
  /** 成员回复状态映射 */
  attendeeResponses: z.record(z.string(), z.enum(['accepted', 'tentative', 'declined'])).optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const UpsertCalendarEventInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    calendarId: z.string().min(1).default(DEFAULT_PERSONAL_CALENDAR_ID),
    title: z.string().trim().min(1, '请输入日程标题').max(120),
    description: z.string().max(1000).optional().default(''),
    location: z.string().max(120).optional().default(''),
    allDay: z.boolean().optional().default(false),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional().default('09:00'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional().default('10:00'),
    reminderMinutes: z.number().int().min(0).max(1440).nullable().optional().default(15),
    attendeeUserIds: z.array(z.string()).optional(),
    attendeeGrades: z.array(z.number().int()).optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, '结束日期不能早于开始日期');
export type UpsertCalendarEventInput = z.input<typeof UpsertCalendarEventInputSchema>;

export const CalendarTaskPrioritySchema = z.enum(['low', 'medium', 'high']);
export type CalendarTaskPriority = z.infer<typeof CalendarTaskPrioritySchema>;

export const CalendarTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1, '任务标题不能为空').max(120),
  description: z.string().max(1000).default(''),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
  priority: CalendarTaskPrioritySchema.default('medium'),
  completed: z.boolean().default(false),
  completedAt: z.number().int().nullable().default(null),
  reminderMinutes: z.number().int().min(0).max(1440).nullable().default(15),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
});
export type CalendarTask = z.infer<typeof CalendarTaskSchema>;

export const UpsertCalendarTaskInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().min(1, '请输入任务标题').max(120),
  description: z.string().max(1000).optional().default(''),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().default(null),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional().default(null),
  priority: CalendarTaskPrioritySchema.optional().default('medium'),
  completed: z.boolean().optional().default(false),
  reminderMinutes: z.number().int().min(0).max(1440).nullable().optional().default(15),
});
export type UpsertCalendarTaskInput = z.input<typeof UpsertCalendarTaskInputSchema>;

export interface CalendarSnapshot {
  categories: CalendarCategory[];
  events: CalendarEvent[];
  tasks: CalendarTask[];
  subscriptions: CalendarSubscription[];
  subscriptionItems: CalendarSubscriptionItem[];
}

// ───────────────────────────────────────────────────────────────────────────
// 月历网格 & 日期查询工具
// ───────────────────────────────────────────────────────────────────────────

export interface MonthGridCell {
  dateStr: string;
  year: number;
  month: number;
  day: number;
  /** ISO 星期：1=周一 ... 7=周日 */
  dayOfWeek: number;
  isCurrentMonth: boolean;
  isToday: boolean;
}

/**
 * 构建整月日历格子（固定 42 格 = 6 行 × 7 列，便于迷你月历与大月历稳定不跳动；
 * 当最后一行完全属于下月且希望紧凑时可传 compact=true 返回 35 格）。
 */
export function buildMonthGrid(
  year: number,
  month: number, // 1-12
  weekStartDay: 1 | 7 = 1,
  now: Date = new Date(),
  compact = false,
): MonthGridCell[] {
  const firstDay = new Date(year, month - 1, 1);
  const firstJsDay = firstDay.getDay(); // 0=日..6=六
  const leading = weekStartDay === 7 ? firstJsDay : (firstJsDay + 6) % 7;
  const start = new Date(year, month - 1, 1 - leading);
  const todayStr = formatLocalDate(now);

  const cells: MonthGridCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const jsDay = d.getDay();
    const isoDay = jsDay === 0 ? 7 : jsDay;
    const dateStr = formatLocalDate(d);
    cells.push({
      dateStr,
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      dayOfWeek: isoDay,
      isCurrentMonth: d.getFullYear() === year && d.getMonth() + 1 === month,
      isToday: dateStr === todayStr,
    });
  }

  if (compact && cells.slice(35).every((c) => !c.isCurrentMonth)) {
    return cells.slice(0, 35);
  }
  return cells;
}

/** 判断某日程是否覆盖指定日期（支持跨多天事件） */
export function eventCoversDate(event: Pick<CalendarEvent, 'startDate' | 'endDate'>, dateStr: string): boolean {
  const end = event.endDate >= event.startDate ? event.endDate : event.startDate;
  return event.startDate <= dateStr && dateStr <= end;
}

export interface ExpandedCourseOccurrence {
  dateStr: string;
  week: number;
  course: ScheduleCourseWithMeetings;
  meeting: ScheduleMeeting;
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
}

/** 展开指定日期对应的全部课程安排（自动处理学期周次范围与节假日跳过） */
export function expandCoursesForDate(
  detail: ScheduleDetail | null,
  dateStr: string,
  extraOffDates?: ReadonlySet<string>,
): ExpandedCourseOccurrence[] {
  if (!detail) return [];
  const { schedule, timetable, courses } = detail;
  if (schedule.holidays.includes(dateStr) || extraOffDates?.has(dateStr)) return [];

  const dateObj = parseLocalDate(dateStr);
  if (Number.isNaN(dateObj.getTime())) return [];

  const week = computeWeekFromStartDate(schedule.startDate, dateObj, schedule.weekStartDay);
  if (week < 1 || week > schedule.totalWeeks) return [];

  const jsDay = dateObj.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const out: ExpandedCourseOccurrence[] = [];

  for (const course of courses) {
    for (const meeting of course.meetings) {
      if (meeting.dayOfWeek !== isoDay) continue;
      if (!meeting.weeks.includes(week)) continue;
      const { startTime, endTime } = resolveMeetingTimeRange(meeting, timetable);
      const startMinutes = timeToMinutes(startTime) ?? 8 * 60;
      const endMinutes = Math.max(startMinutes + 30, timeToMinutes(endTime) ?? startMinutes + 45);
      out.push({
        dateStr,
        week,
        course,
        meeting,
        startTime,
        endTime,
        startMinutes,
        endMinutes,
      });
    }
  }

  out.sort((a, b) => a.startMinutes - b.startMinutes || a.meeting.startSection - b.meeting.startSection);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 连续时间轴重叠分栏布局算法（供周视图与日视图共用）
// ───────────────────────────────────────────────────────────────────────────

export interface TimeBlockInput {
  id: string;
  startMinutes: number;
  endMinutes: number;
}

export interface TimeBlockLayout {
  id: string;
  col: number;
  colCount: number;
}

/**
 * 将同一天内有时间交集的时间块（课程 / 日程 / 定时任务）按连通冲突组自动分列，
 * 保证任意冲突块并排显示且不重叠遮挡。
 */
export function layoutOverlappingBlocks(blocks: TimeBlockInput[]): Map<string, TimeBlockLayout> {
  const result = new Map<string, TimeBlockLayout>();
  if (blocks.length === 0) return result;

  const sorted = [...blocks].sort(
    (a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes,
  );

  // 先划分为互不相交的冲突连通簇
  const clusters: TimeBlockInput[][] = [];
  let currentCluster: TimeBlockInput[] = [];
  let clusterEnd = -1;

  for (const block of sorted) {
    const safeEnd = Math.max(block.startMinutes + 15, block.endMinutes);
    if (currentCluster.length === 0 || block.startMinutes < clusterEnd) {
      currentCluster.push({ ...block, endMinutes: safeEnd });
      clusterEnd = Math.max(clusterEnd, safeEnd);
    } else {
      clusters.push(currentCluster);
      currentCluster = [{ ...block, endMinutes: safeEnd }];
      clusterEnd = safeEnd;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // 每个簇内贪心分配最小可用列号
  for (const cluster of clusters) {
    const colEndTimes: number[] = [];
    const placements: Array<{ id: string; col: number }> = [];

    for (const block of cluster) {
      let placedCol = -1;
      for (let c = 0; c < colEndTimes.length; c += 1) {
        if (colEndTimes[c]! <= block.startMinutes) {
          placedCol = c;
          colEndTimes[c] = block.endMinutes;
          break;
        }
      }
      if (placedCol === -1) {
        placedCol = colEndTimes.length;
        colEndTimes.push(block.endMinutes);
      }
      placements.push({ id: block.id, col: placedCol });
    }

    const colCount = Math.max(1, colEndTimes.length);
    for (const p of placements) {
      result.set(p.id, { id: p.id, col: p.col, colCount });
    }
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// 日程与任务统一提醒决策器
// ───────────────────────────────────────────────────────────────────────────

export interface CalendarReminderInput {
  now: Date;
  events: CalendarEvent[];
  tasks: CalendarTask[];
  sentKeys: ReadonlySet<string>;
}

export interface CalendarReminderNotice {
  key: string;
  kind: 'event' | 'task';
  title: string;
  body: string;
}

/**
 * 评估当前分钟内所有需要发出的日程提醒或定时任务截止提醒：
 * - 跨天日程仅在开始日（startDate === todayStr）触发提醒，避免次日重复误报；
 * - 返回当前分钟全部待发提醒列表，避免同分钟多条「准时提醒」被漏报。
 */
export function evaluateCalendarReminders(
  input: CalendarReminderInput,
): CalendarReminderNotice[] {
  const { now, events, tasks, sentKeys } = input;
  const todayStr = formatLocalDate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const notices: CalendarReminderNotice[] = [];

  for (const ev of events) {
    if (ev.allDay || ev.reminderMinutes == null) continue;
    // 仅在日程开始日提醒，防止跨天日程在次日同一时间再次误发提醒
    if (ev.startDate !== todayStr) continue;
    const startMin = timeToMinutes(ev.startTime);
    if (startMin == null) continue;
    const diff = startMin - nowMinutes;
    if (diff >= 0 && diff <= ev.reminderMinutes) {
      const key = `event:${ev.id}:${todayStr}:${ev.startTime}`;
      if (sentKeys.has(key)) continue;
      notices.push({
        key,
        kind: 'event',
        title: diff === 0 ? `日程开始：${ev.title}` : `${diff} 分钟后日程：${ev.title}`,
        body: [
          `${ev.startTime}–${ev.endTime}`,
          ev.location ? `地点：${ev.location}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      });
    }
  }

  for (const task of tasks) {
    if (task.completed || !task.dueDate || !task.dueTime || task.reminderMinutes == null) continue;
    if (task.dueDate !== todayStr) continue;
    const dueMin = timeToMinutes(task.dueTime);
    if (dueMin == null) continue;
    const diff = dueMin - nowMinutes;
    if (diff >= 0 && diff <= task.reminderMinutes) {
      const key = `task:${task.id}:${todayStr}:${task.dueTime}`;
      if (sentKeys.has(key)) continue;
      notices.push({
        key,
        kind: 'task',
        title: diff === 0 ? `任务截止：${task.title}` : `任务即将截止（${diff} 分钟后）：${task.title}`,
        body: `截止时间 ${task.dueTime}${task.description ? ` · ${task.description.slice(0, 60)}` : ''}`,
      });
    }
  }

  return notices;
}

/** 兼容单条提醒读取接口，默认返回当前分钟第一条待发提醒。 */
export function evaluateCalendarReminder(
  input: CalendarReminderInput,
): CalendarReminderNotice | null {
  return evaluateCalendarReminders(input)[0] ?? null;
}
