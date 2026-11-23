/**
 * 工坊离线包管理器：
 * - 发现随客户端内置的官方种子模板 Demo（resources/seed-apps/*）
 * - 本地开发目录 Manifest 解析与 ZIP 上传包预检
 * - 线上包（RustFS 或 GitHub Releases）下载、SHA256 完整性校验、原子解压与磁盘 LRU/缓存清理
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MINIAPP_MAX_BUNDLE_BYTES,
  OrbitAppManifestSchema,
  type InstalledMiniAppRecord,
  type MiniAppBuiltinItem,
  type OrbitAppManifest,
} from '../../src/shared/miniapp';
import type { LocalDB } from '../storage/localDb';
import { extractZipBundleSafely, inspectZipBundle } from './zipExtractor';

const GITHUB_MAX_BUNDLE_BYTES = 500 * 1024 * 1024; // GitHub Releases 大包兜底上限 500MB

function isGitHubDownloadUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return (
      u.hostname === 'github.com' ||
      u.hostname.endsWith('.githubusercontent.com') ||
      u.hostname === 'objects.githubusercontent.com'
    );
  } catch {
    return false;
  }
}

function getDirSizeBytes(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSizeBytes(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    // 忽略不可读目录
  }
  return total;
}

export class MiniAppPackageManager {
  private readonly appsRootDir: string;

  constructor(
    userDataDir: string,
    private readonly localDb: LocalDB,
    private readonly builtinSearchDirs: string[],
  ) {
    this.appsRootDir = path.join(userDataDir, 'mini-apps');
    fs.mkdirSync(this.appsRootDir, { recursive: true });
  }

  /** 扫描客户端自带的官方种子验证 Demo（如开发者工具箱 & 引擎能力探针小游戏）。 */
  listBuiltins(): MiniAppBuiltinItem[] {
    const seen = new Set<string>();
    const results: MiniAppBuiltinItem[] = [];

    for (const baseDir of this.builtinSearchDirs) {
      if (!baseDir || !fs.existsSync(baseDir)) continue;
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of children) {
        if (!dirent.isDirectory()) continue;
        const appDir = path.join(baseDir, dirent.name);
        const manifestFile = path.join(appDir, 'orbit.manifest.json');
        if (!fs.existsSync(manifestFile)) continue;
        try {
          const parsed = OrbitAppManifestSchema.parse(
            JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
          );
          if (seen.has(parsed.id)) continue;
          const entryPath = path.resolve(appDir, parsed.entry);
          if (!fs.existsSync(entryPath)) continue;
          seen.add(parsed.id);
          results.push({
            appId: parsed.id,
            manifest: parsed,
            dirPath: appDir,
            badgeText: '官方示例',
          });
        } catch (err) {
          console.warn(`[orbit:hub] skip invalid builtin app in ${appDir}:`, err);
        }
      }
    }

    return results.sort((a, b) => a.appId.localeCompare(b.appId));
  }

  findBuiltin(appId: string): MiniAppBuiltinItem | null {
    return this.listBuiltins().find((item) => item.appId === appId) ?? null;
  }

  /** 读取本地文件夹的 orbit.manifest.json（用于开发者本地目录调试）。 */
  readLocalDirManifest(dirPath: string): OrbitAppManifest {
    const resolved = path.resolve(dirPath);
    const manifestPath = path.join(resolved, 'orbit.manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('所选目录缺少 orbit.manifest.json 文件');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error('orbit.manifest.json 解析失败，请检查 JSON 语法');
    }
    const manifest = OrbitAppManifestSchema.parse(raw);
    const entryPath = path.resolve(resolved, manifest.entry);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`目录中未找到声明的入口文件：${manifest.entry}`);
    }
    return manifest;
  }

  /** 读取本地 ZIP 文件并预检 Manifest（用于上传前客户端静态校验）。 */
  inspectLocalZipFile(filePath: string): { manifest: OrbitAppManifest; sizeBytes: number } {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error('请选择有效的 ZIP / .lecapp 压缩文件');
    }
    if (stat.size > MINIAPP_MAX_BUNDLE_BYTES) {
      throw new Error(
        `文件体积 ${(stat.size / 1024 / 1024).toFixed(1)} MB 超出单包 100 MB 上限，建议使用 GitHub Releases 导入方式。`,
      );
    }
    const buf = fs.readFileSync(filePath);
    const { info } = inspectZipBundle(buf);
    return { manifest: info.manifest, sizeBytes: stat.size };
  }

  listInstalled(): InstalledMiniAppRecord[] {
    return this.localDb.listInstalledApps().filter((rec) => fs.existsSync(rec.installDir));
  }

  getInstalled(appId: string): InstalledMiniAppRecord | null {
    const rec = this.localDb.getInstalledApp(appId);
    if (!rec) return null;
    if (!fs.existsSync(rec.installDir)) {
      this.localDb.removeInstalledApp(appId);
      return null;
    }
    return rec;
  }

  /**
   * 确保线上指定版本已下载并解压到本地磁盘（命中同版本 + 同 SHA256 则零流量复用）。
   */
  async ensureRemoteInstalled(params: {
    appId: string;
    version: string;
    bundleUrl: string;
    bundleSha256: string;
    authToken?: string | null;
  }): Promise<InstalledMiniAppRecord> {
    const existing = this.getInstalled(params.appId);
    if (
      existing &&
      existing.version === params.version &&
      (!params.bundleSha256 || existing.sha256 === params.bundleSha256.toLowerCase())
    ) {
      this.localDb.touchInstalledApp(params.appId);
      return existing;
    }

    const isGithub = isGitHubDownloadUrl(params.bundleUrl);
    const maxBytes = isGithub ? GITHUB_MAX_BUNDLE_BYTES : MINIAPP_MAX_BUNDLE_BYTES;

    const headers: Record<string, string> = {
      Accept: 'application/octet-stream, application/zip, */*',
    };
    if (!isGithub && params.authToken) {
      headers.Authorization = `Bearer ${params.authToken}`;
    }

    const resp = await fetch(params.bundleUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
    if (!resp.ok) {
      throw new Error(`下载构建包失败（HTTP ${resp.status}）`);
    }

    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      throw new Error(`远程构建包超出允许体积上限 (${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuf);
    const safeVersionDir = params.version.replace(/[^a-zA-Z0-9._-]/g, '_');
    const installDir = path.join(this.appsRootDir, params.appId, safeVersionDir);

    const extracted = extractZipBundleSafely(zipBuffer, installDir, {
      expectedSha256: params.bundleSha256 || undefined,
      maxCompressedBytes: maxBytes,
      maxUncompressedBytes: isGithub ? 800 * 1024 * 1024 : undefined,
    });

    if (extracted.manifest.id !== params.appId) {
      fs.rmSync(installDir, { recursive: true, force: true });
      throw new Error(
        `构建包内 manifest.id (${extracted.manifest.id}) 与目标应用 (${params.appId}) 不一致`,
      );
    }

    // 清理同应用旧版本目录，释放磁盘空间
    const appBaseDir = path.join(this.appsRootDir, params.appId);
    try {
      for (const item of fs.readdirSync(appBaseDir)) {
        const p = path.join(appBaseDir, item);
        if (path.resolve(p) !== path.resolve(installDir)) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
    } catch {
      // 忽略清理异常
    }

    const now = Date.now();
    const record: InstalledMiniAppRecord = {
      appId: params.appId,
      version: params.version,
      sha256: extracted.sha256,
      sizeBytes: extracted.uncompressedBytes,
      installDir,
      manifest: extracted.manifest,
      installedAt: now,
      lastOpenedAt: now,
    };
    this.localDb.upsertInstalledApp(record);
    return record;
  }

  uninstall(appId: string): void {
    this.localDb.removeInstalledApp(appId);
    const appBaseDir = path.join(this.appsRootDir, appId);
    fs.rmSync(appBaseDir, { recursive: true, force: true });
  }

  clearAllCache(): { freedBytes: number } {
    const freedBytes = getDirSizeBytes(this.appsRootDir);
    for (const rec of this.localDb.listInstalledApps()) {
      this.localDb.removeInstalledApp(rec.appId);
    }
    fs.rmSync(this.appsRootDir, { recursive: true, force: true });
    fs.mkdirSync(this.appsRootDir, { recursive: true });
    return { freedBytes };
  }
}
