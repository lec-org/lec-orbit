/**
 * Orbit 本地 LecDoc 前端宿主与透明反代服务：
 * - 开发态（ORBIT_DOC_DEV_URL）：直连本地 LecDoc Vite Dev Server（含 HMR WebSocket），改代码实时热更新，无需先发线上。
 * - 打包/本地构建态（bundled）：从安装包内置 resources/lec-doc-dist（或仓库 apps/lec-doc/apps/lec-doc/dist）秒开静态资源。
 * - 所有 /api、/socket.io、/collab（HTTP + WebSocket）透明转发到 https://doc.lecspace.top，
 *   并双向同步 persist:lec-orbit 分区下的认证 Cookie，确保 SSO 免登、附件读取与 Yjs 实时协同 100% 原生可用。
 */
import { session } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { getOrbitEndpoints } from '../../src/shared/env';
import { ORBIT_SHARED_PARTITION } from '../auth/authService';

export type LocalDocHostMode = 'dev' | 'bundled' | 'remote';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function isBackendProxyPath(urlPath: string): boolean {
  return (
    urlPath === '/api' ||
    urlPath.startsWith('/api/') ||
    urlPath.startsWith('/api?') ||
    urlPath === '/socket.io' ||
    urlPath.startsWith('/socket.io/') ||
    urlPath.startsWith('/socket.io?') ||
    urlPath === '/collab' ||
    urlPath.startsWith('/collab/') ||
    urlPath.startsWith('/collab?')
  );
}

function resolveBundledDocDistDir(): string | null {
  const candidates = [
    process.env.ORBIT_DOC_DIST_DIR?.trim(),
    process.resourcesPath ? path.join(process.resourcesPath, 'lec-doc-dist') : undefined,
    path.resolve(__dirname, '../../resources/lec-doc-dist'),
    path.resolve(__dirname, '../../../lec-doc/apps/lec-doc/dist'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) {
        return dir;
      }
    } catch {
      // 忽略不可访问路径
    }
  }
  return null;
}

function sanitizeSetCookieForLocalhost(raw: string): string {
  return raw
    .replace(/;\s*domain=[^;]+/gi, '')
    .replace(/;\s*secure\b/gi, '')
    .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
}

function parseSetCookieForSession(raw: string, upstreamOrigin: string): Electron.CookiesSetDetails | null {
  const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const eqIdx = parts[0]!.indexOf('=');
  if (eqIdx <= 0) return null;
  const name = parts[0]!.slice(0, eqIdx).trim();
  const value = parts[0]!.slice(eqIdx + 1).trim();
  const details: Electron.CookiesSetDetails = {
    url: upstreamOrigin,
    name,
    value,
    path: '/',
    secure: upstreamOrigin.startsWith('https://'),
  };
  for (const attr of parts.slice(1)) {
    const [kRaw, ...vParts] = attr.split('=');
    const key = kRaw?.trim().toLowerCase();
    const val = vParts.join('=').trim();
    if (key === 'path' && val) details.path = val;
    else if (key === 'httponly') details.httpOnly = true;
    else if (key === 'secure') details.secure = true;
    else if (key === 'max-age') {
      const secs = Number(val);
      if (Number.isFinite(secs)) {
        details.expirationDate = Math.floor(Date.now() / 1000) + secs;
      }
    } else if (key === 'expires') {
      const ts = Date.parse(val);
      if (!Number.isNaN(ts)) {
        details.expirationDate = Math.floor(ts / 1000);
      }
    } else if (key === 'samesite') {
      const lower = val.toLowerCase();
      if (lower === 'strict') details.sameSite = 'strict';
      else if (lower === 'lax') details.sameSite = 'lax';
      else if (lower === 'none') details.sameSite = 'no_restriction';
    }
  }
  return details;
}

export class LocalDocHost {
  private server: http.Server | null = null;
  private localOrigin: string | null = null;
  private mode: LocalDocHostMode = 'remote';
  private devUrl: URL | null = null;
  private distDir: string | null = null;
  private readonly upstreamUrl: URL;

  constructor() {
    this.upstreamUrl = new URL(getOrbitEndpoints().docWebUrl);
  }

  getMode(): LocalDocHostMode {
    return this.mode;
  }

  getLocalOrigin(): string | null {
    return this.localOrigin;
  }

  getUpstreamOrigin(): string {
    return this.upstreamUrl.origin;
  }

  /** 将本地托管 URL 还原为规范的线上公开链接（用于复制、浏览器打开、访问历史与编辑权申请）。 */
  toCanonicalUrl(rawUrl: string): string {
    if (!this.localOrigin) return rawUrl;
    if (rawUrl.startsWith(this.localOrigin)) {
      return `${this.upstreamUrl.origin}${rawUrl.slice(this.localOrigin.length)}`;
    }
    return rawUrl;
  }

  /** 将规范线上文档链接映射为本地托管 URL（保持 /api 以外的页面留在本地前端包内渲染）。 */
  toLocalUrl(rawUrl: string): string {
    if (!this.localOrigin) return rawUrl;
    if (rawUrl.startsWith(this.upstreamUrl.origin)) {
      const suffix = rawUrl.slice(this.upstreamUrl.origin.length) || '/';
      if (!isBackendProxyPath(suffix)) {
        return `${this.localOrigin}${suffix}`;
      }
    }
    return rawUrl;
  }

  async start(): Promise<{ mode: LocalDocHostMode; origin: string }> {
    const envDev = process.env.ORBIT_DOC_DEV_URL?.trim();
    if (envDev) {
      try {
        this.devUrl = new URL(envDev);
        this.mode = 'dev';
      } catch {
        this.devUrl = null;
      }
    }

    if (!this.devUrl) {
      this.distDir = resolveBundledDocDistDir();
      if (this.distDir) {
        this.mode = 'bundled';
      } else {
        this.mode = 'remote';
        return { mode: 'remote', origin: this.upstreamUrl.origin };
      }
    }

    const server = http.createServer((req, res) => {
      // 必须同步暂停请求流，防止在异步读取 Electron 分区 Cookie 期间丢失小体积 POST JSON body 导致上游挂死
      req.pause();
      void this.handleHttpRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      this.mode = 'remote';
      return { mode: 'remote', origin: this.upstreamUrl.origin };
    }

    this.server = server;
    this.localOrigin = `http://127.0.0.1:${addr.port}`;
    console.info(
      `[orbit:doc-host] started in ${this.mode} mode at ${this.localOrigin} -> upstream ${this.upstreamUrl.origin}${this.distDir ? ` (dist: ${this.distDir})` : ''}`,
    );
    return { mode: this.mode, origin: this.localOrigin };
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // 忽略关闭异常
      }
      this.server = null;
    }
  }

  private async buildMergedUpstreamCookie(incomingCookie?: string): Promise<string | undefined> {
    const cookieMap = new Map<string, string>();
    // 1. 先读取 persist:lec-orbit 中线上 doc.lecspace.top 的全部 Cookie（含 HttpOnly authToken）
    try {
      const ses = session.fromPartition(ORBIT_SHARED_PARTITION);
      const stored = await ses.cookies.get({ url: this.upstreamUrl.origin });
      for (const c of stored) {
        cookieMap.set(c.name, c.value);
      }
    } catch {
      // 忽略分区 Cookie 读取异常
    }
    // 2. 合并浏览器本次随请求发送的 Cookie
    if (incomingCookie) {
      for (const pair of incomingCookie.split(';')) {
        const idx = pair.indexOf('=');
        if (idx > 0) {
          const name = pair.slice(0, idx).trim();
          const value = pair.slice(idx + 1).trim();
          if (name) cookieMap.set(name, value);
        }
      }
    }
    if (cookieMap.size === 0) return undefined;
    return [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private async syncSetCookiesToPartition(setCookies: string[]): Promise<void> {
    if (setCookies.length === 0) return;
    try {
      const ses = session.fromPartition(ORBIT_SHARED_PARTITION);
      await Promise.all(
        setCookies.map(async (raw) => {
          const parsed = parseSetCookieForSession(raw, this.upstreamUrl.origin);
          if (!parsed) return;
          try {
            await ses.cookies.set(parsed);
          } catch {
            // 忽略单个 Cookie 写回失败
          }
        }),
      );
    } catch {
      // 忽略异常
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = req.url || '/';

    // 1. 后端接口、Socket.IO 轮询与协同通道一律透明转发到 https://doc.lecspace.top
    if (isBackendProxyPath(reqUrl)) {
      await this.proxyToUpstream(req, res, reqUrl);
      return;
    }

    // 2. 本地开发态（ORBIT_DOC_DEV_URL）：转发到 Vite Dev Server
    if (this.mode === 'dev' && this.devUrl) {
      this.proxyToDevServer(req, res, reqUrl);
      return;
    }

    // 3. 本地打包静态产物态：直接从 distDir 零延迟吐出文件（支持 SPA 路由回退 index.html）
    if (this.mode === 'bundled' && this.distDir) {
      this.serveStaticFile(req, res, reqUrl, this.distDir);
      return;
    }

    res.statusCode = 503;
    res.end('LecDoc local host unavailable');
  }

  private async proxyToUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reqUrl: string,
  ): Promise<void> {
    const mergedCookie = await this.buildMergedUpstreamCookie(req.headers.cookie);
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['keep-alive'];
    headers['host'] = this.upstreamUrl.host;
    headers['origin'] = this.upstreamUrl.origin;
    headers['referer'] = `${this.upstreamUrl.origin}/`;
    if (mergedCookie) {
      headers['cookie'] = mergedCookie;
    } else {
      delete headers['cookie'];
    }

    const isHttps = this.upstreamUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const upstreamReq = transport.request(
      {
        protocol: this.upstreamUrl.protocol,
        hostname: this.upstreamUrl.hostname,
        port: this.upstreamUrl.port || (isHttps ? 443 : 80),
        method: req.method,
        path: reqUrl,
        headers,
      },
      (upstreamRes) => {
        const outHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
        delete outHeaders['transfer-encoding'];

        const rawSetCookie = upstreamRes.headers['set-cookie'];
        if (rawSetCookie && rawSetCookie.length > 0) {
          void this.syncSetCookiesToPartition(rawSetCookie);
          outHeaders['set-cookie'] = rawSetCookie.map(sanitizeSetCookieForLocalhost);
        }

        // 重定向回 doc.lecspace.top 前端路由时，自动切回本地托管源
        const loc = upstreamRes.headers['location'];
        if (typeof loc === 'string' && this.localOrigin) {
          if (loc.startsWith(this.upstreamUrl.origin)) {
            const suffix = loc.slice(this.upstreamUrl.origin.length) || '/';
            if (!isBackendProxyPath(suffix)) {
              outHeaders['location'] = `${this.localOrigin}${suffix}`;
            }
          }
        }

        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.setTimeout(25_000, () => {
      upstreamReq.destroy(new Error('LecDoc 上游接口响应超时'));
    });

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ message: `LecDoc 上游代理失败: ${err.message}` }));
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        upstreamReq.destroy();
      }
    });

    req.pipe(upstreamReq);
    req.resume();
  }

  private proxyToDevServer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reqUrl: string,
  ): void {
    if (!this.devUrl) {
      res.statusCode = 502;
      res.end('Dev server not configured');
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers['host'] = this.devUrl.host;
    const devReq = http.request(
      {
        hostname: this.devUrl.hostname,
        port: this.devUrl.port || 80,
        method: req.method,
        path: reqUrl,
        headers,
      },
      (devRes) => {
        res.writeHead(devRes.statusCode || 502, devRes.headers);
        devRes.pipe(res);
      },
    );
    devReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(`无法连接本地 LecDoc Vite Dev Server (${this.devUrl?.origin}): ${err.message}`);
    });
    req.pipe(devReq);
    req.resume();
  }

  private serveStaticFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reqUrl: string,
    distDir: string,
  ): void {
    const pathname = decodeURIComponent(reqUrl.split('?')[0] || '/');
    const safeRel = pathname.replace(/^\/+/, '');
    const candidate = path.resolve(distDir, safeRel);
    const rootPrefix = distDir.endsWith(path.sep) ? distDir : `${distDir}${path.sep}`;

    let targetFile: string | null = null;
    if (
      (candidate === distDir || candidate.startsWith(rootPrefix)) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      targetFile = candidate;
    } else {
      // 无后缀名或未命中静态资源 -> 回退 SPA index.html
      const ext = path.extname(pathname);
      if (!ext || ext === '.html') {
        targetFile = path.join(distDir, 'index.html');
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(targetFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isHashedAsset = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(targetFile).pipe(res);
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const reqUrl = req.url || '/';

    // 1. /collab 与 /socket.io WebSocket 隧道 -> 直连 https://doc.lecspace.top（携带 persist:lec-orbit Cookie）
    if (isBackendProxyPath(reqUrl)) {
      const mergedCookie = await this.buildMergedUpstreamCookie(req.headers.cookie);
      const isHttps = this.upstreamUrl.protocol === 'https:';
      const port = Number(this.upstreamUrl.port) || (isHttps ? 443 : 80);

      const upstreamSocket = isHttps
        ? tls.connect({
            host: this.upstreamUrl.hostname,
            port,
            servername: this.upstreamUrl.hostname,
          })
        : net.connect({ host: this.upstreamUrl.hostname, port });

      const lines: string[] = [`${req.method || 'GET'} ${reqUrl} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i]!;
        const val = req.rawHeaders[i + 1] ?? '';
        const lower = key.toLowerCase();
        if (lower === 'host' || lower === 'origin' || lower === 'cookie') continue;
        lines.push(`${key}: ${val}`);
      }
      lines.push(`Host: ${this.upstreamUrl.host}`);
      lines.push(`Origin: ${this.upstreamUrl.origin}`);
      if (mergedCookie) {
        lines.push(`Cookie: ${mergedCookie}`);
      }

      const rawHandshake = `${lines.join('\r\n')}\r\n\r\n`;

      const onError = () => {
        clientSocket.destroy();
        upstreamSocket.destroy();
      };
      upstreamSocket.on('error', onError);
      clientSocket.on('error', onError);

      upstreamSocket.once(isHttps ? 'secureConnect' : 'connect', () => {
        upstreamSocket.write(rawHandshake);
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
      return;
    }

    // 2. 本地开发态 Vite HMR WebSocket 隧道
    if (this.mode === 'dev' && this.devUrl) {
      const devSocket = net.connect({
        host: this.devUrl.hostname,
        port: Number(this.devUrl.port) || 80,
      });
      const lines: string[] = [`${req.method || 'GET'} ${reqUrl} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i]!;
        const val = req.rawHeaders[i + 1] ?? '';
        if (key.toLowerCase() === 'host') continue;
        lines.push(`${key}: ${val}`);
      }
      lines.push(`Host: ${this.devUrl.host}`);
      const rawHandshake = `${lines.join('\r\n')}\r\n\r\n`;

      const onError = () => {
        clientSocket.destroy();
        devSocket.destroy();
      };
      devSocket.on('error', onError);
      clientSocket.on('error', onError);

      devSocket.once('connect', () => {
        devSocket.write(rawHandshake);
        if (head.length > 0) devSocket.write(head);
        devSocket.pipe(clientSocket);
        clientSocket.pipe(devSocket);
      });
      return;
    }

    clientSocket.destroy();
  }
}
