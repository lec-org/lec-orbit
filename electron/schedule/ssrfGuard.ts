/**
 * 零 Electron 依赖的公网 SSRF 防护与 DNS-pinned 安全文本拉取模块：
 * - IPv6 完整展开为 8 组 16-bit 整数做 128-bit 判定（防 IPv4-compatible / IPv4-translated / NAT64 / 6to4 / Site-local / 零展开绕过）；
 * - 带超时的 DNS 解析 + node:http/https 自定义 lookup 将实际连接 pin 到已校验公网 IP（保留原 hostname 作 SNI 与 Host），根治 TTL=0 DNS Rebinding；
 * - 手动校验每一跳 3xx 重定向并立即释放跳转响应体，流式读取严格限长防止 chunked OOM，全程受统一截止时间约束。
 */
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 判断 IPv4 四元组是否属于回环、私网、链路本地、云元数据或保留网段。 */
function isPrivateOrReservedIpv4Parts(a: number, b: number, c: number, d: number): boolean {
  if (
    !Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) || !Number.isInteger(d) ||
    a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255
  ) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local / Cloud Metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true; // IETF Protocol Assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播与保留地址
  return false;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true;
  return isPrivateOrReservedIpv4Parts(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
}

/** 将任意合法 IPv6 字符串（含压缩 :: 与末尾点分 IPv4 形式）展开为 8 组 16-bit 无符号整数。 */
function parseIpv6Hextets(raw: string): number[] | null {
  const withoutZone = raw.split('%')[0] ?? '';
  let input = withoutZone.toLowerCase();

  // 处理末尾嵌入的点分十进制 IPv4（例如 ::ffff:127.0.0.1、64:ff9b::10.0.0.1）
  const lastColon = input.lastIndexOf(':');
  const tail = lastColon >= 0 ? input.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    if (net.isIP(tail) !== 4) return null;
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleParts = input.split('::');
  if (doubleParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const nums: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      nums.push(parseInt(tok, 16));
    }
    return nums;
  };

  if (doubleParts.length === 1) {
    const full = parseSide(doubleParts[0]!);
    return full && full.length === 8 ? full : null;
  }

  const left = parseSide(doubleParts[0]!);
  const right = parseSide(doubleParts[1]!);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isEmbeddedIpv4Private(hi: number, lo: number): boolean {
  return isPrivateOrReservedIpv4Parts((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);
}

/** 128-bit 判断 IPv4 / IPv6 地址是否属于禁止访问的私网、回环、云元数据或过渡保留地址。 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateOrReservedIpv4(ip);
  }
  if (version === 6) {
    const h = parseIpv6Hextets(ip);
    if (!h) return true;
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    // 未指定 :: 与回环 ::1（含 0:0:0:0:0:0:0:1）及 IPv4-compatible ::/96
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      if (h6 === 0 && (h7 === 0 || h7 === 1)) return true;
      return true; // IPv4-compatible 已废弃且可嵌入任意内网 IPv4，统一拒绝
    }
    // IPv4-mapped ::ffff:0:0/96
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      return isEmbeddedIpv4Private(h6, h7);
    }
    // IPv4-translated ::ffff:0:0:0/96
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
      return isEmbeddedIpv4Private(h6, h7);
    }
    // NAT64 Well-Known Prefix 64:ff9b::/96 & Local-Use 64:ff9b:1::/48
    if (h0 === 0x0064 && h1 === 0xff9b) {
      if (h2 === 0x0001) return true;
      if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
        return isEmbeddedIpv4Private(h6, h7);
      }
    }
    // 6to4 2002::/16（第 2、3 hextet 嵌入 IPv4）
    if (h0 === 0x2002) {
      return isEmbeddedIpv4Private(h1, h2);
    }
    // Teredo 2001:0000::/32 与文档地址 2001:db8::/32、Discard 100::/64
    if (h0 === 0x2001 && (h1 === 0x0000 || h1 === 0x0db8)) return true;
    if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
    // Unique Local fc00::/7
    if ((h0 & 0xfe00) === 0xfc00) return true;
    // Link-Local fe80::/10 & Site-Local fec0::/10
    if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return true;
    // Multicast ff00::/8
    if ((h0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

interface ResolvedPublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

async function dnsLookupWithTimeout(
  hostname: string,
  timeoutMs: number,
): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), Math.max(500, timeoutMs));
  });
  try {
    return await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 校验目标 URL 并返回已校验的公网连接 IP，供后续请求 pin 住真实连接防止 DNS Rebinding。 */
async function resolveAndValidatePublicTarget(
  rawUrl: string,
  remainingMs: number,
): Promise<ResolvedPublicTarget> {
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
  const ipVer = net.isIP(bareHost);
  if (ipVer === 4 || ipVer === 6) {
    if (isPrivateOrReservedIp(bareHost)) {
      throw new Error('安全策略禁止订阅内网或保留 IP 地址的日历');
    }
    return { url: parsed, address: bareHost, family: ipVer };
  }

  const resolved = await dnsLookupWithTimeout(bareHost, Math.min(5_000, remainingMs));
  if (resolved.length === 0) {
    throw new Error(`无法解析订阅域名：${bareHost}`);
  }
  for (const rec of resolved) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('安全策略禁止订阅解析到内网或本机地址的日历');
    }
  }
  const chosen = resolved[0]!;
  return {
    url: parsed,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  };
}

interface SingleHopResult {
  status: number;
  location?: string;
  text: string;
}

/** 单跳 HTTP/HTTPS 请求（可选将 TCP 连接 pin 到预先校验的公网 IP，并保留原 hostname 作 SNI）。 */
function requestSingleHop(
  url: URL,
  pinned: { address: string; family: 4 | 6 } | null,
  remainingMs: number,
  maxBytes: number,
): Promise<SingleHopResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    let settled = false;
    const done = (err: Error | null, result?: SingleHopResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result!);
    };

    const reqOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Host: url.host,
        'User-Agent': 'LEC-Orbit-Calendar/1.0',
        Accept: 'application/json, text/calendar, text/plain, */*',
        'Accept-Encoding': 'identity',
      },
      ...(isHttps ? { servername: url.hostname } : {}),
      ...(pinned
        ? {
            lookup: ((
              _hostname: string,
              opts: unknown,
              cb?: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
            ) => {
              const callback = typeof opts === 'function' ? (opts as typeof cb) : cb;
              const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
              if (all) {
                callback?.(null, [{ address: pinned.address, family: pinned.family }]);
              } else {
                callback?.(null, pinned.address, pinned.family);
              }
            }) as unknown as http.RequestOptions['lookup'],
          }
        : {}),
    };

    const req = mod.request(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;

      if (status >= 300 && status < 400 && location) {
        // 及时消费并释放重定向响应流，避免底层套接字占用泄漏
        res.resume();
        done(null, { status, location, text: '' });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        done(null, { status, text: '' });
        return;
      }

      const contentLength = Number(res.headers['content-length'] ?? '0');
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        res.destroy();
        req.destroy();
        done(new Error(`订阅日历文件超过 ${Math.round(maxBytes / (1024 * 1024))}MB 限制`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.byteLength;
        if (totalBytes > maxBytes) {
          res.destroy();
          req.destroy();
          done(new Error(`订阅日历内容超过 ${Math.round(maxBytes / (1024 * 1024))}MB 限制`));
          return;
        }
        chunks.push(buf);
      });
      res.on('end', () => {
        done(null, { status, text: Buffer.concat(chunks, totalBytes).toString('utf8') });
      });
      res.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
    });

    const timer = setTimeout(() => {
      req.destroy(new Error('拉取订阅日历超时'));
    }, Math.max(500, remainingMs));

    req.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
    req.end();
  });
}

/** 带全程超时、DNS-pinned SSRF 防护、重定向逐跳复检与流式体积上限的文本拉取函数。 */
export async function fetchTextSafely(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; checkSsrf?: boolean } = {},
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const checkSsrf = options.checkSsrf ?? true;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('拉取订阅日历超时');
    }

    let targetUrl: URL;
    let pinned: { address: string; family: 4 | 6 } | null = null;
    if (checkSsrf) {
      const resolved = await resolveAndValidatePublicTarget(currentUrl, remaining);
      targetUrl = resolved.url;
      pinned = { address: resolved.address, family: resolved.family };
    } else {
      targetUrl = new URL(currentUrl);
    }

    const hopRes = await requestSingleHop(targetUrl, pinned, deadline - Date.now(), maxBytes);
    if (hopRes.status >= 300 && hopRes.status < 400 && hopRes.location) {
      if (hop === MAX_REDIRECTS) {
        throw new Error('订阅日历重定向次数过多');
      }
      currentUrl = new URL(hopRes.location, targetUrl).toString();
      continue;
    }

    return {
      ok: hopRes.status >= 200 && hopRes.status < 300,
      status: hopRes.status,
      text: hopRes.text,
      finalUrl: targetUrl.toString(),
    };
  }

  throw new Error('订阅日历重定向次数过多');
}
