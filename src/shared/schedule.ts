/**
 * Orbit 课程表共享领域层（零 Electron/React 耦合，可供主进程、渲染进程与单元测试共用）：
 * - 定义时间表、多课表、聚合课程、排课时间段的 Zod Schema 与类型
 * - 提供西南石油大学（SWPU）金智 EMAP 课表解析器与默认作息时间表
 * - 提供开学日期/周次双向计算、单双周/跳周压缩与解析、RFC 5545 .ics 导出、分享包编解码与课前提醒决策
 */
import { z } from 'zod';

/** 西南石油大学统一身份认证直达本科教学服务平台入口 */
export const SWPU_SSO_LOGIN_URL =
  'https://sso.swpu.edu.cn/login?service=https:%2F%2Fdeanservices.swpu.edu.cn%2Fjwapp%2Fsys%2Fhomeapp%2Findex.do';

export const SWPU_WEBVPN_LOGIN_URL = 'https://vpn.swpu.edu.cn:8118/';

export const SWPU_DEAN_ORIGIN = 'https://deanservices.swpu.edu.cn';

/** 12 组柔和、明暗主题均清晰可读的课程色板 */
export const COURSE_COLOR_PALETTE = [
  '#4F8EF7', // 晴空蓝
  '#8B6CE8', // 薰衣草紫
  '#2FA89B', // 湖泊青
  '#E67E45', // 暖橙
  '#E05D8E', // 玫瑰粉
  '#52A85A', // 森林绿
  '#5C7CE6', // 靛青
  '#D48E2A', // 琥珀金
  '#B665D9', // 丁香紫
  '#2E94C4', // 冰川蓝
  '#D6635E', // 珊瑚红
  '#6E8C4A', // 橄榄绿
] as const;

export const TimetableSlotSchema = z.object({
  section: z.number().int().min(1).max(24),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, '时间格式须为 HH:mm'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, '时间格式须为 HH:mm'),
});
export type TimetableSlot = z.infer<typeof TimetableSlotSchema>;

/** 西南石油大学（成都校区）标准单节 45 分钟作息时间表（1–12 节） */
export const SWPU_CHENGDU_DEFAULT_SLOTS: TimetableSlot[] = [
  { section: 1, startTime: '08:00', endTime: '08:45' },
  { section: 2, startTime: '08:50', endTime: '09:35' },
  { section: 3, startTime: '09:50', endTime: '10:35' },
  { section: 4, startTime: '10:40', endTime: '11:25' },
  { section: 5, startTime: '11:30', endTime: '12:15' },
  { section: 6, startTime: '14:30', endTime: '15:15' },
  { section: 7, startTime: '15:20', endTime: '16:05' },
  { section: 8, startTime: '16:20', endTime: '17:05' },
  { section: 9, startTime: '17:10', endTime: '17:55' },
  { section: 10, startTime: '19:00', endTime: '19:45' },
  { section: 11, startTime: '19:50', endTime: '20:35' },
  { section: 12, startTime: '20:40', endTime: '21:25' },
];

export const DEFAULT_TIMETABLE_ID = 'swpu-chengdu-default';
export const DEFAULT_TIMETABLE_NAME = '西南石油大学（成都校区）';

export const ScheduleTimetableSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, '时间表名称不能为空').max(60),
  fixedDurationEnabled: z.boolean().default(true),
  defaultDurationMinutes: z.number().int().min(15).max(180).default(45),
  slots: z.array(TimetableSlotSchema).min(1).max(24),
  updatedAt: z.number().int().default(0),
});
export type ScheduleTimetable = z.infer<typeof ScheduleTimetableSchema>;

export const SaveTimetableInputSchema = ScheduleTimetableSchema.omit({ updatedAt: true }).extend({
  id: z.string().min(1).optional(),
});
export type SaveTimetableInput = z.input<typeof SaveTimetableInputSchema>;

export const ScheduleSourceSchema = z.enum(['swpu_wisedu', 'manual', 'share_json', 'ics']);
export type ScheduleSource = z.infer<typeof ScheduleSourceSchema>;

export const ScheduleSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, '课表名称不能为空').max(60),
  termCode: z.string().max(40).default(''),
  timetableId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD'),
  weekStartDay: z.union([z.literal(1), z.literal(7)]).default(1),
  totalWeeks: z.number().int().min(1).max(30).default(20),
  maxSections: z.number().int().min(8).max(24).default(12),
  compactMode: z.boolean().default(false),
  reminderEnabled: z.boolean().default(true),
  reminderMinutes: z.number().int().min(5).max(60).default(15),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  isActive: z.boolean().default(false),
  courseCount: z.number().int().min(0).default(0),
  meetingCount: z.number().int().min(0).default(0),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export const CreateScheduleInputSchema = z.object({
  name: z.string().trim().min(1, '请输入课表名称').max(60),
  termCode: z.string().max(40).optional().default(''),
  timetableId: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weekStartDay: z.union([z.literal(1), z.literal(7)]).optional().default(1),
  totalWeeks: z.number().int().min(1).max(30).optional().default(20),
  maxSections: z.number().int().min(8).max(24).optional().default(12),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().default([]),
  setActive: z.boolean().optional().default(true),
});
export type CreateScheduleInput = z.input<typeof CreateScheduleInputSchema>;

export const UpdateScheduleInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60).optional(),
  termCode: z.string().max(40).optional(),
  timetableId: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weekStartDay: z.union([z.literal(1), z.literal(7)]).optional(),
  totalWeeks: z.number().int().min(1).max(30).optional(),
  maxSections: z.number().int().min(8).max(24).optional(),
  compactMode: z.boolean().optional(),
  reminderEnabled: z.boolean().optional(),
  reminderMinutes: z.number().int().min(5).max(60).optional(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;

export const ScheduleMeetingSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  courseId: z.string().min(1),
  teacher: z.string().max(80).default(''),
  location: z.string().max(120).default(''),
  campus: z.string().max(60).default(''),
  dayOfWeek: z.number().int().min(1).max(7),
  startSection: z.number().int().min(1).max(24),
  endSection: z.number().int().min(1).max(24),
  startTimeOverride: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTimeOverride: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weeks: z.array(z.number().int().min(1).max(30)).min(1),
  weeksText: z.string().max(100).default(''),
  isAdjusted: z.boolean().default(false),
  source: ScheduleSourceSchema.default('manual'),
});
export type ScheduleMeeting = z.infer<typeof ScheduleMeetingSchema>;

export const ScheduleCourseSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  name: z.string().trim().min(1, '课程名称不能为空').max(100),
  courseCode: z.string().max(60).default(''),
  credit: z.number().min(0).max(30).nullable().default(null),
  category: z.string().max(60).default(''),
  color: z.string().min(4).max(32),
  note: z.string().max(500).default(''),
  updatedAt: z.number().int().default(0),
});
export type ScheduleCourse = z.infer<typeof ScheduleCourseSchema>;

export interface ScheduleCourseWithMeetings extends ScheduleCourse {
  meetings: ScheduleMeeting[];
}

export interface ScheduleDetail {
  schedule: ScheduleSummary;
  timetable: ScheduleTimetable;
  courses: ScheduleCourseWithMeetings[];
}

export const UpsertMeetingDraftSchema = z
  .object({
    id: z.string().min(1).optional(),
    teacher: z.string().max(80).default(''),
    location: z.string().max(120).default(''),
    campus: z.string().max(60).default(''),
    dayOfWeek: z.number().int().min(1).max(7),
    startSection: z.number().int().min(1).max(24),
    endSection: z.number().int().min(1).max(24),
    startTimeOverride: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTimeOverride: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weeks: z.array(z.number().int().min(1).max(30)).min(1, '请至少选择 1 个上课周次'),
    weeksText: z.string().max(100).optional(),
    isAdjusted: z.boolean().optional().default(false),
    source: ScheduleSourceSchema.optional().default('manual'),
  })
  .refine((v) => v.endSection >= v.startSection, '结束节次不能小于开始节次');
export type UpsertMeetingDraft = z.infer<typeof UpsertMeetingDraftSchema>;

export const UpsertCourseInputSchema = z.object({
  scheduleId: z.string().min(1),
  courseId: z.string().min(1).optional(),
  name: z.string().trim().min(1, '请输入课程名称').max(100),
  courseCode: z.string().max(60).optional().default(''),
  credit: z.number().min(0).max(30).nullable().optional().default(null),
  category: z.string().max(60).optional().default(''),
  color: z.string().min(4).max(32).optional(),
  note: z.string().max(500).optional().default(''),
  meetings: z.array(UpsertMeetingDraftSchema).min(1, '请至少添加 1 个上课时间段'),
});
export type UpsertCourseInput = z.input<typeof UpsertCourseInputSchema>;

export interface ParsedCourseDraft {
  name: string;
  courseCode: string;
  credit: number | null;
  category: string;
  color: string;
  note: string;
  meetings: Array<{
    teacher: string;
    location: string;
    campus: string;
    dayOfWeek: number;
    startSection: number;
    endSection: number;
    startTimeOverride?: string;
    endTimeOverride?: string;
    weeks: number[];
    weeksText: string;
    isAdjusted: boolean;
    source: ScheduleSource;
  }>;
}

export interface SwpuTermOption {
  code: string;
  name: string;
  selected: boolean;
}

export interface SwpuImportPreview {
  termCode: string;
  termName: string;
  terms: SwpuTermOption[];
  inferredStartDate: string;
  currentClassWeek: number | null;
  campus: string;
  holidays: string[];
  courseCount: number;
  meetingCount: number;
  courses: ParsedCourseDraft[];
}

export type SwpuImportStage =
  | 'idle'
  | 'opening'
  | 'waiting_login'
  | 'fetching'
  | 'ready'
  | 'error';

export type SwpuNetworkMode = 'direct' | 'system' | 'webvpn';

export interface SwpuImportWindowState {
  open: boolean;
  stage: SwpuImportStage;
  networkMode: SwpuNetworkMode;
  currentUrl: string;
  message: string;
  error?: string | null;
  preview: SwpuImportPreview | null;
}

export const INITIAL_SWPU_IMPORT_STATE: SwpuImportWindowState = {
  open: false,
  stage: 'idle',
  networkMode: 'system',
  currentUrl: SWPU_SSO_LOGIN_URL,
  message: '点击「打开西柚教务登录」完成西南石油大学统一身份认证',
  error: null,
  preview: null,
};

export const ApplySwpuImportInputSchema = z.object({
  mode: z.enum(['create', 'replace']),
  targetScheduleId: z.string().min(1).optional(),
  scheduleName: z.string().trim().min(1).max(60),
  termCode: z.string().max(40).default(''),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalWeeks: z.number().int().min(1).max(30).default(20),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  courses: z.array(
    z.object({
      name: z.string().trim().min(1).max(100),
      courseCode: z.string().max(60).default(''),
      credit: z.number().min(0).max(30).nullable().default(null),
      category: z.string().max(60).default(''),
      color: z.string().min(4).max(32),
      note: z.string().max(500).default(''),
      meetings: z.array(UpsertMeetingDraftSchema).min(1),
    }),
  ),
});
export type ApplySwpuImportInput = z.input<typeof ApplySwpuImportInputSchema>;

// ───────────────────────────────────────────────────────────────────────────
// 日期、周次与时间工具（纯本地日期运算，避免 UTC 时区偏移导致差一天）
// ───────────────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseLocalDate(dateStr: string): Date {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

export function addDaysLocal(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

/** 返回 date 所在周的起始日（周一或周日）的本地日期 */
export function getStartOfWeekLocal(date: Date, weekStartDay: 1 | 7 = 1): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const jsDay = d.getDay(); // 0=周日, 1=周一 ... 6=周六
  const offset = weekStartDay === 7 ? jsDay : (jsDay + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

/** 根据参考日期与当前教学周（如 2026-11-27 第 13 周），反推第 1 周第 1 天日期（如 2026-08-31） */
export function inferTermStartDate(
  referenceDate: Date | string,
  classWeek: number,
  weekStartDay: 1 | 7 = 1,
): string {
  const ref = typeof referenceDate === 'string' ? parseLocalDate(referenceDate) : referenceDate;
  const safeRef = Number.isNaN(ref.getTime()) ? new Date() : ref;
  const safeWeek = Math.max(1, Math.min(30, Math.floor(classWeek || 1)));
  const thisWeekStart = getStartOfWeekLocal(safeRef, weekStartDay);
  thisWeekStart.setDate(thisWeekStart.getDate() - (safeWeek - 1) * 7);
  return formatLocalDate(thisWeekStart);
}

/** 根据开学第一周第一天计算某天属于第几周（支持返回 <= 0 或 > totalWeeks，由调用方按需 clamp） */
export function computeWeekFromStartDate(
  startDate: string,
  now: Date = new Date(),
  weekStartDay: 1 | 7 = 1,
): number {
  const start = parseLocalDate(startDate);
  if (Number.isNaN(start.getTime())) return 1;
  const alignedStart = getStartOfWeekLocal(start, weekStartDay);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today.getTime() - alignedStart.getTime()) / 86_400_000);
  return Math.floor(diffDays / 7) + 1;
}

/** 用户在设置中调整「当前周」时，反推新的开学第一周第一天日期 */
export function computeStartDateFromWeek(
  targetWeek: number,
  now: Date = new Date(),
  weekStartDay: 1 | 7 = 1,
): string {
  return inferTermStartDate(now, targetWeek, weekStartDay);
}

export interface WeekDayColumn {
  /** ISO 星期：1=周一 ... 7=周日 */
  dayOfWeek: number;
  label: string;
  dateStr: string;
  month: number;
  dayOfMonth: number;
  isToday: boolean;
}

const WEEKDAY_LABELS: Record<number, string> = {
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '日',
};

export function getWeekdayName(dayOfWeek: number): string {
  return `周${WEEKDAY_LABELS[dayOfWeek] ?? '?'}`;
}

/** 计算指定周次的 7 天列头信息 */
export function getWeekDayColumns(
  startDate: string,
  week: number,
  weekStartDay: 1 | 7 = 1,
  now: Date = new Date(),
): WeekDayColumn[] {
  const start = parseLocalDate(startDate);
  const aligned = Number.isNaN(start.getTime())
    ? getStartOfWeekLocal(now, weekStartDay)
    : getStartOfWeekLocal(start, weekStartDay);
  const weekStart = new Date(aligned.getFullYear(), aligned.getMonth(), aligned.getDate() + (week - 1) * 7);
  const todayStr = formatLocalDate(now);
  const cols: WeekDayColumn[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    const jsDay = d.getDay();
    const isoDay = jsDay === 0 ? 7 : jsDay;
    const dateStr = formatLocalDate(d);
    cols.push({
      dayOfWeek: isoDay,
      label: WEEKDAY_LABELS[isoDay] ?? '',
      dateStr,
      month: d.getMonth() + 1,
      dayOfMonth: d.getDate(),
      isToday: dateStr === todayStr,
    });
  }
  return cols;
}

/** 计算 HH:mm 字符串加减分钟数，限定在 00:00~23:59 */
export function addMinutesToTime(hhmm: string, deltaMinutes: number): string {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return hhmm;
  const total = Math.max(0, Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]) + deltaMinutes));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function timeToMinutes(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 根据固定上课时长联动更新指定节次或全表结束时间 */
export function applyFixedDurationToSlot(
  slots: TimetableSlot[],
  section: number,
  newStartTime: string,
  durationMinutes: number,
  fixedDurationEnabled: boolean,
): TimetableSlot[] {
  return slots.map((slot) => {
    if (slot.section !== section) return slot;
    return {
      ...slot,
      startTime: newStartTime,
      endTime: fixedDurationEnabled ? addMinutesToTime(newStartTime, durationMinutes) : slot.endTime,
    };
  });
}

/** 补齐时间表节次到目标最大节数，确保网格左侧每一节都有合理起止时间 */
export function ensureSlotsUpTo(
  slots: TimetableSlot[],
  maxSections: number,
  defaultDurationMinutes = 45,
): TimetableSlot[] {
  const bySection = new Map<number, TimetableSlot>();
  for (const slot of slots) {
    bySection.set(slot.section, slot);
  }
  const result: TimetableSlot[] = [];
  for (let sec = 1; sec <= maxSections; sec += 1) {
    const existing = bySection.get(sec);
    if (existing) {
      result.push(existing);
      continue;
    }
    const defaultMatch = SWPU_CHENGDU_DEFAULT_SLOTS.find((s) => s.section === sec);
    if (defaultMatch) {
      result.push({ ...defaultMatch });
      continue;
    }
    const prev = result[result.length - 1];
    const startTime = prev ? addMinutesToTime(prev.endTime, 5) : '08:00';
    result.push({
      section: sec,
      startTime,
      endTime: addMinutesToTime(startTime, defaultDurationMinutes),
    });
  }
  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// 周次位图 / 文本解析与格式化
// ───────────────────────────────────────────────────────────────────────────

/** 将金智 SKZC 二进制位图（如 "00000000010100000000"）转为 1-based 递增周次数组 */
export function parseSkzcBitmap(skzc: unknown): number[] {
  if (typeof skzc !== 'string') return [];
  const trimmed = skzc.trim();
  if (!/^[01]+$/.test(trimmed)) return [];
  const weeks: number[] = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '1') weeks.push(i + 1);
  }
  return weeks;
}

/** 将用户输入的周次表达式（如 "1-9,11-16"、"2-12(双)"、"1-15单"）解析为有序去重周次数组 */
export function parseWeeksExpression(raw: string, maxWeeks = 30): number[] {
  const normalized = raw
    .replace(/[，、；;]/g, ',')
    .replace(/[～~—–]/g, '-')
    .replace(/周/g, '')
    .trim();
  if (!normalized) return [];

  const set = new Set<number>();
  for (const tokenRaw of normalized.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const isOdd = /单/.test(token);
    const isEven = /双/.test(token);
    const clean = token.replace(/[()（）单双\s]/g, '');
    const rangeMatch = clean.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = Math.max(1, Math.min(maxWeeks, Number(rangeMatch[1])));
      const b = Math.max(1, Math.min(maxWeeks, Number(rangeMatch[2])));
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let w = lo; w <= hi; w += 1) {
        if (isOdd && w % 2 === 0) continue;
        if (isEven && w % 2 === 1) continue;
        set.add(w);
      }
      continue;
    }
    const singleMatch = clean.match(/^(\d+)$/);
    if (singleMatch) {
      const w = Number(singleMatch[1]);
      if (w >= 1 && w <= maxWeeks) set.add(w);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** 将周次数组格式化为紧凑可读文案（如 "1-9周"、"10-12周(双)"、"11-12,14-18周"） */
export function formatWeeksCompact(weeks: number[]): string {
  const sorted = [...new Set(weeks.filter((w) => Number.isInteger(w) && w >= 1))].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `${sorted[0]}周`;

  // 检测纯等差步长 2 的单周或双周
  const allOdd = sorted.every((w) => w % 2 === 1);
  const allEven = sorted.every((w) => w % 2 === 0);
  if (allOdd || allEven) {
    let contiguousStep2 = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]! - sorted[i - 1]! !== 2) {
        contiguousStep2 = false;
        break;
      }
    }
    if (contiguousStep2) {
      return `${sorted[0]}-${sorted[sorted.length - 1]}周(${allOdd ? '单' : '双'})`;
    }
  }

  // 按连续区间合并
  const segments: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    if (cur === prev + 1) {
      prev = cur;
    } else {
      segments.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
      prev = cur;
    }
  }
  segments.push(start === prev ? `${start}` : `${start}-${prev}`);
  return `${segments.join(',')}周`;
}

// ───────────────────────────────────────────────────────────────────────────
// 西南石油大学金智 EMAP 课表解析器
// ───────────────────────────────────────────────────────────────────────────

function pickCourseColor(index: number, seedText: string): string {
  if (index >= 0 && index < COURSE_COLOR_PALETTE.length) {
    return COURSE_COLOR_PALETTE[index]!;
  }
  let hash = 0;
  for (let i = 0; i < seedText.length; i += 1) {
    hash = (hash * 31 + seedText.charCodeAt(i)) >>> 0;
  }
  return COURSE_COLOR_PALETTE[hash % COURSE_COLOR_PALETTE.length]!;
}

function normalizeTimeField(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const m = val.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return undefined;
  return `${pad2(Number(m[1]))}:${m[2]}`;
}

/**
 * 解析西南石油大学金智 EMAP `cxxszhxqkb.do` 的原始 rows 数组：
 * - 按 `课程号 + 课程名` 聚合成课程维度（与 WakeUp「已添课程」一致）
 * - 每条排课记录优先用 `SKZC` 二进制位图提取精确周次，缺失时回退解析 `ZCMC`
 * - 自动过滤无效/重复的时间段
 */
export function parseSwpuWiseduRows(rows: Array<Record<string, unknown>>): {
  courses: ParsedCourseDraft[];
  campus: string;
  courseCount: number;
  meetingCount: number;
} {
  const courseMap = new Map<string, ParsedCourseDraft>();
  const meetingDedup = new Set<string>();
  let detectedCampus = '';

  for (const row of rows) {
    const name = String(row.KCM ?? row.kcmc ?? '').trim();
    if (!name) continue;
    const courseCode = String(row.KCH ?? row.kch ?? '').trim();
    const dayOfWeek = Number(row.SKXQ ?? row.xqj ?? 0);
    const startSection = Number(row.KSJC ?? 0);
    const endSection = Number(row.JSJC ?? row.KSJC ?? 0);
    if (
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 1 ||
      dayOfWeek > 7 ||
      !Number.isInteger(startSection) ||
      startSection < 1 ||
      !Number.isInteger(endSection) ||
      endSection < startSection
    ) {
      continue;
    }

    const bitmapWeeks = parseSkzcBitmap(row.SKZC);
    const zcmc = String(row.ZCMC ?? '').trim();
    const weeks = bitmapWeeks.length > 0 ? bitmapWeeks : parseWeeksExpression(zcmc);
    if (weeks.length === 0) continue;

    const teacher = String(row.SKJS ?? row.xm ?? '').trim();
    const location = String(row.JASMC ?? row.cdmc ?? row.SKDD ?? '').trim();
    const campus = String(row.XXXQDM_DISPLAY ?? row.XQMC_DISPLAY ?? '').trim();
    if (!detectedCampus && campus) detectedCampus = campus;

    const creditNum = row.XF != null && row.XF !== '' ? Number(row.XF) : null;
    const credit = creditNum != null && Number.isFinite(creditNum) ? creditNum : null;
    const category = [row.KCXZDM_DISPLAY, row.KCLBDM_DISPLAY, row.KSLXDM_DISPLAY]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join(' · ');

    const courseKey = courseCode ? `${courseCode}::${name}` : name;
    let course = courseMap.get(courseKey);
    if (!course) {
      course = {
        name,
        courseCode,
        credit,
        category,
        color: pickCourseColor(courseMap.size, courseKey),
        note: '',
        meetings: [],
      };
      courseMap.set(courseKey, course);
    }

    const dedupKey = `${courseKey}|${dayOfWeek}|${startSection}-${endSection}|${location}|${weeks.join(',')}`;
    if (meetingDedup.has(dedupKey)) continue;
    meetingDedup.add(dedupKey);

    course.meetings.push({
      teacher,
      location,
      campus,
      dayOfWeek,
      startSection,
      endSection,
      startTimeOverride: normalizeTimeField(row.KSSJ),
      endTimeOverride: normalizeTimeField(row.JSSJ),
      weeks,
      weeksText: zcmc || formatWeeksCompact(weeks),
      isAdjusted: Number(row.ISTK ?? 0) !== 0,
      source: 'swpu_wisedu',
    });
  }

  const courses = [...courseMap.values()];
  const meetingCount = courses.reduce((sum, c) => sum + c.meetings.length, 0);
  return {
    courses,
    campus: detectedCampus || '成都校区',
    courseCount: courses.length,
    meetingCount,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 上课时间解析 & RFC 5545 .ics 日历导出
// ───────────────────────────────────────────────────────────────────────────

export function resolveMeetingTimeRange(
  meeting: Pick<ScheduleMeeting, 'startSection' | 'endSection' | 'startTimeOverride' | 'endTimeOverride'>,
  timetable: ScheduleTimetable,
): { startTime: string; endTime: string } {
  const slots = ensureSlotsUpTo(
    timetable.slots,
    Math.max(meeting.endSection, 12),
    timetable.defaultDurationMinutes,
  );
  const firstSlot = slots.find((s) => s.section === meeting.startSection);
  const lastSlot = slots.find((s) => s.section === meeting.endSection);
  return {
    startTime: firstSlot?.startTime ?? meeting.startTimeOverride ?? '08:00',
    endTime: lastSlot?.endTime ?? meeting.endTimeOverride ?? '09:35',
  };
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function formatIcsLocalDateTime(dateStr: string, hhmm: string): string {
  const d = dateStr.replace(/-/g, '');
  const t = hhmm.replace(':', '');
  return `${d}T${t}00`;
}

/**
 * 导出标准 RFC 5545 `.ics` 日历文本（展开为逐次精确 VEVENT）：
 * 完美兼容 Apple 日历、飞书日历、Outlook 与 Google 日历，避免单双周/跳周/节假日 RRULE 兼容问题。
 */
export function generateScheduleIcs(detail: ScheduleDetail): string {
  const { schedule, timetable, courses } = detail;
  const holidaySet = new Set(schedule.holidays);
  const startAligned = getStartOfWeekLocal(parseLocalDate(schedule.startDate), schedule.weekStartDay);
  const nowStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LEC Software Studio//Orbit Schedule//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(schedule.name)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];

  let seq = 0;
  for (const course of courses) {
    for (const meeting of course.meetings) {
      const { startTime, endTime } = resolveMeetingTimeRange(meeting, timetable);
      // 计算该星期相对于本周起始日的偏移天数
      const dayOffset =
        schedule.weekStartDay === 7
          ? meeting.dayOfWeek === 7
            ? 0
            : meeting.dayOfWeek
          : meeting.dayOfWeek - 1;

      for (const week of meeting.weeks) {
        if (week < 1 || week > schedule.totalWeeks) continue;
        const eventDate = new Date(
          startAligned.getFullYear(),
          startAligned.getMonth(),
          startAligned.getDate() + (week - 1) * 7 + dayOffset,
        );
        const dateStr = formatLocalDate(eventDate);
        if (holidaySet.has(dateStr)) continue;

        seq += 1;
        const uid = `orbit-${schedule.id}-${meeting.id}-w${week}-${seq}@lecspace.top`;
        const descParts = [
          meeting.teacher ? `教师：${meeting.teacher}` : '',
          `第 ${week} 周 · 第 ${meeting.startSection}-${meeting.endSection} 节`,
          course.category ? `类型：${course.category}` : '',
          course.credit != null ? `学分：${course.credit}` : '',
          course.note ? `备注：${course.note}` : '',
        ].filter(Boolean);

        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${uid}`);
        lines.push(`DTSTAMP:${nowStamp}`);
        lines.push(`DTSTART;TZID=Asia/Shanghai:${formatIcsLocalDateTime(dateStr, startTime)}`);
        lines.push(`DTEND;TZID=Asia/Shanghai:${formatIcsLocalDateTime(dateStr, endTime)}`);
        lines.push(`SUMMARY:${escapeIcsText(course.name)}`);
        if (meeting.location) {
          lines.push(`LOCATION:${escapeIcsText(meeting.location)}`);
        }
        if (descParts.length > 0) {
          lines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`);
        }
        if (schedule.reminderEnabled && schedule.reminderMinutes > 0) {
          lines.push('BEGIN:VALARM');
          lines.push(`TRIGGER:-PT${schedule.reminderMinutes}M`);
          lines.push('ACTION:DISPLAY');
          lines.push(
            `DESCRIPTION:${escapeIcsText(`${course.name}${meeting.location ? ` @ ${meeting.location}` : ''}`)}`,
          );
          lines.push('END:VALARM');
        }
        lines.push('END:VEVENT');
      }
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Orbit 课表分享包（JSON 互传）
// ───────────────────────────────────────────────────────────────────────────

export const OrbitSharePackageSchema = z.object({
  format: z.literal('orbit-schedule-v1'),
  exportedAt: z.string(),
  schedule: z.object({
    name: z.string().trim().min(1).max(60),
    termCode: z.string().max(40).default(''),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    weekStartDay: z.union([z.literal(1), z.literal(7)]).default(1),
    totalWeeks: z.number().int().min(1).max(30).default(20),
    maxSections: z.number().int().min(8).max(24).default(12),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  }),
  timetable: z.object({
    name: z.string().trim().min(1).max(60),
    fixedDurationEnabled: z.boolean().default(true),
    defaultDurationMinutes: z.number().int().min(15).max(180).default(45),
    slots: z.array(TimetableSlotSchema).min(1).max(24),
  }),
  courses: z.array(
    z.object({
      name: z.string().trim().min(1).max(100),
      courseCode: z.string().max(60).default(''),
      credit: z.number().min(0).max(30).nullable().default(null),
      category: z.string().max(60).default(''),
      color: z.string().min(4).max(32),
      note: z.string().max(500).default(''),
      meetings: z.array(UpsertMeetingDraftSchema).min(1),
    }),
  ),
});
export type OrbitSharePackage = z.infer<typeof OrbitSharePackageSchema>;

export function buildOrbitSharePackage(detail: ScheduleDetail): OrbitSharePackage {
  return {
    format: 'orbit-schedule-v1',
    exportedAt: new Date().toISOString(),
    schedule: {
      name: detail.schedule.name,
      termCode: detail.schedule.termCode,
      startDate: detail.schedule.startDate,
      weekStartDay: detail.schedule.weekStartDay,
      totalWeeks: detail.schedule.totalWeeks,
      maxSections: detail.schedule.maxSections,
      holidays: detail.schedule.holidays,
    },
    timetable: {
      name: detail.timetable.name,
      fixedDurationEnabled: detail.timetable.fixedDurationEnabled,
      defaultDurationMinutes: detail.timetable.defaultDurationMinutes,
      slots: detail.timetable.slots,
    },
    courses: detail.courses.map((c) => ({
      name: c.name,
      courseCode: c.courseCode,
      credit: c.credit,
      category: c.category,
      color: c.color,
      note: c.note,
      meetings: c.meetings.map((m) => ({
        teacher: m.teacher,
        location: m.location,
        campus: m.campus,
        dayOfWeek: m.dayOfWeek,
        startSection: m.startSection,
        endSection: m.endSection,
        startTimeOverride: m.startTimeOverride,
        endTimeOverride: m.endTimeOverride,
        weeks: m.weeks,
        weeksText: m.weeksText,
        isAdjusted: m.isAdjusted,
        source: 'share_json' as const,
      })),
    })),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 课前提醒纯函数决策引擎（对标 reminders.ts 风格）
// ───────────────────────────────────────────────────────────────────────────

export interface ClassReminderInput {
  now: Date;
  detail: ScheduleDetail | null;
  sentKeys: ReadonlySet<string>;
}

export interface ClassReminderNotice {
  key: string;
  title: string;
  body: string;
  courseName: string;
  location: string;
  startTime: string;
}

/** 评估当前时间是否需要发出课前提醒（命中 [0, reminderMinutes] 窗口且今日非节假日） */
export function evaluateClassReminder(input: ClassReminderInput): ClassReminderNotice | null {
  const { now, detail, sentKeys } = input;
  if (!detail || !detail.schedule.reminderEnabled) return null;

  const { schedule, timetable, courses } = detail;
  const todayStr = formatLocalDate(now);
  if (schedule.holidays.includes(todayStr)) return null;

  const currentWeek = computeWeekFromStartDate(schedule.startDate, now, schedule.weekStartDay);
  if (currentWeek < 1 || currentWeek > schedule.totalWeeks) return null;

  const jsDay = now.getDay();
  const todayIso = jsDay === 0 ? 7 : jsDay;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const course of courses) {
    for (const meeting of course.meetings) {
      if (meeting.dayOfWeek !== todayIso) continue;
      if (!meeting.weeks.includes(currentWeek)) continue;

      const { startTime } = resolveMeetingTimeRange(meeting, timetable);
      const startMinutes = timeToMinutes(startTime);
      if (startMinutes == null) continue;

      const diff = startMinutes - nowMinutes;
      if (diff > 0 && diff <= schedule.reminderMinutes) {
        const key = `class:${schedule.id}:${meeting.id}:${todayStr}:${startTime}`;
        if (sentKeys.has(key)) continue;
        return {
          key,
          title: `${diff} 分钟后上课：${course.name}`,
          body: [
            `${startTime}（第 ${meeting.startSection}-${meeting.endSection} 节）`,
            meeting.location ? `地点：${meeting.location}` : '',
            meeting.teacher ? `教师：${meeting.teacher}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          courseName: course.name,
          location: meeting.location,
          startTime,
        };
      }
    }
  }

  return null;
}

/**
 * 计算当前时间在离散「节次课表」纵轴中的像素 Y 坐标：
 * - 上课期间：按当前节的起止时间线性插值定位到对应行内部；
 * - 课间 / 午休 / 晚休：自动停靠在上一节与下一节的交界线上；
 * - 开课前 30 分钟内贴顶、最后一节下课后 30 分钟内贴底，深夜不在课表时段返回 null。
 */
export function computeScheduleNowLineTop(
  slots: readonly TimetableSlot[],
  nowMinutes: number,
  rowHeight: number,
): number | null {
  if (slots.length === 0 || rowHeight <= 0) return null;
  const parsed = slots
    .map((slot, index) => {
      const start = timeToMinutes(slot.startTime);
      const end = timeToMinutes(slot.endTime);
      return start != null && end != null ? { index, start, end } : null;
    })
    .filter((item): item is { index: number; start: number; end: number } => item !== null);
  if (parsed.length === 0) return null;

  const first = parsed[0]!;
  const last = parsed[parsed.length - 1]!;
  const totalHeight = slots.length * rowHeight;

  if (nowMinutes < first.start) {
    return first.start - nowMinutes <= 30 ? 2 : null;
  }
  if (nowMinutes > last.end) {
    return nowMinutes - last.end <= 30 ? totalHeight - 2 : null;
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const cur = parsed[i]!;
    if (nowMinutes >= cur.start && nowMinutes <= cur.end) {
      const ratio = (nowMinutes - cur.start) / Math.max(1, cur.end - cur.start);
      return cur.index * rowHeight + ratio * rowHeight;
    }
    const next = parsed[i + 1];
    if (next && nowMinutes > cur.end && nowMinutes < next.start) {
      return (cur.index + 1) * rowHeight;
    }
  }

  return null;
}
