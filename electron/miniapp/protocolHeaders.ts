/**
 * `orbit-app://` 协议静态资源解析与引擎兼容响应头构建器：
 * - 自动识别 Unity WebGL 预压缩产物（`.wasm.br` / `.js.br` / `.data.br` / `.gz`），返回精准 `Content-Type` + `Content-Encoding`
 * - 支持 Godot 4（`.pck` / `.wasm` / `.audio.worklet.js`）与 Cocos Creator 3.x（`.mjs` / `.cconb` / `.bin` / 纹理与音频）
 * - 按 Manifest 动态注入 `COOP` + `COEP`（`credentialless` / `require-corp`），启用 `SharedArrayBuffer` 与 WASM 多线程
 * - 构建严格白名单 CSP（支持 `'wasm-unsafe-eval'` 与 `blob:` Worker，防止未授权外链脚本）
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OrbitAppManifest } from '../../src/shared/miniapp';

export interface AssetHeaderResolution {
  contentType: string;
  contentEncoding?: 'br' | 'gzip';
}

const BASE_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.cconb': 'application/octet-stream',
  '.bundle': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.ktx': 'image/ktx',
  '.ktx2': 'image/ktx2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 解析资源路径的 MIME 类型与预压缩编码（Unity WebGL `.br`/`.gz` 复合后缀自动剥离识别）。
 */
export function resolveAssetHeaders(pathname: string): AssetHeaderResolution {
  const lower = pathname.toLowerCase();
  let contentEncoding: 'br' | 'gzip' | undefined;
  let effectivePath = lower;

  if (lower.endsWith('.br')) {
    contentEncoding = 'br';
    effectivePath = lower.slice(0, -3);
  } else if (lower.endsWith('.gz')) {
    contentEncoding = 'gzip';
    effectivePath = lower.slice(0, -3);
  } else if (lower.endsWith('.unityweb')) {
    // Unity 旧版统一后缀（通常为 gzip 或 br，由 loader 读取；按二进制流返回避免误解码）
    return { contentType: 'application/octet-stream' };
  }

  const ext = path.extname(effectivePath);
  const contentType = BASE_MIME_TYPES[ext] ?? 'application/octet-stream';
  return contentEncoding ? { contentType, contentEncoding } : { contentType };
}

/**
 * 构建单个小程序/小游戏的安全响应头（含 COOP/COEP 跨源隔离与引擎友好 CSP）。
 */
export function buildContainerSecurityHeaders(
  manifest: Pick<OrbitAppManifest, 'runtime' | 'permissions'>,
  options: { isDocument?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };

  if (manifest.runtime.crossOriginIsolated) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = manifest.runtime.isolationPolicy || 'credentialless';
  }

  if (options.isDocument) {
    const allowedDomains = (manifest.permissions.networkDomains ?? [])
      .map((d) => d.trim())
      .filter((d) => /^[a-zA-Z0-9.*:-]+$/.test(d))
      .map((d) => (d.startsWith('http://') || d.startsWith('https://') ? d : `https://${d}`));

    const connectSrc = ["'self'", 'data:', 'blob:', ...allowedDomains].join(' ');
    // 游戏引擎（Unity/Godot/Cocos）依赖 wasm-unsafe-eval 与 blob: Worker
    headers['Content-Security-Policy'] = [
      "default-src 'self' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' blob:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob:",
      "font-src 'self' data: blob:",
      `connect-src ${connectSrc}`,
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
  }

  return headers;
}

/**
 * 在离线包根目录内安全解析请求文件，防目录穿越；根路径 `/` 或无后缀 SPA 路由回退到入口 HTML。
 */
export function resolveSafeBundleFile(
  rootDir: string,
  requestPathname: string,
  entryRelPath = 'index.html',
): string | null {
  const rootResolved = path.resolve(rootDir);
  const rootPrefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;

  let decoded = '/';
  try {
    decoded = decodeURIComponent(requestPathname || '/');
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;

  const trimmed = decoded.replace(/^\/+/, '');
  const rel = trimmed || entryRelPath.replace(/^\/+/, '');
  const candidate = path.resolve(rootResolved, rel);

  if (candidate !== rootResolved && !candidate.startsWith(rootPrefix)) {
    return null;
  }

  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }

  // SPA 前端路由（无扩展名）回退到入口 HTML
  if (!path.extname(rel)) {
    const entryCandidate = path.resolve(rootResolved, entryRelPath.replace(/^\/+/, ''));
    if (
      entryCandidate.startsWith(rootPrefix) &&
      fs.existsSync(entryCandidate) &&
      fs.statSync(entryCandidate).isFile()
    ) {
      return entryCandidate;
    }
  }

  return null;
}
