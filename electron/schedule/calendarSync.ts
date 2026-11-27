/**
 * 日历订阅远程拉取与本地 .ics 文件读取服务（Electron 主进程）：
 * - 默认中国法定节假日与调休源：按年多 CDN 容灾拉取 NateScarlet/holiday-cn JSON，失败回退内置 2026–2027 快照；
 * - 外部 .ics / webcal 订阅源：安全校验协议、限制响应体积与超时，解析 RFC 5545 VEVENT；
 * - 本地 .ics 文件导入：弹出系统原生文件选择框并解析事件列表。
 */
import { dialog, type BrowserWindow } from 'electron';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  convertHolidayCnDaysToEntries,
  normalizeSubscriptionUrl,
  parseIcsEvents,
  type HolidayCnDayRaw,
  type ParsedCalendarEntry,
} from '../../src/shared/icsParser';

const HOLIDAY_CDN_TEMPLATES = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
] as const;

const MAX_ICS_BYTES = 5 * 1024 * 1024; // 限制单次订阅/导入最大 5MB
const MAX_REDIRECTS = 5;

/** 判断 IPv4 地址是否属于回环、私网、链路本地、云元数据或保留网段。 */
function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local / Cloud Metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
  if (a >= 224) return true; // 组播与保留地址
  return false;
}

/** 判断 IPv4 / IPv6 地址是否属于禁止访问的私网/回环/云元数据地址。 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateOrReservedIpv4(ip);
  }
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    // IPv4-mapped IPv6（::ffff:127.0.0.1 或 ::ffff:7f00:1）
    if (ip.startsWith('::ffff:')) {
      const tail = ip.slice(7);
      if (net.isIP(tail) === 4) return isPrivateOrReservedIpv4(tail);
      const hexParts = tail.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0]!, 16);
        const lo = parseInt(hexParts[1]!, 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateOrReservedIpv4(
            `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
          );
        }
      }
      return true;
    }
    const firstHextet = parseInt(ip.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // Unique local fc00::/7
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
    if ((firstHextet & 0xff00) === 0xff00) return true; // Multicast ff00::/8
    return false;
  }
  return true;
}

/** 校验订阅链接是否为安全公网目标（防止 SSRF 访问回环、内网或云元数据服务）。 */
async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http:// 或 https:// 日历订阅链接');
  }
  if (parsed.username || parsed.password) {
    throw new Error('日历订阅链接不支持嵌入账号密码凭据');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('安全策略禁止订阅本机或内网域名日历');
  }
  const bareHost = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bareHost)) {
    if (isPrivateOrReservedIp(bareHost)) {
      throw new Error('安全策略禁止订阅内网或保留 IP 地址的日历');
    }
    return parsed;
  }
  const resolved = await dns.lookup(bareHost, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error(`无法解析订阅域名：${bareHost}`);
  }
  for (const rec of resolved) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('安全策略禁止订阅解析到内网或本机地址的日历');
    }
  }
  return parsed;
}

/**
 * 带全程超时、手动重定向 SSRF 复检与流式体积上限保护的文本拉取函数，
 * 防止慢速响应体挂死与 chunked 巨包导致 OOM。
 */
async function fetchTextSafely(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; checkSsrf?: boolean } = {},
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxBytes = options.maxBytes ?? MAX_ICS_BYTES;
  const checkSsrf = options.checkSsrf ?? true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = rawUrl;
    let res: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (checkSsrf) {
        await assertSafePublicUrl(currentUrl);
      }
      res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'LEC-Orbit-Calendar/1.0',
          Accept: 'application/json, text/calendar, text/plain, */*',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        if (hop === MAX_REDIRECTS) {
          throw new Error('订阅日历重定向次数过多');
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!res) {
      throw new Error('无法连接到目标日历服务器');
    }
    if (!res.ok) {
      return { ok: false, status: res.status, text: '', finalUrl: currentUrl };
    }

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`订阅日历文件超过 ${Math.round(maxBytes / (1024 * 1024))}MB 限制`);
    }

    if (!res.body) {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`订阅日历内容超过 ${Math.round(maxBytes / (1024 * 1024))}MB 限制`);
      }
      return { ok: true, status: res.status, text, finalUrl: currentUrl };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`订阅日历内容超过 ${Math.round(maxBytes / (1024 * 1024))}MB 限制`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const text = Buffer.concat(chunks, totalBytes).toString('utf8');
    return { ok: true, status: res.status, text, finalUrl: currentUrl };
  } finally {
    clearTimeout(timer);
  }
}

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

/** 拉取并解析远程 .ics / webcal:// 订阅日历（内置公网 SSRF 防护、流式限长与全程超时） */
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
