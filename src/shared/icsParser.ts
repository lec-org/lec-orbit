/**
 * 通用 RFC 5545 (.ics) 日历解析器（基于 Mozilla 官方 `ical.js`）与中国法定节假日/调休转换器：
 * - 使用业界标准 `ical.js` 解析 Apple 日历 / 飞书日历 / Outlook / Google / webcal 订阅；
 * - 原生支持完整 VTIMEZONE、UTC 转换、全天独占 DTEND、折行反转义与 RRULE 重复日程展开；
 * - 提供 holiday-cn JSON 到统一订阅日历条目的纯转换工具（不再硬编码任何具体年份日期）。
 */
import ICAL from 'ical.js';
import { formatLocalDate, parseLocalDate } from './schedule';

export interface ParsedCalendarEntry {
  uid: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  /** 特殊日程角标：off=法定放假休、work=调休补班 */
  badge: 'off' | 'work' | null;
}

export interface HolidayCnDayRaw {
  name: string;
  date: string;
  isOffDay: boolean;
}

/** 将 holiday-cn 日期数组转换为统一的订阅日历条目（按日期去重） */
export function convertHolidayCnDaysToEntries(
  days: readonly HolidayCnDayRaw[],
): ParsedCalendarEntry[] {
  const byDate = new Map<string, ParsedCalendarEntry>();
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    const name = String(day.name ?? '').trim();
    if (!name) continue;
    const isOff = Boolean(day.isOffDay);
    byDate.set(day.date, {
      uid: `cn-holiday:${day.date}`,
      title: isOff ? `${name} · 休` : `${name}调休 · 班`,
      description: isOff ? `${name}法定节假日放假安排` : `${name}调休补班工作日`,
      location: '',
      allDay: true,
      startDate: day.date,
      endDate: day.date,
      startTime: '00:00',
      endTime: '23:59',
      badge: isOff ? 'off' : 'work',
    });
  }
  return Array.from(byDate.values()).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** 校验并规范化外部订阅 URL（支持 webcal:// 自动转 https://） */
export function normalizeSubscriptionUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('请输入日历订阅地址');
  const normalized = trimmed.replace(/^webcal:\/\//i, 'https://');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('订阅地址格式无效，请输入有效的 https:// 或 webcal:// 链接');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http://、https:// 或 webcal:// 日历订阅链接');
  }
  return parsed.toString();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function shiftDate(dateStr: string, deltaDays: number): string {
  const d = parseLocalDate(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + deltaDays);
  return formatLocalDate(d);
}

function icalTimeToLocalParts(t: ICAL.Time): { allDay: boolean; date: string; time: string } {
  if (t.isDate) {
    return {
      allDay: true,
      date: `${t.year}-${pad2(t.month)}-${pad2(t.day)}`,
      time: '00:00',
    };
  }
  const jsDate = t.toJSDate();
  return {
    allDay: false,
    date: formatLocalDate(jsDate),
    time: `${pad2(jsDate.getHours())}:${pad2(jsDate.getMinutes())}`,
  };
}

function buildEntryFromRange(params: {
  uid: string;
  summary: string;
  description: string;
  location: string;
  badge: 'off' | 'work' | null;
  startTimeObj: ICAL.Time;
  endTimeObj: ICAL.Time | null;
}): ParsedCalendarEntry {
  const start = icalTimeToLocalParts(params.startTimeObj);
  const end = params.endTimeObj ? icalTimeToLocalParts(params.endTimeObj) : null;

  let endDate = end?.date ?? start.date;
  let endTime = end?.time ?? (start.allDay ? '23:59' : start.time);

  // RFC 5545 规范：全天事件的 DTEND 为独占的下一天
  if (start.allDay && end && end.allDay && end.date > start.date) {
    endDate = shiftDate(end.date, -1);
    if (endDate < start.date) endDate = start.date;
  }
  if (!start.allDay && (!end || (endDate === start.date && endTime <= start.time))) {
    const [h, m] = start.time.split(':').map(Number);
    const total = Math.min(23 * 60 + 59, (h ?? 9) * 60 + (m ?? 0) + 60);
    endTime = `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  }

  return {
    uid: params.uid,
    title: params.summary.slice(0, 120),
    description: params.description.slice(0, 1000),
    location: params.location.slice(0, 120),
    allDay: start.allDay,
    startDate: start.date,
    endDate: endDate >= start.date ? endDate : start.date,
    startTime: start.allDay ? '00:00' : start.time,
    endTime: start.allDay ? '23:59' : endTime,
    badge: params.badge,
  };
}

/**
 * 使用 Mozilla 官方 `ical.js` 解析标准 RFC 5545 `.ics` 文本：
 * - 自动支持折行、VTIMEZONE、转义文本、全天/跨天事件、Apple 特殊假日标记；
 * - 对带有 RRULE 的重复日程自动展开至当前年份前后窗口（最多单条 260 次，防止无限循环）。
 */
export function parseIcsEvents(
  icsText: string,
  options?: { referenceDate?: Date },
): {
  calendarName: string;
  entries: ParsedCalendarEntry[];
} {
  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);

  // 注册文件内自带的 VTIMEZONE，确保非 UTC 命名时区准确转换
  for (const tzComp of comp.getAllSubcomponents('vtimezone')) {
    try {
      const tz = new ICAL.Timezone(tzComp);
      if (tz.tzid) {
        ICAL.TimezoneService.register(tz);
      }
    } catch {
      // 忽略异常 VTIMEZONE 块
    }
  }

  const rawCalName = comp.getFirstPropertyValue('x-wr-calname');
  const calendarName = typeof rawCalName === 'string' ? rawCalName.trim().slice(0, 40) : '';

  const ref = options?.referenceDate ?? new Date();
  const windowStart = new Date(ref.getFullYear() - 1, 0, 1);
  const windowEnd = new Date(ref.getFullYear() + 2, 11, 31, 23, 59, 59);

  const entries: ParsedCalendarEntry[] = [];
  const vevents = comp.getAllSubcomponents('vevent');

  for (let i = 0; i < vevents.length; i += 1) {
    const vevent = vevents[i]!;
    let event: ICAL.Event;
    try {
      event = new ICAL.Event(vevent);
    } catch {
      continue;
    }

    const summary = String(event.summary ?? '').trim();
    if (!summary || !event.startDate) continue;

    const uid = String(event.uid ?? '').trim() || `ics:${i}`;
    const description = String(event.description ?? '').trim();
    const location = String(event.location ?? '').trim();
    const specialDayVal = String(vevent.getFirstPropertyValue('x-apple-special-day') ?? '').trim();

    let badge: 'off' | 'work' | null = null;
    if (/ALTERNATE-WORKDAY/i.test(specialDayVal) || /补班|调休上班/.test(summary)) {
      badge = 'work';
    } else if (/WORK-HOLIDAY/i.test(specialDayVal) || /放假|法定假日/.test(summary)) {
      badge = 'off';
    }

    if (event.isRecurring()) {
      const iter = event.iterator();
      let next: ICAL.Time | null;
      let count = 0;
      const MAX_OCCURRENCES = 260;

      while ((next = iter.next()) && count < MAX_OCCURRENCES) {
        const jsStart = next.toJSDate();
        if (jsStart > windowEnd) break;
        if (jsStart < windowStart) continue;
        const occ = event.getOccurrenceDetails(next);
        entries.push(
          buildEntryFromRange({
            uid: `${uid}#${next.toString()}`,
            summary,
            description,
            location,
            badge,
            startTimeObj: occ.startDate,
            endTimeObj: occ.endDate ?? null,
          }),
        );
        count += 1;
      }
    } else {
      entries.push(
        buildEntryFromRange({
          uid,
          summary,
          description,
          location,
          badge,
          startTimeObj: event.startDate,
          endTimeObj: event.endDate ?? null,
        }),
      );
    }
  }

  return { calendarName, entries };
}
