/**
 * 日历订阅远程拉取与本地 .ics 文件读取服务（Electron 主进程）：
 * - 默认中国法定节假日与调休源：按年多 CDN 容灾拉取 NateScarlet/holiday-cn JSON；
 * - 外部 .ics / webcal 订阅源：经由 ssrfGuard 校验公网 IP（DNS-pinned 防 Rebinding）、流式限长与全程超时；
 * - 本地 .ics 文件导入：弹出系统原生文件选择框并解析事件列表。
 */
import { dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  convertHolidayCnDaysToEntries,
  normalizeSubscriptionUrl,
  parseIcsEvents,
  type HolidayCnDayRaw,
  type ParsedCalendarEntry,
} from '../../src/shared/icsParser';
import { fetchTextSafely, isPrivateOrReservedIp } from './ssrfGuard';

export { isPrivateOrReservedIp };

const HOLIDAY_CDN_TEMPLATES = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
] as const;

const MAX_ICS_BYTES = 5 * 1024 * 1024; // 限制单次订阅/导入最大 5MB

async function fetchHolidayYear(year: number): Promise<HolidayCnDayRaw[] | null> {
  for (const tpl of HOLIDAY_CDN_TEMPLATES) {
    const url = tpl.replace('{year}', String(year));
    try {
      const res = await fetchTextSafely(url, {
        timeoutMs: 6_000,
        maxBytes: 1024 * 1024,
        checkSsrf: false,
      });
      if (!res.ok) continue;
      const json = JSON.parse(res.text) as { days?: unknown };
      if (!Array.isArray(json?.days)) continue;
      const days: HolidayCnDayRaw[] = [];
      for (const item of json.days) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.date === 'string' && typeof rec.name === 'string') {
          days.push({
            date: rec.date,
            name: rec.name,
            isOffDay: Boolean(rec.isOffDay),
          });
        }
      }
      if (days.length > 0) return days;
    } catch {
      // 当前镜像超时或不可达时尝试下一镜像
    }
  }
  return null;
}

/**
 * 在线拉取中国法定节假日与调休数据（多 CDN 节点自动容灾）：
 * - 拉取前一年、当前年与下一年（覆盖跨年学期与次年放假预告）；
 * - 全部拉取失败时抛出错误，由调用方保留本地 SQLite 中已缓存的数据并等待下次重试。
 */
export async function syncCnHolidaysData(
  baseYear: number = new Date().getFullYear(),
): Promise<{ entries: ParsedCalendarEntry[] }> {
  const targetYears = [baseYear - 1, baseYear, baseYear + 1];
  const merged = new Map<string, HolidayCnDayRaw>();

  const results = await Promise.all(targetYears.map((y) => fetchHolidayYear(y)));
  for (const yearDays of results) {
    if (yearDays && yearDays.length > 0) {
      for (const d of yearDays) {
        merged.set(d.date, d);
      }
    }
  }

  if (merged.size === 0) {
    throw new Error('在线节假日源暂不可达，请检查网络后点击同步重试');
  }

  return {
    entries: convertHolidayCnDaysToEntries(Array.from(merged.values())),
  };
}

/** 拉取并解析远程 .ics / webcal:// 订阅日历（内置 DNS-pinned SSRF 防护、流式限长与全程超时） */
export async function fetchIcsSubscription(rawUrl: string): Promise<{
  normalizedUrl: string;
  calendarName: string;
  entries: ParsedCalendarEntry[];
}> {
  const normalizedUrl = normalizeSubscriptionUrl(rawUrl);
  const res = await fetchTextSafely(normalizedUrl, {
    timeoutMs: 12_000,
    maxBytes: MAX_ICS_BYTES,
    checkSsrf: true,
  });
  if (!res.ok) {
    throw new Error(`拉取订阅日历失败（HTTP ${res.status}）`);
  }
  const text = res.text;
  if (!text.includes('BEGIN:VCALENDAR') && !text.includes('BEGIN:VEVENT')) {
    throw new Error('目标链接返回的不是有效的 .ics 日历文件');
  }
  const parsed = parseIcsEvents(text);
  return {
    normalizedUrl,
    calendarName: parsed.calendarName,
    entries: parsed.entries,
  };
}

/** 弹出系统文件选择框读取本地 .ics 文件并解析 */
export async function pickAndParseLocalIcsFile(
  ownerWindow: BrowserWindow | null,
): Promise<{
  canceled: boolean;
  fileName?: string;
  calendarName?: string;
  entries?: ParsedCalendarEntry[];
}> {
  const pickerOpts: Electron.OpenDialogOptions = {
    title: '选择要导入的 .ics 日历文件',
    properties: ['openFile'],
    filters: [
      { name: 'iCalendar 日历文件', extensions: ['ics', 'ical'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, pickerOpts)
    : await dialog.showOpenDialog(pickerOpts);

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0]!;
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_ICS_BYTES) {
    throw new Error('选择的 .ics 文件超过 5MB 限制');
  }
  const text = await fs.readFile(filePath, 'utf8');
  if (!text.includes('BEGIN:VCALENDAR') && !text.includes('BEGIN:VEVENT')) {
    throw new Error('所选文件不是有效的 .ics 日历格式');
  }
  const parsed = parseIcsEvents(text);
  const baseName = path.basename(filePath, path.extname(filePath)).slice(0, 40);
  return {
    canceled: false,
    fileName: baseName,
    calendarName: parsed.calendarName || baseName || '导入日历',
    entries: parsed.entries,
  };
}
