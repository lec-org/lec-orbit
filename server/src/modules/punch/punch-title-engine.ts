/**
 * 称号系统纯计算引擎（零外部时区库依赖，严格按 Asia/Shanghai UTC+8 自然日与考核周评估全部 26 个称号）。
 * 覆盖原 LecPunch 11 个基础称号 + Orbit 15 个扩展称号（含课表联动与无课表分层兜底、长期持久化与显隐控制）。
 */
import type { BusyScheduleSnapshot } from '../calendar/entities/member-busy-snapshot.entity.js';
import { comprehensiveDurationSeconds, weeklyGoalSeconds } from './punch-shared.util.js';
import {
  TITLE_CATALOG,
  toMemberTitleBadge,
  type MemberTitleBadge,
  type TitleEvaluationItem,
} from './punch-title-catalog.js';

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_VALID_SESSION_SECONDS = 18_000;
const ONE_HOUR_SECONDS = 3_600;
const FOUR_HOURS_SECONDS = 4 * 3_600;
const FIVE_HOURS_SECONDS = 5 * 3_600;
const THIRTY_FIVE_HOURS_SECONDS = 35 * 3_600;
const FIFTY_HOURS_SECONDS = 50 * 3_600;
const DEFAULT_CARD_CATALOG_SIZE = 21;

/** 西南石油大学（成都校区）标准 1–12 节作息（与客户端 src/shared/schedule.ts 对齐，用于课表展开与兜底）。 */
const SWPU_DEFAULT_SLOT_MAP: ReadonlyMap<number, { startTime: string; endTime: string }> = new Map([
  [1, { startTime: '08:00', endTime: '08:45' }],
  [2, { startTime: '08:50', endTime: '09:35' }],
  [3, { startTime: '09:50', endTime: '10:35' }],
  [4, { startTime: '10:40', endTime: '11:25' }],
  [5, { startTime: '11:30', endTime: '12:15' }],
  [6, { startTime: '14:30', endTime: '15:15' }],
  [7, { startTime: '15:20', endTime: '16:05' }],
  [8, { startTime: '16:20', endTime: '17:05' }],
  [9, { startTime: '17:10', endTime: '17:55' }],
  [10, { startTime: '19:00', endTime: '19:45' }],
  [11, { startTime: '19:50', endTime: '20:35' }],
  [12, { startTime: '20:40', endTime: '21:25' }],
]);

/** 未导入课表且同年级样本不足时的标准工作日白昼教学时段（1–5 节上午 + 6–9 节下午，不含午休与晚自习）。 */
const SWPU_STANDARD_DAYTIME_WINDOWS: ReadonlyArray<{ startHm: string; endHm: string }> = [
  { startHm: '08:00', endHm: '12:15' },
  { startHm: '14:30', endHm: '17:55' },
];

const NEGATIVE_CARD_NAMES = new Set([
  '减时长',
  '顺手牵羊',
  '乐不思蜀',
  '铁索连环',
  '雷电',
  '兵粮寸断',
  '南蛮入侵',
  '红桃 K',
  '万箭穿心',
]);

export interface TitleEngineMember {
  id: string;
  enrollYear: number;
  createdAt?: Date;
  equippedTitleId?: string | null;
  /** 已持久化解锁的长期称号 ID 列表。 */
  persistentTitleIds?: string[];
  /** 成员主动关闭展示的称号 ID 列表（仅对 hideable 称号生效）。 */
  hiddenTitleIds?: string[];
  /** 成员绑定的 GitHub 用户名（用于「贡献王」匹配）。 */
  githubUsername?: string | null;
  /** 成员卡牌图鉴已解锁种类数（用于「收集者」「收集之王」）。 */
  discoveredCardCount?: number;
  /** 成员同步到云端的个人课表快照（来自 PR #13 member_busy_snapshots，用于「最老实之人」）。 */
  scheduleSnapshot?: BusyScheduleSnapshot | null;
}

export interface TitleEngineSession {
  userId: string;
  checkInAt: Date;
  checkOutAt?: Date;
  durationSeconds?: number;
  status: 'active' | 'completed' | 'invalidated';
  weekKey: string;
}

export interface TitleEngineCardInteraction {
  actorId: string;
  targetId: string;
  polarity: 'positive' | 'negative';
  atMs: number;
  /** 负面效果是否真正生效（未被盾/无懈可击阻挡或反弹）；未提供时默认视为 true。 */
  applied?: boolean;
}

export interface TitleEngineGambleEvent {
  atMs: number;
  won: boolean;
}

export interface TitleEngineReleaseContributor {
  tagName: string;
  publishedAt: Date;
  contributorLogins: string[];
}

export interface EvaluateTeamTitlesInput {
  now: Date;
  members: TitleEngineMember[];
  sessions: TitleEngineSession[];
  /** key 格式：`${userId}:${weekKey}` → 手动补正总秒数。 */
  manualAdjustmentsByUserWeek: Map<string, number>;
  /** key 格式：`${userId}:${weekKey}` → 卡牌娱乐时长 + 交易时长总秒数。 */
  entertainmentByUserWeek: Map<string, number>;
  /** 本周发生的跨人卡牌正/负面交互事件。 */
  currentWeekCardInteractions: TitleEngineCardInteraction[];
  /** 成员全历史「我赌你的枪里没有子弹」使用记录（用于「赌王」「求求你戒赌吧」）。 */
  gambleEventsByUser?: Map<string, TitleEngineGambleEvent[]>;
  /** 全历史曾触发 SSR 大保底的成员 ID 集合（兼容旧调用方）。 */
  ssrPityUsers?: Set<string>;
  /** 成员全历史触发 SSR 大保底的去重回执键列表（用于按次累计「自古枪兵幸运e」升阶）。 */
  ssrPityReceiptKeysByUser?: Map<string, string[]>;
  /** Orbit 历史 Release 的合并 PR 作者列表（用于「贡献王」）。 */
  releaseContributors?: TitleEngineReleaseContributor[];
  /** 当前卡牌目录总种类数（默认 21，用于「收集之王」）。 */
  totalCatalogCards?: number;
  /** 数据库已持久化的成就幂等键集合：userId -> (titleId -> Set<occurrenceKey>)。 */
  existingAchievementKeysByUser?: Map<string, Map<string, Set<string>>>;
}

export interface NewTitleAchievementRecord {
  titleId: string;
  occurrenceKey: string;
}

export interface MemberTitleEvaluation {
  equippedTitleId: string | null;
  hiddenTitleIds: string[];
  /** 本次评估中新解锁且尚未写入 persistentTitleIds 的长期称号 ID 列表。 */
  newlyUnlockedPersistentTitleIds: string[];
  /** 本次评估中新发现且尚未写入 punch_title_achievements 的幂等成就达成记录。 */
  newAchievementRecords: NewTitleAchievementRecord[];
  displayTitles: MemberTitleBadge[];
  catalog: TitleEvaluationItem[];
}

/** 上海时区（UTC+8）日期分量结构。 */
interface ShanghaiParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  weekday: number; // 1=周一 .. 7=周日
}

interface TimeIntervalMs {
  startMs: number;
  endMs: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDayKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 将毫秒时间戳转为上海时间（UTC+8）分量。 */
export function getShanghaiParts(ms: number): ShanghaiParts {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const dow = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: dow === 0 ? 7 : dow,
  };
}

/** 将上海自然日 YYYY-MM-DD（可选小时与分钟）转为对应 UTC 毫秒时间戳。 */
export function shanghaiDayStartMs(dayKey: string, hour = 0, minute = 0): number {
  const [y, m, d] = dayKey.split('-').map((v) => Number.parseInt(v, 10));
  return Date.UTC(y, m - 1, d, hour, minute, 0, 0) - SHANGHAI_OFFSET_MS;
}

/** 获取指定毫秒时间戳对应的上海自然日 YYYY-MM-DD。 */
export function shanghaiDayKeyOfMs(ms: number): string {
  const p = getShanghaiParts(ms);
  return formatDayKey(p.year, p.month, p.day);
}

/** 获取指定毫秒时间戳所在上海考核周的周一日期 YYYY-MM-DD。 */
export function shanghaiWeekKeyOfMs(ms: number): string {
  const p = getShanghaiParts(ms);
  const mondayUtcMs = Date.UTC(p.year, p.month - 1, p.day - (p.weekday - 1));
  const m = new Date(mondayUtcMs);
  return formatDayKey(m.getUTCFullYear(), m.getUTCMonth() + 1, m.getUTCDate());
}

/** 对上海自然日 YYYY-MM-DD 加减天数。 */
export function addShanghaiDays(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map((v) => Number.parseInt(v, 10));
  const next = new Date(Date.UTC(y, m - 1, d + delta));
  return formatDayKey(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** 返回指定年月的总天数（1..12）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 获取指定上海时间对应“上个月 1 号前一天 00:00”的 Date，用于拉取称号回溯会话。 */
export function getTitleLookbackStartDate(now: Date): Date {
  const p = getShanghaiParts(now.getTime());
  const prevYear = p.month === 1 ? p.year - 1 : p.year;
  const prevMonth = p.month === 1 ? 12 : p.month - 1;
  const prevMonthFirstKey = formatDayKey(prevYear, prevMonth, 1);
  return new Date(shanghaiDayStartMs(addShanghaiDays(prevMonthFirstKey, -1)));
}

/** 计算区间 [startMs, endMs] 与 [winStartMs, winEndMs] 的重叠秒数。 */
function overlapSeconds(startMs: number, endMs: number, winStartMs: number, winEndMs: number): number {
  const s = Math.max(startMs, winStartMs);
  const e = Math.min(endMs, winEndMs);
  return e > s ? Math.floor((e - s) / 1000) : 0;
}

/** 合并重叠或首尾相接的时间区间，避免连堂/重叠课重复计入重叠秒数。 */
function mergeIntervals(intervals: TimeIntervalMs[]): TimeIntervalMs[] {
  if (intervals.length <= 1) return intervals.filter((i) => i.endMs > i.startMs);
  const sorted = [...intervals]
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: TimeIntervalMs[] = [];
  for (const cur of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && cur.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, cur.endMs);
    } else {
      merged.push({ startMs: cur.startMs, endMs: cur.endMs });
    }
  }
  return merged;
}

function parseHm(hm: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const hour = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseDateOnlyUtc(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function computeScheduleWeekNumber(
  startDateStr: string,
  targetDateStr: string,
  weekStartDay: number,
): number {
  const start = parseDateOnlyUtc(startDateStr);
  const target = parseDateOnlyUtc(targetDateStr);
  if (!start || !target) return -1;
  const startIso = start.getUTCDay() === 0 ? 7 : start.getUTCDay();
  const offsetToWeekStart =
    weekStartDay === 7 ? (startIso === 7 ? 0 : startIso) : startIso - 1;
  const alignedStartMs = start.getTime() - offsetToWeekStart * DAY_MS;
  const diffDays = Math.floor((target.getTime() - alignedStartMs) / DAY_MS);
  return Math.floor(diffDays / 7) + 1;
}

function getIsoWeekdayOfDayKey(dayKey: string): number {
  const d = parseDateOnlyUtc(dayKey);
  if (!d) return 1;
  const dow = d.getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** 展开个人课表快照在指定自然日的上课区间（合并去重）与有课节次集合。 */
function expandPersonalScheduleDay(
  schedule: BusyScheduleSnapshot,
  dayKey: string,
): { inTerm: boolean; intervals: TimeIntervalMs[]; sections: Set<number> } {
  const sections = new Set<number>();
  if (!schedule || !Array.isArray(schedule.courses) || schedule.courses.length === 0) {
    return { inTerm: false, intervals: [], sections };
  }
  const week = computeScheduleWeekNumber(
    schedule.startDate,
    dayKey,
    schedule.weekStartDay === 7 ? 7 : 1,
  );
  const maxWeeks = schedule.totalWeeks > 0 ? schedule.totalWeeks : 24;
  if (week < 1 || week > maxWeeks) {
    return { inTerm: false, intervals: [], sections };
  }

  const isoDay = getIsoWeekdayOfDayKey(dayKey);
  const slotMap = new Map<number, { startTime: string; endTime: string }>(SWPU_DEFAULT_SLOT_MAP);
  for (const s of schedule.slots ?? []) {
    if (typeof s.section === 'number' && s.startTime && s.endTime) {
      slotMap.set(s.section, { startTime: s.startTime, endTime: s.endTime });
    }
  }

  const rawIntervals: TimeIntervalMs[] = [];
  for (const course of schedule.courses) {
    for (const meeting of course.meetings ?? []) {
      if (meeting.dayOfWeek !== isoDay) continue;
      if (!Array.isArray(meeting.weeks) || !meeting.weeks.includes(week)) continue;
      const startSec = Math.max(1, meeting.startSection);
      const endSec = Math.max(startSec, meeting.endSection);
      for (let sec = startSec; sec <= endSec; sec += 1) {
        sections.add(sec);
      }
      const startSlot = slotMap.get(startSec);
      const endSlot = slotMap.get(endSec);
      const startHm = parseHm(startSlot?.startTime ?? '08:00');
      const endHm = parseHm(endSlot?.endTime ?? '09:35');
      if (!startHm || !endHm) continue;
      const sMs = shanghaiDayStartMs(dayKey, startHm.hour, startHm.minute);
      const eMs = shanghaiDayStartMs(dayKey, endHm.hour, endHm.minute);
      if (eMs > sMs) {
        rawIntervals.push({ startMs: sMs, endMs: eMs });
      }
    }
  }

  return {
    inTerm: true,
    intervals: mergeIntervals(rawIntervals),
    sections,
  };
}

/** 计算成员在某天多个合法打卡片段与目标时间窗列表的总重叠秒数。 */
function computeIntervalsOverlapSeconds(
  sessions: ReadonlyArray<TimeIntervalMs>,
  windows: ReadonlyArray<TimeIntervalMs>,
): number {
  if (sessions.length === 0 || windows.length === 0) return 0;
  const mergedSessions = mergeIntervals([...sessions]);
  let total = 0;
  for (const s of mergedSessions) {
    for (const w of windows) {
      total += overlapSeconds(s.startMs, s.endMs, w.startMs, w.endMs);
    }
  }
  return total;
}

/** 计算一组已满足条件的日期集合中，截止在 [anchorDay - maxEndAgeDays, anchorDay] 内的最长连续天数。 */
function bestRecentConsecutiveStreak(
  days: Set<string>,
  anchorDay: string,
  maxLookbackDays = 60,
  maxEndAgeDays = 1,
): { qualified3: boolean; currentStreak: number } {
  let currentStreak = 0;
  const startFrom = days.has(anchorDay) ? anchorDay : addShanghaiDays(anchorDay, -1);
  let cursor = startFrom;
  while (days.has(cursor) && currentStreak < maxLookbackDays) {
    currentStreak += 1;
    cursor = addShanghaiDays(cursor, -1);
  }

  let qualified3 = false;
  for (let age = 0; age <= maxEndAgeDays; age += 1) {
    const endDay = addShanghaiDays(anchorDay, -age);
    if (
      days.has(endDay) &&
      days.has(addShanghaiDays(endDay, -1)) &&
      days.has(addShanghaiDays(endDay, -2))
    ) {
      qualified3 = true;
      break;
    }
  }
  return { qualified3, currentStreak };
}

const STREAK_OCCURRENCE_KEY_RE = /^streak:(\d{4}-\d{2}-\d{2})$/;

/**
 * 纯函数：从满足条件的上海自然日集合中提取不重叠的连续 minLen 天轮次幂等键（streak:<段末日期>）。
 * 例如连续 7 天（day1..day7）且 minLen=3 时，拆分为 [day1..day3] 与 [day4..day6] 两段，
 * 返回 ['streak:day3', 'streak:day6']，保证每日增量扫描绝不重复计数。
 * 若传入该称号已持久化的 existingKeys，会先标记已兑换段覆盖的自然日区间 [endDay-(minLen-1), endDay]，
 * 扫描时遇到已兑换日期直接重置连续计数，彻底避免跨月滑动窗口切换造成相位偏移并双倍刷阶。
 */
export function extractNonOverlappingStreakKeys(
  days: Set<string>,
  minLen = 3,
  existingKeys?: ReadonlySet<string>,
): string[] {
  if (days.size < minLen || minLen <= 0) return [];
  const consumedDays = new Set<string>();
  if (existingKeys && existingKeys.size > 0) {
    for (const key of existingKeys) {
      const m = STREAK_OCCURRENCE_KEY_RE.exec(key);
      if (!m) continue;
      const endDay = m[1]!;
      for (let offset = 0; offset < minLen; offset += 1) {
        consumedDays.add(addShanghaiDays(endDay, -offset));
      }
    }
  }

  const sorted = [...days].sort();
  const keys: string[] = [];
  let runLen = 0;
  let prevDay: string | null = null;
  for (const day of sorted) {
    if (consumedDays.has(day)) {
      runLen = 0;
      prevDay = null;
      continue;
    }
    if (prevDay && addShanghaiDays(prevDay, 1) === day) {
      runLen += 1;
    } else {
      runLen = 1;
    }
    prevDay = day;
    if (runLen === minLen) {
      keys.push(`streak:${day}`);
      // 达成一段完整轮次后归零，确保后续连续天数按独立非重叠段计算
      runLen = 0;
      prevDay = null;
    }
  }
  return keys;
}

/** 纯函数：判定某 GitHub 用户名是否在连续 requiredStreak 次版本更新中都提交了合并 PR，并提取独立轮次幂等键。 */
export function hasConsecutiveReleaseContributions(
  releases: ReadonlyArray<TitleEngineReleaseContributor>,
  githubUsername: string | null | undefined,
  requiredStreak = 3,
): { unlocked: boolean; maxStreak: number; currentStreak: number; streakKeys: string[] } {
  const login = (githubUsername ?? '').trim().toLowerCase();
  if (!login || releases.length === 0) {
    return { unlocked: false, maxStreak: 0, currentStreak: 0, streakKeys: [] };
  }
  const sorted = [...releases].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  let maxStreak = 0;
  let currentStreak = 0;
  let bucketStreak = 0;
  const streakKeys: string[] = [];
  for (const rel of sorted) {
    const hit = rel.contributorLogins.some((item) => item.trim().toLowerCase() === login);
    if (hit) {
      currentStreak += 1;
      bucketStreak += 1;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
      if (bucketStreak === requiredStreak) {
        streakKeys.push(`release-streak:${rel.tagName}`);
        bucketStreak = 0;
      }
    } else {
      currentStreak = 0;
      bucketStreak = 0;
    }
  }
  return {
    unlocked: maxStreak >= requiredStreak,
    maxStreak,
    currentStreak,
    streakKeys,
  };
}

/** 将一条卡牌回执解析为跨人正/负面交互事件列表（用于「吕洞宾」「龙王」称号判定）。 */
export function extractCardInteractionsFromReceipt(receipt: {
  actorId?: string;
  at?: string;
  result?: Record<string, unknown> | null;
  gift?: Record<string, unknown> | null;
}): TitleEngineCardInteraction[] {
  const actorId = receipt.actorId;
  if (!actorId || !receipt.at) return [];
  const atMs = Date.parse(receipt.at);
  if (Number.isNaN(atMs)) return [];

  const events: TitleEngineCardInteraction[] = [];
  const giftRecipientId =
    receipt.gift && typeof receipt.gift.recipientId === 'string'
      ? receipt.gift.recipientId
      : undefined;
  if (giftRecipientId && giftRecipientId !== actorId) {
    events.push({
      actorId,
      targetId: giftRecipientId,
      polarity: 'positive',
      atMs,
      applied: true,
    });
  }

  const result = receipt.result as
    | {
        action?: string;
        actionCard?: { name?: string };
        effects?: Array<{
          target?: { id?: string };
          kind?: string;
          deltaSeconds?: number;
          outcome?: string;
        }>;
      }
    | undefined
    | null;

  if (!result || result.action !== 'use' || !Array.isArray(result.effects)) {
    return events;
  }

  const cardName = result.actionCard?.name ?? '';
  for (const effect of result.effects) {
    // 跳过判定过程日志（如「雷电」命中前生成的 judgement 项），避免被无懈可击阻挡/反弹时误判为负面效果已生效
    if (effect.kind === 'judgement') continue;
    const targetId = effect.target?.id;
    if (!targetId || targetId === actorId) continue;

    if (effect.kind === 'time') {
      const delta = effect.deltaSeconds ?? 0;
      if (delta > 0) {
        events.push({
          actorId,
          targetId,
          polarity: 'positive',
          atMs,
          applied: effect.outcome === 'applied',
        });
        continue;
      }
      if (delta < 0) {
        events.push({
          actorId,
          targetId,
          polarity: 'negative',
          atMs,
          applied: effect.outcome === 'applied',
        });
        continue;
      }
    }

    if (cardName === '五谷丰登' && effect.outcome === 'applied') {
      events.push({ actorId, targetId, polarity: 'positive', atMs, applied: true });
      continue;
    }

    if (NEGATIVE_CARD_NAMES.has(cardName)) {
      events.push({
        actorId,
        targetId,
        polarity: 'negative',
        atMs,
        applied: effect.outcome === 'applied',
      });
    }
  }

  return events;
}

/** 从一条卡牌回执中提取「我赌你的枪里没有子弹」使用胜负事件（用于「赌王」「求求你戒赌吧」）。 */
export function extractGambleEventFromReceipt(receipt: {
  actorId?: string;
  at?: string;
  result?: Record<string, unknown> | null;
}): { actorId: string; event: TitleEngineGambleEvent } | null {
  const actorId = receipt.actorId;
  if (!actorId || !receipt.at) return null;
  const atMs = Date.parse(receipt.at);
  if (Number.isNaN(atMs)) return null;

  const result = receipt.result as
    | {
        action?: string;
        actionCard?: { id?: string; name?: string };
        effects?: Array<{
          kind?: string;
          deltaSeconds?: number;
          detail?: string;
        }>;
      }
    | undefined
    | null;

  if (!result || result.action !== 'use') return null;
  const cardId = result.actionCard?.id ?? '';
  const cardName = result.actionCard?.name ?? '';
  const isGambleCard =
    cardName === '我赌你的枪里没有子弹' || cardId === 'n-gamble' || cardId === 'card-03';
  if (!isGambleCard) return null;

  const effects = Array.isArray(result.effects) ? result.effects : [];
  const judgement = effects.find((e) => e.kind === 'judgement');
  let won: boolean | null = null;
  if (judgement?.detail) {
    if (judgement.detail.includes('幸运')) won = true;
    else if (judgement.detail.includes('不利')) won = false;
  }
  if (won === null) {
    const timeEff = effects.find((e) => e.kind === 'time');
    if (timeEff && typeof timeEff.deltaSeconds === 'number') {
      won = timeEff.deltaSeconds > 0;
    }
  }
  if (won === null) return null;
  return { actorId, event: { atMs, won } };
}

/** 判断一条抽卡回执是否触发了 SSR 大保底（用于「自古枪兵幸运e」）。 */
export function hasSsrPityInReceipt(receipt: {
  actorId?: string;
  result?: Record<string, unknown> | null;
}): boolean {
  if (!receipt.actorId || !receipt.result) return false;
  const result = receipt.result as { action?: string; ssrPity?: boolean };
  return result.action === 'draw' && result.ssrPity === true;
}

interface UserDailyMetrics {
  dailySeconds: Map<string, number>;
  dailyIntervals: Map<string, TimeIntervalMs[]>;
  nightOwlDays: Set<string>;
  earlyBirdDays: Set<string>;
  overnightSeconds: Map<string, number>;
  recordedByWeek: Map<string, number>;
  activeCurrentWeekSeconds: number;
}

function emptyMetrics(): UserDailyMetrics {
  return {
    dailySeconds: new Map(),
    dailyIntervals: new Map(),
    nightOwlDays: new Set(),
    earlyBirdDays: new Set(),
    overnightSeconds: new Map(),
    recordedByWeek: new Map(),
    activeCurrentWeekSeconds: 0,
  };
}

type ScheduleResolveMode = 'personal' | 'grade-fallback' | 'standard-fallback';

interface ResolvedClassDay {
  dayKey: string;
  intervals: TimeIntervalMs[];
  totalClassSec: number;
}

interface ResolvedClassWeek {
  mode: ScheduleResolveMode;
  days: ResolvedClassDay[];
}

interface ClassAttendanceWeekEval {
  mode: ScheduleResolveMode;
  classDays: number;
  honestHitDays: number;
  honestQualified: boolean;
  totalClassOverlapSec: number;
}

/** 判断一份课表快照是否具备有效课程与开学日期（用于区分“已导课表”与“未导课表”）。 */
function hasValidScheduleSnapshot(
  schedule: BusyScheduleSnapshot | null | undefined,
): schedule is BusyScheduleSnapshot {
  return Boolean(
    schedule &&
      Array.isArray(schedule.courses) &&
      schedule.courses.length > 0 &&
      parseDateOnlyUtc(schedule.startDate) !== null,
  );
}

/** 统一解析某成员在指定一周（7 天）内的每日上课时间段：个人课表 → 同年级课表 → SWPU 标准作息。 */
function resolveClassWindowsForWeek(
  member: TitleEngineMember,
  weekDayKeys: string[],
  gradePeerSchedules: ReadonlyArray<BusyScheduleSnapshot>,
): ResolvedClassWeek {
  // 1. 优先使用成员已导入的个人课表：若处于寒暑假或结课周（非教学周/无排课），直接返回空课日，不再穿透到兜底模式
  const personal = member.scheduleSnapshot;
  if (hasValidScheduleSnapshot(personal)) {
    const days: ResolvedClassDay[] = [];
    for (const dKey of weekDayKeys) {
      const expanded = expandPersonalScheduleDay(personal, dKey);
      const totalClassSec = expanded.intervals.reduce(
        (acc, it) => acc + Math.floor((it.endMs - it.startMs) / 1000),
        0,
      );
      if (totalClassSec > 0) {
        days.push({ dayKey: dKey, intervals: expanded.intervals, totalClassSec });
      }
    }
    return { mode: 'personal', days };
  }

  // 2. 第一级兜底：同年级已有 ≥ 2 名同学同步有效课表，按半数以上高频有课节次推断；
  //    若同年级课表均处于寒暑假或结课周（本周无课），直接返回空课日，不再穿透至标准兜底误发假期称号
  const validPeers = gradePeerSchedules.filter(hasValidScheduleSnapshot);
  if (validPeers.length >= 2) {
    const days: ResolvedClassDay[] = [];
    for (const dKey of weekDayKeys) {
      const sectionCounts = new Map<number, number>();
      let inTermCount = 0;
      for (const peerSched of validPeers) {
        const exp = expandPersonalScheduleDay(peerSched, dKey);
        if (!exp.inTerm) continue;
        inTermCount += 1;
        for (const sec of exp.sections) {
          sectionCounts.set(sec, (sectionCounts.get(sec) ?? 0) + 1);
        }
      }
      if (inTermCount < 2) continue;
      const minPeerVotes = Math.ceil(inTermCount / 2);
      const inferredIntervals: TimeIntervalMs[] = [];
      for (const [sec, count] of sectionCounts.entries()) {
        if (count < minPeerVotes) continue;
        const slot = SWPU_DEFAULT_SLOT_MAP.get(sec);
        if (!slot) continue;
        const sHm = parseHm(slot.startTime);
        const eHm = parseHm(slot.endTime);
        if (!sHm || !eHm) continue;
        const sMs = shanghaiDayStartMs(dKey, sHm.hour, sHm.minute);
        const eMs = shanghaiDayStartMs(dKey, eHm.hour, eHm.minute);
        if (eMs > sMs) inferredIntervals.push({ startMs: sMs, endMs: eMs });
      }
      const merged = mergeIntervals(inferredIntervals);
      const totalClassSec = merged.reduce(
        (acc, it) => acc + Math.floor((it.endMs - it.startMs) / 1000),
        0,
      );
      if (totalClassSec > 0) {
        days.push({ dayKey: dKey, intervals: merged, totalClassSec });
      }
    }
    return { mode: 'grade-fallback', days };
  }

  // 3. 第二级兜底：西南石油大学标准工作日白昼教学时段（周一至周五 08:00–12:15 & 14:30–17:55）
  const days: ResolvedClassDay[] = [];
  for (const dKey of weekDayKeys) {
    const weekday = getIsoWeekdayOfDayKey(dKey);
    if (weekday > 5) continue;
    const stdWindows: TimeIntervalMs[] = SWPU_STANDARD_DAYTIME_WINDOWS.map((w) => {
      const sHm = parseHm(w.startHm)!;
      const eHm = parseHm(w.endHm)!;
      return {
        startMs: shanghaiDayStartMs(dKey, sHm.hour, sHm.minute),
        endMs: shanghaiDayStartMs(dKey, eHm.hour, eHm.minute),
      };
    });
    const totalClassSec = stdWindows.reduce(
      (acc, it) => acc + Math.floor((it.endMs - it.startMs) / 1000),
      0,
    );
    days.push({ dayKey: dKey, intervals: stdWindows, totalClassSec });
  }
  return { mode: 'standard-fallback', days };
}

/** 同时评估成员在指定一周的「最老实之人」与「三好学生」课中打卡重叠情况。 */
function evaluateClassAttendanceWeek(
  member: TitleEngineMember,
  weekDayKeys: string[],
  metrics: UserDailyMetrics,
  gradePeerSchedules: ReadonlyArray<BusyScheduleSnapshot>,
): ClassAttendanceWeekEval {
  const resolved = resolveClassWindowsForWeek(member, weekDayKeys, gradePeerSchedules);
  let honestHitDays = 0;
  let totalClassOverlapSec = 0;

  for (const day of resolved.days) {
    const overlapSec = computeIntervalsOverlapSeconds(
      metrics.dailyIntervals.get(day.dayKey) ?? [],
      day.intervals,
    );
    totalClassOverlapSec += overlapSec;

    const thresholdSec =
      resolved.mode === 'standard-fallback'
        ? 5400
        : Math.min(2700, Math.max(900, Math.floor(day.totalClassSec * 0.5)));
    if (overlapSec >= thresholdSec) {
      honestHitDays += 1;
    }
  }

  const classDays = resolved.days.length;
  // 个人/同年级课表模式：只要本周存在上课日且每一个上课日均达标即可解锁（兼容大三等每周仅 1–2 天有课的成员）
  const honestQualified =
    resolved.mode === 'standard-fallback'
      ? classDays >= 5 && honestHitDays >= 5
      : classDays > 0 && honestHitDays === classDays;

  return {
    mode: resolved.mode,
    classDays,
    honestHitDays,
    honestQualified,
    totalClassOverlapSec,
  };
}

/** 根据成员各称号解锁进度、历史累计次数、请求佩戴 ID 及隐藏列表，纯函数投影展示亮牌与图鉴项。 */
export function projectMemberTitleDisplay(
  statusById: Record<string, { unlocked: boolean; unlockCount?: number; progressText?: string }>,
  requestedEquip: string | null,
  hiddenTitleIds: ReadonlyArray<string>,
): {
  equippedTitleId: string | null;
  hiddenTitleIds: string[];
  displayTitles: MemberTitleBadge[];
  catalog: TitleEvaluationItem[];
} {
  const hiddenSet = new Set(hiddenTitleIds);
  const isHidden = (defId: string, hideable?: boolean): boolean =>
    Boolean(hideable && hiddenSet.has(defId));
  const resolveCount = (defId: string): number => {
    const st = statusById[defId];
    if (typeof st?.unlockCount === 'number') return st.unlockCount;
    return st?.unlocked ? 1 : 0;
  };

  const unlockedNonForced = TITLE_CATALOG.filter(
    (def) => !def.forced && statusById[def.id]?.unlocked && !isHidden(def.id, def.hideable),
  ).sort((a, b) => b.priority - a.priority);

  const validEquipped = requestedEquip
    ? unlockedNonForced.find((def) => def.id === requestedEquip) ?? null
    : null;
  const activePrimary = validEquipped ?? unlockedNonForced[0] ?? null;

  const activeForced = TITLE_CATALOG.filter(
    (def) => def.forced && statusById[def.id]?.unlocked && !isHidden(def.id, def.hideable),
  ).sort((a, b) => b.priority - a.priority);

  const displayTitles: MemberTitleBadge[] = [
    ...(activePrimary ? [toMemberTitleBadge(activePrimary, resolveCount(activePrimary.id))] : []),
    ...activeForced.map((def) => toMemberTitleBadge(def, resolveCount(def.id))),
  ];

  const catalog: TitleEvaluationItem[] = TITLE_CATALOG.map((def) => {
    const st = statusById[def.id] ?? { unlocked: false };
    const hidden = isHidden(def.id, def.hideable);
    return {
      ...toMemberTitleBadge(def, resolveCount(def.id)),
      unlocked: st.unlocked,
      equipped: Boolean(
        !hidden &&
          ((activePrimary && activePrimary.id === def.id) || (def.forced && st.unlocked)),
      ),
      ...(def.hideable ? { hidden } : {}),
      stackRuleText: def.stackRuleText,
      progressText: st.progressText,
    };
  });

  return {
    equippedTitleId: validEquipped?.id ?? null,
    hiddenTitleIds: [...hiddenSet],
    displayTitles,
    catalog,
  };
}

/** 评估全团队所有成员的 26 项自动称号、展示亮牌与进度文案。 */
export function evaluateTeamTitles(
  input: EvaluateTeamTitlesInput,
): Map<string, MemberTitleEvaluation> {
  const nowMs = input.now.getTime();
  const nowParts = getShanghaiParts(nowMs);
  const todayKey = formatDayKey(nowParts.year, nowParts.month, nowParts.day);
  const currentWeekKey = shanghaiWeekKeyOfMs(nowMs);
  const currentWeekStartMs = shanghaiDayStartMs(currentWeekKey);
  const currentWeekEndMs = currentWeekStartMs + 7 * DAY_MS;
  const prevWeek1Key = addShanghaiDays(currentWeekKey, -7);
  const prevWeek2Key = addShanghaiDays(currentWeekKey, -14);
  const prevWeek1EndMs = currentWeekStartMs;

  const curMonthDaysCount = daysInMonth(nowParts.year, nowParts.month);
  const prevYear = nowParts.month === 1 ? nowParts.year - 1 : nowParts.year;
  const prevMonth = nowParts.month === 1 ? 12 : nowParts.month - 1;
  const prevMonthDaysCount = daysInMonth(prevYear, prevMonth);

  const currentWeekDayKeys = Array.from({ length: 7 }, (_, i) =>
    addShanghaiDays(currentWeekKey, i),
  );
  const prevWeek1DayKeys = Array.from({ length: 7 }, (_, i) => addShanghaiDays(prevWeek1Key, i));
  const curMonthDayKeys = Array.from({ length: curMonthDaysCount }, (_, i) =>
    formatDayKey(nowParts.year, nowParts.month, i + 1),
  );
  const prevMonthDayKeys = Array.from({ length: prevMonthDaysCount }, (_, i) =>
    formatDayKey(prevYear, prevMonth, i + 1),
  );

  const metricsByUser = new Map<string, UserDailyMetrics>();
  const schedulesByGrade = new Map<number, BusyScheduleSnapshot[]>();
  for (const member of input.members) {
    metricsByUser.set(member.id, emptyMetrics());
    if (
      member.scheduleSnapshot &&
      Array.isArray(member.scheduleSnapshot.courses) &&
      member.scheduleSnapshot.courses.length > 0
    ) {
      const list = schedulesByGrade.get(member.enrollYear) ?? [];
      list.push(member.scheduleSnapshot);
      schedulesByGrade.set(member.enrollYear, list);
    }
  }

  for (const session of input.sessions) {
    const metrics = metricsByUser.get(session.userId);
    if (!metrics) continue;
    if (session.status === 'invalidated') continue;

    const startMs = session.checkInAt.getTime();
    const startParts = getShanghaiParts(startMs);
    const startDayKey = formatDayKey(startParts.year, startParts.month, startParts.day);

    let effectiveEndMs: number;
    let validDuration: number;

    if (session.status === 'completed') {
      const dur = session.durationSeconds ?? 0;
      if (dur <= 0 || dur >= MAX_VALID_SESSION_SECONDS) continue;
      validDuration = dur;
      effectiveEndMs = session.checkOutAt ? session.checkOutAt.getTime() : startMs + dur * 1000;
      metrics.recordedByWeek.set(
        session.weekKey,
        (metrics.recordedByWeek.get(session.weekKey) ?? 0) + dur,
      );
    } else {
      const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));
      if (elapsed >= MAX_VALID_SESSION_SECONDS) continue;
      validDuration = elapsed;
      effectiveEndMs = nowMs;
      if (session.weekKey === currentWeekKey) {
        metrics.activeCurrentWeekSeconds += elapsed;
      }
    }

    // 1. 早起鸟：上海时间 05:00 <= checkIn < 09:00
    if (startParts.hour >= 5 && startParts.hour < 9) {
      metrics.earlyBirdDays.add(startDayKey);
    }

    // 按上海自然日拆分区间，统计日时长、课表重叠片段、夜猫子（21:00 后仍在岗）与 00:00~09:00 耐通窗口
    const endDayKey = shanghaiDayKeyOfMs(effectiveEndMs);
    let cursorDayKey = startDayKey;
    let guard = 0;

    while (cursorDayKey <= endDayKey && guard < 3) {
      guard += 1;
      const dStartMs = shanghaiDayStartMs(cursorDayKey, 0);
      const dEndMs = dStartMs + DAY_MS;

      const clippedStart = Math.max(startMs, dStartMs);
      const clippedEnd = Math.min(effectiveEndMs, dEndMs);
      if (clippedEnd > clippedStart) {
        const list = metrics.dailyIntervals.get(cursorDayKey) ?? [];
        list.push({ startMs: clippedStart, endMs: clippedEnd });
        metrics.dailyIntervals.set(cursorDayKey, list);
      }

      const segSec =
        effectiveEndMs > startMs
          ? overlapSeconds(startMs, effectiveEndMs, dStartMs, dEndMs)
          : cursorDayKey === startDayKey
            ? validDuration
            : 0;
      if (segSec > 0) {
        metrics.dailySeconds.set(cursorDayKey, (metrics.dailySeconds.get(cursorDayKey) ?? 0) + segSec);
      }

      const nightStartMs = dStartMs + 21 * 3_600_000;
      if (effectiveEndMs >= nightStartMs && startMs < dEndMs) {
        if (effectiveEndMs > nightStartMs || startMs >= nightStartMs) {
          metrics.nightOwlDays.add(cursorDayKey);
        }
      }

      const dawnEndMs = dStartMs + 9 * 3_600_000;
      const dawnSec = overlapSeconds(startMs, effectiveEndMs, dStartMs, dawnEndMs);
      if (dawnSec > 0) {
        metrics.overnightSeconds.set(
          cursorDayKey,
          (metrics.overnightSeconds.get(cursorDayKey) ?? 0) + dawnSec,
        );
      }

      cursorDayKey = addShanghaiDays(cursorDayKey, 1);
    }
  }

  // 每个年级每天的最高打卡秒数（打卡之星）
  const gradeDailyMax = new Map<string, number>();
  for (const member of input.members) {
    const metrics = metricsByUser.get(member.id)!;
    for (const [dKey, sec] of metrics.dailySeconds.entries()) {
      if (sec <= 0) continue;
      const gKey = `${member.enrollYear}:${dKey}`;
      const prev = gradeDailyMax.get(gKey) ?? 0;
      if (sec > prev) gradeDailyMax.set(gKey, sec);
    }
  }

  // 吕洞宾 + 龙王：
  // 1) 本周 A 对 B 使用过正面卡，随后 B 对 A 使用过负面卡 -> A 解锁「吕洞宾」，记录 B 为触发者及触发时间；
  // 2) 之后 A 成功对 B 施加负面效果卡（applied !== false）-> A 解锁「龙王」。
  const luDongbinUsers = new Set<string>();
  const luDongbinCulpritsByVictim = new Map<string, Map<string, number>>();
  const dragonKingUsers = new Set<string>();
  const sortedInteractions = [...input.currentWeekCardInteractions].sort((a, b) => a.atMs - b.atMs);
  const earliestPositiveAt = new Map<string, number>();
  for (const evt of sortedInteractions) {
    if (evt.actorId === evt.targetId) continue;
    if (evt.polarity === 'positive') {
      const pairKey = `${evt.actorId}->${evt.targetId}`;
      if (!earliestPositiveAt.has(pairKey)) {
        earliestPositiveAt.set(pairKey, evt.atMs);
      }
    } else if (evt.polarity === 'negative') {
      // 检查是否构成对吕洞宾触发者的成功复仇（龙王）
      const culprits = luDongbinCulpritsByVictim.get(evt.actorId);
      const betrayedAt = culprits?.get(evt.targetId);
      if (betrayedAt !== undefined && evt.atMs > betrayedAt && evt.applied !== false) {
        dragonKingUsers.add(evt.actorId);
      }

      // 检查是否触发吕洞宾
      const reversePairKey = `${evt.targetId}->${evt.actorId}`;
      const helpedAt = earliestPositiveAt.get(reversePairKey);
      if (helpedAt !== undefined && evt.atMs > helpedAt) {
        luDongbinUsers.add(evt.targetId);
        let map = luDongbinCulpritsByVictim.get(evt.targetId);
        if (!map) {
          map = new Map();
          luDongbinCulpritsByVictim.set(evt.targetId, map);
        }
        if (!map.has(evt.actorId)) {
          map.set(evt.actorId, evt.atMs);
        }
      }
    }
  }

  const getWeekTotal = (userId: string, weekKey: string, includeActive = false): number => {
    const metrics = metricsByUser.get(userId)!;
    const recorded =
      (metrics.recordedByWeek.get(weekKey) ?? 0) +
      (includeActive && weekKey === currentWeekKey ? metrics.activeCurrentWeekSeconds : 0);
    const manual = input.manualAdjustmentsByUserWeek.get(`${userId}:${weekKey}`) ?? 0;
    const ent = input.entertainmentByUserWeek.get(`${userId}:${weekKey}`) ?? 0;
    return comprehensiveDurationSeconds(recorded, manual, ent);
  };

  const totalCatalogCards = input.totalCatalogCards ?? DEFAULT_CARD_CATALOG_SIZE;
  const releaseContributors = input.releaseContributors ?? [];
  const results = new Map<string, MemberTitleEvaluation>();
  const remainingWeekSeconds = Math.max(0, Math.floor((currentWeekEndMs - nowMs) / 1000));

  // 预先汇总全工作室上周/本周综合时长，用于「体力不支」（垫底）与「感到不安」（落后排行榜上一名 > 5h）
  const prevPunchedTotals: number[] = [];
  const curPunchedTotals: number[] = [];
  for (const m of input.members) {
    const met = metricsByUser.get(m.id)!;
    const existed = !m.createdAt || m.createdAt.getTime() < prevWeek1EndMs;
    const prevRec = met.recordedByWeek.get(prevWeek1Key) ?? 0;
    if (existed && prevRec > 0) {
      prevPunchedTotals.push(getWeekTotal(m.id, prevWeek1Key));
    }
    const curRec = (met.recordedByWeek.get(currentWeekKey) ?? 0) + met.activeCurrentWeekSeconds;
    if (curRec > 0) {
      curPunchedTotals.push(getWeekTotal(m.id, currentWeekKey, true));
    }
  }
  const prevMinTotal = prevPunchedTotals.length >= 2 ? Math.min(...prevPunchedTotals) : null;
  const prevMaxTotal = prevPunchedTotals.length >= 2 ? Math.max(...prevPunchedTotals) : null;
  const hasPrevStaminaSpread =
    prevMinTotal !== null && prevMaxTotal !== null && prevMinTotal < prevMaxTotal;
  const sortedDistinctPrevTotals = [...new Set(prevPunchedTotals)].sort((a, b) => a - b);
  const sortedDistinctCurTotals = [...new Set(curPunchedTotals)].sort((a, b) => a - b);
  const computeGapToPrevRank = (distinctAsc: number[], myTotal: number): number => {
    const nextHigher = distinctAsc.find((v) => v > myTotal);
    return nextHigher !== undefined ? nextHigher - myTotal : 0;
  };

  for (const member of input.members) {
    const metrics = metricsByUser.get(member.id)!;
    const goalSeconds = weeklyGoalSeconds(member.enrollYear);
    const persistentSet = new Set(member.persistentTitleIds ?? []);
    const hiddenSet = new Set(member.hiddenTitleIds ?? []);

    const prev1Recorded = metrics.recordedByWeek.get(prevWeek1Key) ?? 0;
    const curWeekRecorded =
      (metrics.recordedByWeek.get(currentWeekKey) ?? 0) + metrics.activeCurrentWeekSeconds;

    // 1. 打卡之星
    const topGradeDays = new Set<string>();
    for (const [dKey, sec] of metrics.dailySeconds.entries()) {
      if (sec <= 0) continue;
      const maxSec = gradeDailyMax.get(`${member.enrollYear}:${dKey}`) ?? 0;
      if (maxSec > 0 && sec >= maxSec) {
        topGradeDays.add(dKey);
      }
    }
    const punchStarRes = bestRecentConsecutiveStreak(topGradeDays, todayKey, 30, 6);

    // 2. 全勤之星
    const curWeekDaysOver1h = currentWeekDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const prevWeekDaysOver1h = prevWeek1DayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const weeklyPerfectUnlocked = curWeekDaysOver1h >= 7 || prevWeekDaysOver1h >= 7;

    // 3. 全勤之王
    const curMonthDaysOver1h = curMonthDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const prevMonthDaysOver1h = prevMonthDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const monthlyPerfectUnlocked =
      curMonthDaysOver1h >= curMonthDaysCount || prevMonthDaysOver1h >= prevMonthDaysCount;

    // 4. 夜猫子
    const nightOwlRes = bestRecentConsecutiveStreak(metrics.nightOwlDays, todayKey, 30, 1);

    // 5. 早起鸟
    const earlyBirdRes = bestRecentConsecutiveStreak(metrics.earlyBirdDays, todayKey, 30, 1);

    // 6. 传奇耐通王
    const allNighterDays = new Set<string>();
    for (const [dKey, sec] of metrics.overnightSeconds.entries()) {
      if (sec >= FOUR_HOURS_SECONDS) {
        allNighterDays.add(dKey);
      }
    }
    const allNighterRes = bestRecentConsecutiveStreak(allNighterDays, todayKey, 30, 6);

    // 7. 卡点王
    const prev1Total = getWeekTotal(member.id, prevWeek1Key);
    const prev2Total = getWeekTotal(member.id, prevWeek2Key);
    const prev1Hit = prev1Total >= goalSeconds && prev1Total <= goalSeconds + ONE_HOUR_SECONDS;
    const prev2Hit = prev2Total >= goalSeconds && prev2Total <= goalSeconds + ONE_HOUR_SECONDS;
    const deadlineMasterUnlocked = prev1Hit && prev2Hit;

    // 8. 金将军
    const curWeekDaysOver5h = currentWeekDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= FIVE_HOURS_SECONDS,
    ).length;
    const prevWeekDaysOver5h = prevWeek1DayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= FIVE_HOURS_SECONDS,
    ).length;
    const generalJinUnlocked = curWeekDaysOver5h >= 7 || prevWeekDaysOver5h >= 7;

    // 9. 想吃紫蛋了
    const existedLastWeek = !member.createdAt || member.createdAt.getTime() < prevWeek1EndMs;
    const purpleEggActive = existedLastWeek && prev1Total < goalSeconds;

    // 10. 吕洞宾
    const luDongbinUnlocked = luDongbinUsers.has(member.id);

    // 11. 相思了
    const currentWeekTotal = getWeekTotal(member.id, currentWeekKey, true);
    const remainingGoalSeconds = Math.max(0, goalSeconds - currentWeekTotal);
    const pressureRatio =
      remainingGoalSeconds <= 0
        ? 0
        : remainingWeekSeconds <= 0
          ? 1
          : remainingGoalSeconds / remainingWeekSeconds;
    const lovesickActive = remainingGoalSeconds > 0 && pressureRatio >= 0.3;

    // 14. 差一步美满（与周考核结算口径一致，按年级目标自适应综合时长：goal - 1h < prev1Total < goal）
    const almostPerfectUnlocked =
      existedLastWeek &&
      prev1Total > goalSeconds - ONE_HOUR_SECONDS &&
      prev1Total < goalSeconds;

    // 15 & 16. 赌王（每独立 5 连胜 +1，长期保留）/ 求求你戒赌吧（每独立 5 连败 +1，永久强制展示直至下次赌赢解除）
    const gambleEvents = [...(input.gambleEventsByUser?.get(member.id) ?? [])].sort(
      (a, b) => a.atMs - b.atMs,
    );
    let maxWinStreak = 0;
    let maxLoseStreak = 0;
    let curWinStreak = 0;
    let curLoseStreak = 0;
    let winBucket = 0;
    let loseBucket = 0;
    const gambleWinStreakKeys: string[] = [];
    const gambleLoseStreakKeys: string[] = [];
    for (const ge of gambleEvents) {
      if (ge.won) {
        curWinStreak += 1;
        winBucket += 1;
        curLoseStreak = 0;
        loseBucket = 0;
        if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
        if (winBucket === 5) {
          gambleWinStreakKeys.push(`win-streak:${ge.atMs}`);
          winBucket = 0;
        }
      } else {
        curLoseStreak += 1;
        loseBucket += 1;
        curWinStreak = 0;
        winBucket = 0;
        if (curLoseStreak > maxLoseStreak) maxLoseStreak = curLoseStreak;
        if (loseBucket === 5) {
          gambleLoseStreakKeys.push(`lose-streak:${ge.atMs}`);
          loseBucket = 0;
        }
      }
    }
    const gambleKingUnlocked = maxWinStreak >= 5 || persistentSet.has('gamble-king');
    const quitGamblingUnlocked = curLoseStreak >= 5;

    // 17. 龙王
    const dragonKingUnlocked = dragonKingUsers.has(member.id);

    // 18. 快思了（上周纯真实打卡为 0 且非本周新成员，自动强制亮牌）
    const almostGoneActive = existedLastWeek && prev1Recorded === 0;

    // 19. 贡献王（连续 3 次版本更新提交合并 PR，长期保留）
    const contribRes = hasConsecutiveReleaseContributions(
      releaseContributors,
      member.githubUsername,
      3,
    );
    const contributorKingUnlocked = contribRes.unlocked || persistentSet.has('contributor-king');

    // 20. 自古枪兵幸运e（抽 SSR 触发大保底，长期保留，每次触发按 receiptKey 累计升阶）
    const ssrPityReceiptKeys = input.ssrPityReceiptKeysByUser?.get(member.id) ?? [];
    const lancerLuckEUnlocked =
      ssrPityReceiptKeys.length > 0 ||
      (input.ssrPityUsers?.has(member.id) ?? false) ||
      persistentSet.has('lancer-luck-e');

    // 21 & 22. 收集者 / 收集之王（图鉴去重种类数，长期保留）
    const discoveredCount = member.discoveredCardCount ?? 0;
    const cardCollectorUnlocked = discoveredCount >= 5 || persistentSet.has('card-collector');
    const collectionKingUnlocked =
      discoveredCount >= totalCatalogCards || persistentSet.has('collection-king');

    // 11 & 23. 三好学生 & 最老实之人（共用 PR #13 课表快照 + 同年级课表 + 标准教学作息三级评估）
    const gradePeers = schedulesByGrade.get(member.enrollYear) ?? [];
    const curClassEval = evaluateClassAttendanceWeek(
      member,
      currentWeekDayKeys,
      metrics,
      gradePeers,
    );
    const prevClassEval = evaluateClassAttendanceWeek(
      member,
      prevWeek1DayKeys,
      metrics,
      gradePeers,
    );
    const mostHonestUnlocked = curClassEval.honestQualified || prevClassEval.honestQualified;
    // 三好学生：上周有有效打卡（≥ 1h，避免一整周不打卡误拿）且上周所有上课期间重叠 ≤ 5 分钟（零课中打卡）
    const GOOD_STUDENT_GRACE_SECONDS = 300;
    const goodStudentUnlocked =
      prev1Recorded >= ONE_HOUR_SECONDS &&
      prevClassEval.classDays > 0 &&
      prevClassEval.totalClassOverlapSec <= GOOD_STUDENT_GRACE_SECONDS;
    const formatClassFallbackLabel = (mode: ScheduleResolveMode): string =>
      mode === 'grade-fallback'
        ? '未导课表（按同年级课表兜底）· '
        : mode === 'standard-fallback'
          ? '未导课表（按标准教学时段兜底）· '
          : '';
    const curFallbackLabel = formatClassFallbackLabel(curClassEval.mode);
    // 按实际触发周对应的课表解析模式生成兜底文案，避免刚导课表或开学首周出现口径错位
    const mostHonestFallbackLabel = formatClassFallbackLabel(
      curClassEval.honestQualified
        ? curClassEval.mode
        : prevClassEval.honestQualified
          ? prevClassEval.mode
          : curClassEval.mode,
    );
    const goodStudentFallbackLabel = formatClassFallbackLabel(
      goodStudentUnlocked ? prevClassEval.mode : curClassEval.mode,
    );

    // 24. 神（单周纯真实打卡时长超过 50 小时）& 25. McGrady Time（单周纯真实打卡时长达到 35 小时）
    const bestRecordedWeekSec = Math.max(curWeekRecorded, prev1Recorded);
    const punchGodUnlocked =
      curWeekRecorded > FIFTY_HOURS_SECONDS || prev1Recorded > FIFTY_HOURS_SECONDS;
    const mcgradyTimeUnlocked =
      curWeekRecorded >= THIRTY_FIVE_HOURS_SECONDS || prev1Recorded >= THIRTY_FIVE_HOURS_SECONDS;

    // 26. 体力不支（上周已入驻且有有效打卡成员中综合时长垫底，强制亮牌）
    const lowStaminaActive =
      existedLastWeek &&
      prev1Recorded > 0 &&
      hasPrevStaminaSpread &&
      prev1Total === prevMinTotal;

    // 27. 感到不安（单周综合打卡时长落后排行榜紧邻上一名超过 5 小时）
    const curRankGapSec =
      curWeekRecorded > 0 ? computeGapToPrevRank(sortedDistinctCurTotals, currentWeekTotal) : 0;
    const prevRankGapSec =
      existedLastWeek && prev1Recorded > 0
        ? computeGapToPrevRank(sortedDistinctPrevTotals, prev1Total)
        : 0;
    const maxRankGapSec = Math.max(curRankGapSec, prevRankGapSec);
    const uneasyUnlocked =
      curRankGapSec > FIVE_HOURS_SECONDS || prevRankGapSec > FIVE_HOURS_SECONDS;

    const goalHours = Math.round(goalSeconds / 3600);

    const statusById: Record<string, { unlocked: boolean; progressText?: string }> = {
      'punch-god': {
        unlocked: punchGodUnlocked,
        progressText: punchGodUnlocked
          ? `已封神（最高单周纯打卡 ${(bestRecordedWeekSec / 3600).toFixed(1)}h）`
          : `本周纯打卡 ${(curWeekRecorded / 3600).toFixed(1)}h / 50h`,
      },
      'mcgrady-time': {
        unlocked: mcgradyTimeUnlocked,
        progressText: mcgradyTimeUnlocked
          ? `已进入麦迪时刻（最高单周纯打卡 ${(bestRecordedWeekSec / 3600).toFixed(1)}h）`
          : `本周纯打卡 ${(curWeekRecorded / 3600).toFixed(1)}h / 35h`,
      },
      'punch-star': {
        unlocked: punchStarRes.qualified3,
        progressText: punchStarRes.qualified3
          ? '已达成连续 3 天年级榜首'
          : `当前连霸 ${Math.min(3, punchStarRes.currentStreak)}/3 天`,
      },
      'contributor-king': {
        unlocked: contributorKingUnlocked,
        progressText: contributorKingUnlocked
          ? '已达成连续 3 次发版合并 PR（长期保留）'
          : !member.githubUsername
            ? '未绑定 GitHub 账号（绑定后自动统计 PR）'
            : `当前连续参与 ${Math.min(3, contribRes.currentStreak)}/3 个版本`,
      },
      'monthly-perfect': {
        unlocked: monthlyPerfectUnlocked,
        progressText: monthlyPerfectUnlocked
          ? '已达成整月全勤'
          : `本月已达标 ${curMonthDaysOver1h}/${curMonthDaysCount} 天`,
      },
      'collection-king': {
        unlocked: collectionKingUnlocked,
        progressText: collectionKingUnlocked
          ? `已集齐全部 ${totalCatalogCards} 种卡片（长期保留）`
          : `当前已收集 ${Math.min(totalCatalogCards, discoveredCount)}/${totalCatalogCards} 种卡片`,
      },
      'general-jin': {
        unlocked: generalJinUnlocked,
        progressText: generalJinUnlocked
          ? '已达成整周每日 5 小时'
          : `本周 ${curWeekDaysOver5h}/7 天超过 5 小时`,
      },
      'legend-allnighter': {
        unlocked: allNighterRes.qualified3,
        progressText: allNighterRes.qualified3
          ? '已达成连续 3 天通宵战绩'
          : `当前连续 ${Math.min(3, allNighterRes.currentStreak)}/3 天`,
      },
      'gamble-king': {
        unlocked: gambleKingUnlocked,
        progressText: gambleKingUnlocked
          ? '已达成 5 连胜赌神战绩（长期保留）'
          : `当前连胜 ${Math.min(5, curWinStreak)}/5 次（历史最高 ${Math.min(5, maxWinStreak)}/5）`,
      },
      'most-honest': {
        unlocked: mostHonestUnlocked,
        progressText: mostHonestUnlocked
          ? `${mostHonestFallbackLabel}已达成每天上课期间猛猛打卡`
          : curClassEval.classDays === 0
            ? `${curFallbackLabel}本周暂无排课`
            : `${curFallbackLabel}本周 ${curClassEval.honestHitDays}/${curClassEval.classDays} 个上课日达标`,
      },
      'good-student': {
        unlocked: goodStudentUnlocked,
        progressText: goodStudentUnlocked
          ? `${goodStudentFallbackLabel}上周上课期间零打卡，荣获三好学生`
          : curClassEval.classDays === 0
            ? `${curFallbackLabel}本周暂无排课`
            : curClassEval.totalClassOverlapSec > GOOD_STUDENT_GRACE_SECONDS
              ? `${curFallbackLabel}本周已在课中打卡 ${Math.round(curClassEval.totalClassOverlapSec / 60)} 分钟`
              : `${curFallbackLabel}本周目前课中零打卡（需整周保持且周打卡 ≥ 1h）`,
      },
      'weekly-perfect': {
        unlocked: weeklyPerfectUnlocked,
        progressText: weeklyPerfectUnlocked
          ? '已达成整周每日 1 小时'
          : `本周 ${curWeekDaysOver1h}/7 天超过 1 小时`,
      },
      'dragon-king': {
        unlocked: dragonKingUnlocked,
        progressText: dragonKingUnlocked
          ? '本周已对吕洞宾触发者成功反击'
          : luDongbinUnlocked
            ? '已触发吕洞宾，等待成功反击施害者'
            : '需先获得「吕洞宾」称号再成功反击',
      },
      'deadline-master': {
        unlocked: deadlineMasterUnlocked,
        progressText: deadlineMasterUnlocked
          ? '已连续 2 周精准压线'
          : prev1Hit
            ? '上周已压线（1/2 周）'
            : `目标区间 ${goalHours}–${goalHours + 1} 小时`,
      },
      'lu-dongbin': {
        unlocked: luDongbinUnlocked,
        progressText: luDongbinUnlocked ? '本周惨遭恩将仇报' : '本周尚未触发卡牌背刺事件',
      },
      'almost-perfect': {
        unlocked: almostPerfectUnlocked,
        progressText: almostPerfectUnlocked
          ? `上周结算综合时长 ${(prev1Total / 3600).toFixed(2)}h，差一步满 ${goalHours}h`
          : `目标区间 ${goalHours - 1}–${goalHours}h（按结算综合时长）`,
      },
      'lancer-luck-e': {
        unlocked: lancerLuckEUnlocked,
        progressText: lancerLuckEUnlocked
          ? '已触发过 SSR 大保底（长期保留）'
          : '尚未触发 70 抽 SSR 大保底',
      },
      'early-bird': {
        unlocked: earlyBirdRes.qualified3,
        progressText: earlyBirdRes.qualified3
          ? '已连续 3 天 9 点前打卡'
          : `当前连续 ${Math.min(3, earlyBirdRes.currentStreak)}/3 天`,
      },
      'night-owl': {
        unlocked: nightOwlRes.qualified3,
        progressText: nightOwlRes.qualified3
          ? '已连续 3 天 21 点后在岗'
          : `当前连续 ${Math.min(3, nightOwlRes.currentStreak)}/3 天`,
      },
      'card-collector': {
        unlocked: cardCollectorUnlocked,
        progressText: cardCollectorUnlocked
          ? `已收集 ${discoveredCount} 种卡片（长期保留）`
          : `当前已收集 ${Math.min(5, discoveredCount)}/5 种卡片`,
      },
      uneasy: {
        unlocked: uneasyUnlocked,
        progressText: uneasyUnlocked
          ? `落后排行榜上一名 ${(maxRankGapSec / 3600).toFixed(1)}h（> 5h）`
          : curRankGapSec > 0
            ? `当前落后上一名 ${(curRankGapSec / 3600).toFixed(1)}h / 5h`
            : '当前稳居前列或暂无有效差距',
      },
      'quit-gambling': {
        unlocked: quitGamblingUnlocked,
        progressText: quitGamblingUnlocked
          ? `已连续失败 ${curLoseStreak} 次（持续亮牌，下次赌赢即解除）`
          : `当前连败 ${Math.min(5, curLoseStreak)}/5 次（历史最高 ${Math.min(5, maxLoseStreak)}/5）`,
      },
      lovesick: {
        unlocked: lovesickActive,
        progressText:
          remainingGoalSeconds <= 0
            ? '本周已达标，毫无相思'
            : `当前欠账占比 ${Math.min(100, Math.round(pressureRatio * 100))}%（≥ 30% 触发）`,
      },
      'almost-gone': {
        unlocked: almostGoneActive,
        progressText: almostGoneActive
          ? '上周连续一整周 0 打卡记录'
          : existedLastWeek
            ? '上周已有有效打卡记录'
            : '新成员首周免挂预警',
      },
      'low-stamina': {
        unlocked: lowStaminaActive,
        progressText: lowStaminaActive
          ? `上周综合时长 ${(prev1Total / 3600).toFixed(1)}h，为有效打卡成员垫底`
          : !existedLastWeek
            ? '新成员首周免挂预警'
            : prev1Recorded === 0
              ? '上周无打卡记录（计入快思了）'
              : `上周综合时长 ${(prev1Total / 3600).toFixed(1)}h（未垫底）`,
      },
      'purple-egg': {
        unlocked: purpleEggActive,
        progressText: purpleEggActive
          ? `上周完成 ${(prev1Total / 3600).toFixed(1)}h / ${goalHours}h`
          : existedLastWeek
            ? '上周已顺利达标'
            : '新成员首周免挂紫蛋',
      },
    };

    const curMonthKey = `${nowParts.year}-${pad2(nowParts.month)}`;
    const prevMonthKey = `${prevYear}-${pad2(prevMonth)}`;
    const memberExistingByTitle = input.existingAchievementKeysByUser?.get(member.id);

    // 为全部 26 项称号提取本次评估窗口内命中的幂等达成键（用于 5 进制逢 5 进 1 升阶计数）
    const detectedKeysByTitleId: Record<string, string[]> = {
      'punch-god': [
        ...(curWeekRecorded > FIFTY_HOURS_SECONDS ? [`week:${currentWeekKey}`] : []),
        ...(prev1Recorded > FIFTY_HOURS_SECONDS ? [`week:${prevWeek1Key}`] : []),
      ],
      'punch-star': extractNonOverlappingStreakKeys(
        topGradeDays,
        3,
        memberExistingByTitle?.get('punch-star'),
      ),
      'mcgrady-time': [
        ...(curWeekRecorded >= THIRTY_FIVE_HOURS_SECONDS ? [`week:${currentWeekKey}`] : []),
        ...(prev1Recorded >= THIRTY_FIVE_HOURS_SECONDS ? [`week:${prevWeek1Key}`] : []),
      ],
      'contributor-king': contribRes.streakKeys,
      'monthly-perfect': [
        ...(curMonthDaysOver1h >= curMonthDaysCount ? [`month:${curMonthKey}`] : []),
        ...(prevMonthDaysOver1h >= prevMonthDaysCount ? [`month:${prevMonthKey}`] : []),
      ],
      'collection-king': collectionKingUnlocked ? ['once'] : [],
      'general-jin': [
        ...(curWeekDaysOver5h >= 7 ? [`week:${currentWeekKey}`] : []),
        ...(prevWeekDaysOver5h >= 7 ? [`week:${prevWeek1Key}`] : []),
      ],
      'legend-allnighter': extractNonOverlappingStreakKeys(
        allNighterDays,
        3,
        memberExistingByTitle?.get('legend-allnighter'),
      ),
      'gamble-king': gambleWinStreakKeys,
      'most-honest': [
        ...(curClassEval.honestQualified ? [`week:${currentWeekKey}`] : []),
        ...(prevClassEval.honestQualified ? [`week:${prevWeek1Key}`] : []),
      ],
      'weekly-perfect': [
        ...(curWeekDaysOver1h >= 7 ? [`week:${currentWeekKey}`] : []),
        ...(prevWeekDaysOver1h >= 7 ? [`week:${prevWeek1Key}`] : []),
      ],
      'good-student': goodStudentUnlocked ? [`week:${prevWeek1Key}`] : [],
      'dragon-king': dragonKingUnlocked ? [`week:${currentWeekKey}`] : [],
      'deadline-master': deadlineMasterUnlocked ? [`week:${prevWeek1Key}`] : [],
      'lu-dongbin': luDongbinUnlocked ? [`week:${currentWeekKey}`] : [],
      'almost-perfect': almostPerfectUnlocked ? [`week:${prevWeek1Key}`] : [],
      'lancer-luck-e':
        ssrPityReceiptKeys.length > 0
          ? ssrPityReceiptKeys.map((rk) => `ssr-pity:${rk}`)
          : input.ssrPityUsers?.has(member.id)
            ? ['ssr-pity:legacy']
            : [],
      'early-bird': extractNonOverlappingStreakKeys(
        metrics.earlyBirdDays,
        3,
        memberExistingByTitle?.get('early-bird'),
      ),
      'night-owl': extractNonOverlappingStreakKeys(
        metrics.nightOwlDays,
        3,
        memberExistingByTitle?.get('night-owl'),
      ),
      'card-collector': cardCollectorUnlocked ? ['once'] : [],
      // 感到不安保留本周实时亮牌提示，但永久成就累计仅按已结算的上周记账，避免周一瞬时落差全员误 +1
      uneasy: prevRankGapSec > FIVE_HOURS_SECONDS ? [`week:${prevWeek1Key}`] : [],
      'quit-gambling': gambleLoseStreakKeys,
      lovesick: lovesickActive ? [`week:${currentWeekKey}`] : [],
      'almost-gone': almostGoneActive ? [`week:${prevWeek1Key}`] : [],
      'low-stamina': lowStaminaActive ? [`week:${prevWeek1Key}`] : [],
      'purple-egg': purpleEggActive ? [`week:${prevWeek1Key}`] : [],
    };

    const newAchievementRecords: NewTitleAchievementRecord[] = [];
    const statusWithCounts: Record<
      string,
      { unlocked: boolean; unlockCount: number; progressText?: string }
    > = {};

    for (const def of TITLE_CATALOG) {
      const base = statusById[def.id] ?? { unlocked: false };
      const existingKeys = memberExistingByTitle?.get(def.id) ?? new Set<string>();
      const detectedKeys = detectedKeysByTitleId[def.id] ?? [];

      if (!def.stackable) {
        const hasEver = existingKeys.size > 0 || detectedKeys.length > 0 || base.unlocked || persistentSet.has(def.id);
        if (hasEver && existingKeys.size === 0) {
          newAchievementRecords.push({ titleId: def.id, occurrenceKey: 'once' });
        }
        statusWithCounts[def.id] = {
          unlocked: base.unlocked,
          unlockCount: hasEver ? 1 : 0,
          progressText: base.progressText,
        };
      } else {
        const merged = new Set<string>(existingKeys);
        for (const key of detectedKeys) {
          if (!merged.has(key)) {
            merged.add(key);
            newAchievementRecords.push({ titleId: def.id, occurrenceKey: key });
          }
        }
        // 兼容历史已写入 persistentTitleIds 或当前生效但尚未回溯出细粒度 key 的旧记录
        const minCount = base.unlocked || persistentSet.has(def.id) ? 1 : 0;
        statusWithCounts[def.id] = {
          unlocked: base.unlocked,
          unlockCount: Math.max(merged.size, minCount),
          progressText: base.progressText,
        };
      }
    }

    const newlyUnlockedPersistentTitleIds = TITLE_CATALOG.filter(
      (def) => def.persistent && statusById[def.id]?.unlocked && !persistentSet.has(def.id),
    ).map((def) => def.id);

    const projected = projectMemberTitleDisplay(
      statusWithCounts,
      member.equippedTitleId ?? null,
      [...hiddenSet],
    );

    results.set(member.id, {
      ...projected,
      newlyUnlockedPersistentTitleIds,
      newAchievementRecords,
    });
  }

  return results;
}
