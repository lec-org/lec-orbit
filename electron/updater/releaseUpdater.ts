/**
 * Orbit 客户端 GitHub Releases 自动更新与应用内一键「重启以更新」：
 * - 优先读取零限流 GitHub Releases CDN 托管的 latest-mac.yml / latest.yml（含 sha512 校验值），
 *   彻底规避校园网共享出口 IP 触发 api.github.com 匿名 403 限流；
 * - Windows：electron-updater 直连 generic CDN 源，点击「重启以更新」先标记退出态防托盘拦截，
 *   再执行 quitAndInstall(true, true) 静默覆盖并自动重启（降级直链 .exe 同样支持静默重启更新）；
 * - macOS：无需 $99 苹果签名即可实现真正「重启以更新」——流式下载 .zip → 校验 sha512 →
 *   后台 ditto 静默解压校验 + xattr 预清隔离 → 点击后拉起脱离父进程的原子替换脚本（带失败自动回滚）
 *   并在 2 秒内自动拉起新版本；若运行在只读 DMG 卷或隔离沙箱中则自动回退打开 .dmg。
 */
import { app, net, powerMonitor, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WindowsReleaseProvider } from './windowsReleaseProvider';
import type { UpdateChangelog, UpdateCheckResult } from '../../src/shared/ipc';
import {
  buildChangelogFromCommits,
  parseReleaseNotesToChangelog,
  type RawCommitInput,
} from '../../src/shared/updateChangelog';
import {
  buildMacSelfReplaceScript,
  compareSemver,
  parseLatestManifestYaml,
  resolveMacAppBundlePath,
  type ParsedLatestManifest,
  type ReleaseAssetInfo,
} from './manifest';

const execFileAsync = promisify(execFile);

const GITHUB_REPO = process.env.ORBIT_UPDATE_GITHUB_REPO?.trim() || 'lec-org/lec-orbit';
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const LATEST_RELEASE_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;
const LATEST_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO}/releases/latest/download`;
const EXPECTED_MAC_BUNDLE_ID = 'top.lecspace.orbit';
const AUTO_CHECK_INITIAL_DELAY_MS = 6_000;
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟（走零限流 GitHub CDN 清单）
const AUTO_CHECK_RETRY_DELAY_MS = 2 * 60 * 1000; // 首次/后台检查失败 2 分钟后重试一次
const RESUME_CHECK_THROTTLE_MS = 10 * 60 * 1000; // 休眠唤醒节流 10 分钟

type GitHubAsset = ReleaseAssetInfo;

interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string;
  author?: {
    login?: string;
    avatar_url?: string;
  };
  assets?: GitHubAsset[];
}

interface GitHubComparePayload {
  html_url?: string;
  commits?: Array<{
    sha?: string;
    html_url?: string;
    commit?: {
      message?: string;
      author?: {
        name?: string;
        date?: string;
      };
    };
    author?: {
      login?: string;
      avatar_url?: string;
    } | null;
  }>;
}

interface StagedMacUpdate {
  targetAppPath: string;
  stagedAppPath: string;
  workDir: string;
}

export interface OrbitUpdaterOptions {
  /** 在重启安装前执行，用于标记主进程正在退出（防止 closeToTray 拦截）、销毁悬浮球与托盘。 */
  onBeforeInstall?: () => void;
}

export { compareSemver, parseLatestManifestYaml };

function pickPlatformAsset(
  assets: GitHubAsset[] | undefined,
  options?: { preferMacZip?: boolean },
): GitHubAsset | null {
  if (!assets || assets.length === 0) return null;
  const platform = process.platform;
  const arch = process.arch; // arm64 / x64
  const preferMacZip = Boolean(options?.preferMacZip);

  const score = (asset: GitHubAsset): number => {
    const n = asset.name.toLowerCase();
    if (n.endsWith('.blockmap') || n.endsWith('.yml') || n.endsWith('.yaml') || n.endsWith('.sha256')) {
      return -100;
    }
    if (platform === 'darwin') {
      let s = 0;
      const isMacZip =
        n.endsWith('.zip') &&
        (n.includes('mac') || n.includes('darwin') || n.includes('arm64') || n.includes('x64'));
      if (isMacZip) s += preferMacZip ? 40 : 20;
      else if (n.endsWith('.dmg')) s += preferMacZip ? 20 : 40;
      else return -50;
      if (arch === 'arm64' && (n.includes('arm64') || n.includes('aarch64'))) s += 25;
      else if (arch === 'x64' && (n.includes('x64') || n.includes('amd64') || n.includes('intel'))) s += 25;
      else if (n.includes('universal')) s += 15;
      else if (arch === 'arm64' && (n.includes('x64') || n.includes('intel'))) s -= 20;
      else if (arch === 'x64' && n.includes('arm64')) s -= 20;
      return s;
    }
    if (platform === 'win32') {
      let s = 0;
      if (n.endsWith('.exe')) s += 40;
      else if (n.endsWith('.msi')) s += 30;
      else return -50;
      if (n.includes('setup') || n.includes('installer')) s += 15;
      if (arch === 'arm64' && n.includes('arm64')) s += 15;
      else if (arch === 'x64' && (n.includes('x64') || !n.includes('arm64'))) s += 15;
      return s;
    }
    // Linux
    if (n.endsWith('.appimage')) return 40;
    if (n.endsWith('.deb')) return 30;
    return -50;
  };

  let best: GitHubAsset | null = null;
  let bestScore = 0;
  for (const asset of assets) {
    const sc = score(asset);
    if (sc > bestScore) {
      bestScore = sc;
      best = asset;
    }
  }
  return best;
}

export class OrbitUpdater {
  private initialized = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private resumeHandler: (() => void) | null = null;
  private checkingPromise: Promise<UpdateCheckResult> | null = null;
  private lastCheckStartedAt = 0;
  private autoDownloadedVersion: string | null = null;
  private downloadedViaAutoUpdater = false;
  private downloading = false;
  private silentDownloading = false;
  private installing = false;
  private expectedAssetSha512: string | undefined;
  private stagedMacUpdate: StagedMacUpdate | null = null;
  private readonly changelogCache = new Map<string, UpdateChangelog>();
  private state: UpdateCheckResult = {
    currentVersion: app.getVersion(),
    available: false,
    checked: false,
    stage: 'idle',
  };
  private readonly listeners = new Set<(state: UpdateCheckResult) => void>();

  constructor(private readonly options: OrbitUpdaterOptions = {}) {}

  getState(): UpdateCheckResult {
    return this.state;
  }

  onStateChanged(listener: (state: UpdateCheckResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动后延迟静默检查 + 每 30 分钟后台轮询 + 系统休眠唤醒复查（发现支持自动安装的新版时自动静默预下载）。 */
  startAutoCheck(): void {
    this.stopAutoCheck();
    this.initialTimer = setTimeout(() => {
      void this.check({ silent: true });
    }, AUTO_CHECK_INITIAL_DELAY_MS);
    this.pollTimer = setInterval(() => {
      if (this.state.stage !== 'downloading' && this.state.stage !== 'downloaded') {
        void this.check({ silent: true });
      }
    }, AUTO_CHECK_INTERVAL_MS);
    this.resumeHandler = () => {
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      // 唤醒后等待 5 秒待 Wi-Fi 重新握手后再节流复查
      this.resumeTimer = setTimeout(() => {
        void this.checkIfStale(RESUME_CHECK_THROTTLE_MS);
      }, 5_000);
    };
    powerMonitor.on('resume', this.resumeHandler);
  }

  stopAutoCheck(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (this.resumeHandler) {
      powerMonitor.removeListener('resume', this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  /** 节流静默检查（供窗口重新聚焦、系统休眠唤醒等时机调用）。 */
  async checkIfStale(minIntervalMs = 15 * 60 * 1000): Promise<UpdateCheckResult> {
    if (this.state.stage === 'downloading' || this.state.stage === 'downloaded') {
      return this.state;
    }
    if (Date.now() - this.lastCheckStartedAt < minIntervalMs) {
      return this.state;
    }
    return this.check({ silent: true });
  }

  private updateState(patch: Partial<UpdateCheckResult>): UpdateCheckResult {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
    return this.state;
  }

  /** 判断当前运行的 macOS .app 是否支持原位原子替换（要求打包态、非只读 DMG/AppTranslocation、可写目录）。 */
  private getReplaceableMacAppPath(): string | null {
    if (process.platform !== 'darwin' || !app.isPackaged) return null;
    const appPath = resolveMacAppBundlePath(process.execPath);
    if (!appPath) return null;
    try {
      fs.accessSync(appPath, fs.constants.W_OK);
      fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
      return appPath;
    } catch {
      return null;
    }
  }

  private supportsNativeAutoInstall(): boolean {
    if (!app.isPackaged) return false;
    // Windows NSIS 完整支持原位静默安装；macOS 仅在明确开启 Apple 签名模式时走 Squirrel
    if (process.platform === 'win32') return true;
    if (process.platform === 'darwin') return process.env.ORBIT_MAC_SIGNED_AUTO_UPDATE === '1';
    return false;
  }

  private supportsOneClickRestartInstall(): boolean {
    if (this.supportsNativeAutoInstall()) return true;
    if (this.getReplaceableMacAppPath()) return true;
    return false;
  }

  private ensureAutoUpdaterInit(): void {
    if (this.initialized) return;
    this.initialized = true;
    // 统一指向零限流 GitHub Releases CDN（generic provider 直接拉取 latest.yml 与安装包，彻底避开 api.github.com 限流）
    autoUpdater.setFeedURL(
      process.platform === 'win32'
        ? { provider: 'custom', updateProvider: WindowsReleaseProvider, repo: GITHUB_REPO }
        : { provider: 'generic', url: LATEST_DOWNLOAD_BASE },
    );
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateState({
        stage: 'downloading',
        progressPercent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.downloadedViaAutoUpdater = true;
      this.downloading = false;
      this.silentDownloading = false;
      this.updateState({
        available: true,
        checked: true,
        latestVersion: info.version,
        canAutoInstall: true,
        stage: 'downloaded',
        progressPercent: 100,
      });
    });

    autoUpdater.on('error', (err: Error) => {
      const wasSilent = this.silentDownloading;
      this.downloading = false;
      this.silentDownloading = false;
      if (wasSilent && this.state.available) {
        // 后台静默预下载失败时温和回退为 available，不弹出报错，保留左下角手动下载入口
        this.updateState({
          stage: 'available',
          progressPercent: undefined,
          errorMessage: undefined,
        });
        return;
      }
      this.updateState({
        stage: 'error',
        errorMessage: err?.message || '自动更新下载失败，请改用浏览器下载。',
      });
    });
  }

  private async fetchManifestLatestRelease(): Promise<ParsedLatestManifest | null> {
    const manifestName =
      process.platform === 'darwin'
        ? 'latest-mac.yml'
        : process.platform === 'win32'
          ? 'latest.yml'
          : 'latest-linux.yml';
    const res = await net.fetch(`${LATEST_DOWNLOAD_BASE}/${manifestName}`, {
      cache: 'no-store',
      headers: {
        'User-Agent': `Orbit-Desktop/${app.getVersion()}`,
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseLatestManifestYaml(text, GITHUB_REPO);
  }

  /** 拉取指定版本的结构化更新日志（零限流 CDN 清单 → GitHub Release/Compare API → 开发态本地 Git 兜底）。 */
  async getVersionChangelog(version?: string, fromVersion?: string): Promise<UpdateChangelog | null> {
    const cleanVersion = (version || app.getVersion()).trim().replace(/^v/i, '');
    if (!cleanVersion) return null;
    const cacheKey = `${cleanVersion}@${fromVersion?.replace(/^v/i, '') ?? ''}`;
    const cached = this.changelogCache.get(cacheKey);
    if (cached) return cached;

    const releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/v${cleanVersion}`;

    // 1. 优先从 GitHub Releases CDN 下载 CI 生成的 release-changelog.json（零 API 限流）
    try {
      const cdnRes = await net.fetch(
        `https://github.com/${GITHUB_REPO}/releases/download/v${encodeURIComponent(cleanVersion)}/release-changelog.json`,
        {
          cache: 'no-store',
          headers: { 'User-Agent': `Orbit-Desktop/${app.getVersion()}` },
        },
      );
      if (cdnRes.ok) {
        const parsed = (await cdnRes.json()) as Partial<UpdateChangelog>;
        if (Array.isArray(parsed.items)) {
          const result: UpdateChangelog = {
            version: parsed.version || cleanVersion,
            previousVersion: parsed.previousVersion || fromVersion?.replace(/^v/i, ''),
            publishedAt: parsed.publishedAt,
            releaseUrl: parsed.releaseUrl || releaseUrl,
            compareUrl: parsed.compareUrl,
            summary: parsed.summary,
            rawNotes: parsed.rawNotes,
            items: parsed.items,
            contributors: Array.isArray(parsed.contributors) ? parsed.contributors : [],
          };
          this.changelogCache.set(cacheKey, result);
          return result;
        }
      }
    } catch {
      // 忽略 CDN 缺失，进入回退策略
    }

    // 2. 回退 GitHub Releases API + Compare API（历史版本无 release-changelog.json 时自动解析 PR/提交与作者）
    let releaseBody: string | undefined;
    let publishedAt: string | undefined;
    let fallbackAuthor: { githubLogin?: string; name?: string; avatar?: string } | undefined;
    let parsedFromNotes: UpdateChangelog | null = null;
    try {
      const res = await net.fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${encodeURIComponent(cleanVersion)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `Orbit-Desktop/${app.getVersion()}`,
          },
        },
      );
      if (res.ok) {
        const data = (await res.json()) as GitHubReleasePayload;
        releaseBody = (data.body || '').trim() || undefined;
        publishedAt = data.published_at || undefined;
        if (data.author?.login) {
          fallbackAuthor = {
            githubLogin: data.author.login,
            name: data.author.login,
            avatar: data.author.avatar_url,
          };
        }
        parsedFromNotes = parseReleaseNotesToChangelog({
          version: cleanVersion,
          previousVersion: fromVersion,
          publishedAt,
          releaseUrl: data.html_url || releaseUrl,
          rawNotes: releaseBody,
          fallbackAuthor,
        });
      }
    } catch {
      // 忽略网络异常
    }

    const baseVersion = (fromVersion || parsedFromNotes?.previousVersion)?.trim().replace(/^v/i, '');
    if (baseVersion && baseVersion !== cleanVersion) {
      try {
        const cmpRes = await net.fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/compare/v${encodeURIComponent(baseVersion)}...v${encodeURIComponent(cleanVersion)}`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': `Orbit-Desktop/${app.getVersion()}`,
            },
          },
        );
        if (cmpRes.ok) {
          const cmp = (await cmpRes.json()) as GitHubComparePayload;
          if (Array.isArray(cmp.commits) && cmp.commits.length > 0) {
            const rawCommits: RawCommitInput[] = cmp.commits.map((c) => ({
              sha: c.sha,
              message: c.commit?.message || '',
              authorName: c.commit?.author?.name || c.author?.login,
              authorLogin: c.author?.login,
              authorAvatar: c.author?.avatar_url,
              committedAt: c.commit?.author?.date,
              url: c.html_url,
            }));
            const built = buildChangelogFromCommits({
              version: cleanVersion,
              previousVersion: baseVersion,
              publishedAt,
              releaseUrl: parsedFromNotes?.releaseUrl || releaseUrl,
              compareUrl:
                cmp.html_url ||
                `https://github.com/${GITHUB_REPO}/compare/v${baseVersion}...v${cleanVersion}`,
              rawNotes: releaseBody,
              commits: rawCommits,
              fallbackAuthor,
            });
            this.changelogCache.set(cacheKey, built);
            return built;
          }
        }
      } catch {
        // Compare API 不可用时继续使用 Release Notes 解析结果
      }
    }

    if (parsedFromNotes && (parsedFromNotes.items.length > 0 || parsedFromNotes.rawNotes)) {
      this.changelogCache.set(cacheKey, parsedFromNotes);
      return parsedFromNotes;
    }

    // 3. 开发态本地 Git 兜底：方便本地预览当前版本的真实提交与 @成员 映射
    if (!app.isPackaged) {
      const localChangelog = await this.buildLocalDevChangelog(cleanVersion, releaseUrl).catch(() => null);
      if (localChangelog) {
        this.changelogCache.set(cacheKey, localChangelog);
        return localChangelog;
      }
    }

    return {
      version: cleanVersion,
      previousVersion: fromVersion?.replace(/^v/i, ''),
      releaseUrl,
      items: [],
      contributors: [],
    };
  }

  private async buildLocalDevChangelog(
    version: string,
    releaseUrl: string,
  ): Promise<UpdateChangelog | null> {
    const cwd = app.getAppPath();
    const { stdout: tagOut } = await execFileAsync(
      'git',
      ['tag', '--sort=-creatordate', '--list', 'v*'],
      { cwd, timeout: 4_000 },
    );
    const tags = tagOut
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const currentTag = `v${version}`;
    const idx = tags.indexOf(currentTag);
    const prevTag = idx >= 0 ? tags[idx + 1] : tags[0];
    const range = idx >= 0 && prevTag ? `${prevTag}..${currentTag}` : prevTag ? `${prevTag}..HEAD` : '-n 8';
    const logArgs =
      range === '-n 8'
        ? ['log', '-n', '8', '--pretty=format:%H%x1f%an%x1f%aI%x1f%B%x1e']
        : ['log', range, '--pretty=format:%H%x1f%an%x1f%aI%x1f%B%x1e'];
    const { stdout: logOut } = await execFileAsync('git', logArgs, { cwd, timeout: 4_000 });
    const records = logOut
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean);
    if (records.length === 0) return null;

    const commits: RawCommitInput[] = records
      .map((rec) => {
        const [sha, authorName, committedAt, message] = rec.split('\x1f');
        if (!sha || !message) return null;
        const cleanAuthor = authorName?.trim();
        const looksLikeGithubLogin = Boolean(cleanAuthor && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(cleanAuthor));
        return {
          sha: sha.trim(),
          authorName: cleanAuthor,
          authorLogin: looksLikeGithubLogin ? cleanAuthor : undefined,
          committedAt: committedAt?.trim(),
          message: message.trim(),
          url: `https://github.com/${GITHUB_REPO}/commit/${sha.trim()}`,
        } as RawCommitInput;
      })
      .filter((c): c is RawCommitInput => Boolean(c));

    return buildChangelogFromCommits({
      version,
      previousVersion: prevTag?.replace(/^v/i, ''),
      releaseUrl,
      compareUrl: prevTag
        ? `https://github.com/${GITHUB_REPO}/compare/${prevTag}...${idx >= 0 ? currentTag : 'HEAD'}`
        : undefined,
      commits,
    });
  }

  private async fetchGitHubLatestRelease(): Promise<{ payload: GitHubReleasePayload | null; status: number }> {
    const res = await net.fetch(LATEST_RELEASE_API, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Orbit-Desktop/${app.getVersion()}`,
      },
    });
    if (!res.ok) return { payload: null, status: res.status };
    const data = (await res.json()) as GitHubReleasePayload;
    if (data.draft || data.prerelease || typeof data.tag_name !== 'string') {
      return { payload: null, status: 404 };
    }
    return { payload: data, status: 200 };
  }

  async check(options?: { silent?: boolean }): Promise<UpdateCheckResult> {
    if (this.checkingPromise) return this.checkingPromise;
    if (options?.silent && (this.state.stage === 'downloading' || this.state.stage === 'downloaded')) {
      return this.state;
    }
    const task = this.runCheck(Boolean(options?.silent));
    this.checkingPromise = task;
    try {
      const result = await task;
      // 打包态且支持应用内一键重启安装时，发现新版本后自动静默预下载（每版本仅自动触发一次）
      if (
        app.isPackaged &&
        result.available &&
        result.latestVersion &&
        result.canAutoInstall &&
        result.stage === 'available' &&
        !this.downloading &&
        this.autoDownloadedVersion !== result.latestVersion
      ) {
        this.autoDownloadedVersion = result.latestVersion;
        void this.download({ silent: true });
      }
      return result;
    } finally {
      if (this.checkingPromise === task) {
        this.checkingPromise = null;
      }
    }
  }

  private async runCheck(silent: boolean): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();
    const preferMacZip = Boolean(this.getReplaceableMacAppPath());
    this.lastCheckStartedAt = Date.now();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!silent) {
      this.updateState({
        currentVersion,
        stage: 'checking',
        errorMessage: undefined,
      });
    }

    try {
      // 1. 优先读取 GitHub Releases CDN 托管的 latest-mac.yml / latest.yml（无 API 限流，校园网共用出口 IP 100% 稳定）
      const manifest = await this.fetchManifestLatestRelease().catch(() => null);
      if (manifest) {
        const latestVersion = manifest.version;
        const available = compareSemver(latestVersion, currentVersion) > 0;
        const asset = pickPlatformAsset(manifest.assets, { preferMacZip });
        this.expectedAssetSha512 = asset?.sha512;
        const canAutoInstall =
          this.supportsNativeAutoInstall() ||
          (preferMacZip && Boolean(asset?.name.toLowerCase().endsWith('.zip')));
        const changelog = available
          ? (await this.getVersionChangelog(latestVersion, currentVersion)) ?? undefined
          : undefined;
        const releaseNotes = changelog?.rawNotes;
        return this.updateState({
          currentVersion,
          latestVersion,
          releaseUrl: changelog?.releaseUrl || `https://github.com/${GITHUB_REPO}/releases/tag/v${latestVersion}`,
          releaseNotes,
          changelog,
          publishedAt: changelog?.publishedAt || manifest.releaseDate,
          assetName: asset?.name,
          assetUrl: asset?.browser_download_url,
          assetSize: asset?.size,
          canAutoInstall,
          available,
          checked: true,
          stage: available ? 'available' : 'up-to-date',
        });
      }

      // 2. 回退 GitHub Releases API（明确区分 404 与 403/429 限流，绝不把限流误报成「已是最新版本」）
      const { payload: gh, status } = await this.fetchGitHubLatestRelease();
      if (gh && gh.tag_name) {
        const latestVersion = gh.tag_name.replace(/^v/i, '');
        const available = compareSemver(latestVersion, currentVersion) > 0;
        const asset = pickPlatformAsset(gh.assets, { preferMacZip });
        this.expectedAssetSha512 = asset?.sha512;
        const canAutoInstall =
          this.supportsNativeAutoInstall() ||
          (preferMacZip && Boolean(asset?.name.toLowerCase().endsWith('.zip')));
        const rawNotes = (gh.body || '').trim() || undefined;
        const changelog = available
          ? (await this.getVersionChangelog(latestVersion, currentVersion)) ??
            parseReleaseNotesToChangelog({
              version: latestVersion,
              previousVersion: currentVersion,
              publishedAt: gh.published_at || undefined,
              releaseUrl: gh.html_url || LATEST_RELEASE_PAGE,
              rawNotes,
              fallbackAuthor: gh.author?.login
                ? {
                    githubLogin: gh.author.login,
                    name: gh.author.login,
                    avatar: gh.author.avatar_url,
                  }
                : undefined,
            })
          : undefined;
        return this.updateState({
          currentVersion,
          latestVersion,
          releaseUrl: gh.html_url || LATEST_RELEASE_PAGE,
          releaseNotes: rawNotes,
          changelog,
          publishedAt: gh.published_at || undefined,
          assetName: asset?.name,
          assetUrl: asset?.browser_download_url,
          assetSize: asset?.size,
          canAutoInstall,
          available,
          checked: true,
          stage: available ? 'available' : 'up-to-date',
        });
      }

      if (status === 403 || status === 429) {
        throw new Error('GitHub 接口触发访问频率限制，请稍后重试或直接前往发布页下载。');
      }

      if (this.supportsNativeAutoInstall()) {
        this.ensureAutoUpdaterInit();
        const result = await autoUpdater.checkForUpdates().catch(() => null);
        const latestVersion = result?.updateInfo?.version;
        const available = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
        return this.updateState({
          currentVersion,
          latestVersion,
          releaseUrl: LATEST_RELEASE_PAGE,
          canAutoInstall: true,
          available,
          checked: true,
          stage: available ? 'available' : 'up-to-date',
        });
      }

      return this.updateState({
        currentVersion,
        available: false,
        checked: true,
        stage: 'up-to-date',
      });
    } catch (err) {
      if (silent) {
        // 静默检查遇到启动网络抖动时不暴露红框报错，2 分钟后静默重试一次
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.state.stage !== 'downloading' && this.state.stage !== 'downloaded') {
              void this.check({ silent: true });
            }
          }, AUTO_CHECK_RETRY_DELAY_MS);
        }
        return this.state;
      }
      return this.updateState({
        currentVersion,
        available: false,
        checked: false,
        stage: 'error',
        errorMessage: err instanceof Error ? err.message : '检查 GitHub 版本失败，请检查网络连接。',
      });
    }
  }

  /** 将已下载的 macOS .zip 在临时目录静默解压、验证 Bundle ID 并预清 quarantine。 */
  private async stageMacZipBundle(
    zipPath: string,
    targetAppPath: string,
    workDir: string,
  ): Promise<StagedMacUpdate> {
    const extractDir = path.join(workDir, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    await execFileAsync('/usr/bin/ditto', ['-xk', zipPath, extractDir], {
      timeout: 120_000,
    });

    const entries = fs.readdirSync(extractDir);
    const appEntry =
      entries.find((e) => e.toLowerCase() === 'orbit.app') ??
      entries.find((e) => e.toLowerCase().endsWith('.app'));
    if (!appEntry) {
      throw new Error('解压后的更新包中未找到 Orbit.app。');
    }

    const stagedAppPath = path.join(extractDir, appEntry);
    const infoPlistPath = path.join(stagedAppPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(infoPlistPath)) {
      throw new Error('更新包结构不完整（缺少 Info.plist）。');
    }

    // 校验 Info.plist 确实属于 Orbit，防止异常压缩包误覆盖
    const plistContent = fs.readFileSync(infoPlistPath, 'utf8');
    if (!plistContent.includes(EXPECTED_MAC_BUNDLE_ID)) {
      throw new Error('更新包应用标识与 Orbit 不一致，已中止替换。');
    }

    // 提前清除 quarantine 隔离属性，保证重启后零 Gatekeeper 拦截
    await execFileAsync('/usr/bin/xattr', ['-cr', stagedAppPath], { timeout: 30_000 }).catch(
      () => undefined,
    );

    // 删除临时 zip 释放空间
    fs.rmSync(zipPath, { force: true });

    return { targetAppPath, stagedAppPath, workDir };
  }

  async download(options?: { silent?: boolean }): Promise<UpdateCheckResult> {
    if (this.downloading) return this.state;
    const silent = Boolean(options?.silent);
    this.silentDownloading = silent;

    // 1. 支持原生自动安装（Windows NSIS / 已签名 macOS）-> 走 electron-updater（已指向零限流 CDN）
    if (this.supportsNativeAutoInstall()) {
      this.downloading = true;
      this.ensureAutoUpdaterInit();
      this.updateState({ stage: 'downloading', progressPercent: 0, errorMessage: undefined });
      try {
        await autoUpdater.checkForUpdates();
        await autoUpdater.downloadUpdate();
        return this.state;
      } catch (err) {
        this.downloading = false;
        // 若原生 autoUpdater 失败且存在直链资产，自动降级为应用内直链进度下载
        if (!this.state.assetUrl) {
          this.silentDownloading = false;
          if (silent && this.state.available) {
            return this.updateState({
              stage: 'available',
              progressPercent: undefined,
              errorMessage: undefined,
            });
          }
          return this.updateState({
            stage: 'error',
            errorMessage: err instanceof Error ? err.message : '下载更新失败，请稍后重试。',
          });
        }
      }
    }

    // 2. 应用内流式下载 GitHub Release 对应平台资产（macOS .zip 原位预解压 / Windows .exe / .dmg）
    const assetUrl = this.state.assetUrl;
    if (!assetUrl) {
      this.silentDownloading = false;
      if (!silent && this.state.releaseUrl) {
        await shell.openExternal(this.state.releaseUrl);
      }
      return this.state;
    }

    this.downloading = true;
    this.downloadedViaAutoUpdater = false;
    this.stagedMacUpdate = null;
    this.updateState({ stage: 'downloading', progressPercent: 0, errorMessage: undefined });

    const replaceableMacAppPath = this.getReplaceableMacAppPath();
    const safeFileName = (this.state.assetName || `Orbit-${this.state.latestVersion || 'latest'}.dmg`).replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );
    const willStageMacZip =
      Boolean(replaceableMacAppPath) && safeFileName.toLowerCase().endsWith('.zip');
    const willDirectWinExe =
      process.platform === 'win32' && safeFileName.toLowerCase().endsWith('.exe');
    const safeVersion = (this.state.latestVersion || 'latest').replace(/[^a-zA-Z0-9._-]/g, '_');

    const workDir =
      willStageMacZip || willDirectWinExe
        ? path.join(app.getPath('temp'), 'orbit-updater', safeVersion)
        : app.getPath('downloads');

    const finalPath = path.join(workDir, safeFileName);
    const partPath = `${finalPath}.part`;

    try {
      const res = await net.fetch(assetUrl, {
        headers: { 'User-Agent': `Orbit-Desktop/${app.getVersion()}` },
      });
      if (!res.ok || !res.body) {
        throw new Error(`下载安装包失败（HTTP ${res.status}）`);
      }

      const totalBytes = Number(res.headers.get('content-length')) || this.state.assetSize || 0;
      fs.mkdirSync(workDir, { recursive: true });
      const fileStream = fs.createWriteStream(partPath);
      const hash = crypto.createHash('sha512');
      const reader = res.body.getReader();

      let received = 0;
      let lastPercent = -1;
      // macOS .zip 下载后还需留 5% 进度给解压与完整性校验
      const maxDownloadPct = willStageMacZip ? 94 : 99;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const buf = Buffer.from(value);
          fileStream.write(buf);
          hash.update(buf);
          received += buf.byteLength;
          if (totalBytes > 0) {
            const pct = Math.min(
              maxDownloadPct,
              Math.round((received / totalBytes) * maxDownloadPct),
            );
            if (pct !== lastPercent) {
              lastPercent = pct;
              this.updateState({ stage: 'downloading', progressPercent: pct });
            }
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
        fileStream.end();
      });

      // 校验 SHA-512（与 latest-mac.yml / latest.yml 中的 sha512 一致）
      if (this.expectedAssetSha512) {
        const actualSha512 = hash.digest('base64');
        if (actualSha512 !== this.expectedAssetSha512) {
          fs.rmSync(partPath, { force: true });
          throw new Error('安装包完整性校验失败（SHA-512 不匹配），请重新下载。');
        }
      }

      fs.renameSync(partPath, finalPath);

      // macOS 可原位替换：静默解压 .zip 并校验 .app 后直接进入「重启以更新」就绪态
      if (willStageMacZip && replaceableMacAppPath) {
        this.updateState({ stage: 'downloading', progressPercent: 97 });
        const staged = await this.stageMacZipBundle(finalPath, replaceableMacAppPath, workDir);
        this.stagedMacUpdate = staged;
        this.downloading = false;
        this.silentDownloading = false;
        return this.updateState({
          stage: 'downloaded',
          progressPercent: 100,
          downloadedFilePath: staged.stagedAppPath,
          canAutoInstall: true,
        });
      }

      this.downloading = false;
      this.silentDownloading = false;
      return this.updateState({
        stage: 'downloaded',
        progressPercent: 100,
        downloadedFilePath: finalPath,
        canAutoInstall: willDirectWinExe,
      });
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      this.downloading = false;
      this.silentDownloading = false;
      if (silent && this.state.available) {
        return this.updateState({
          stage: 'available',
          progressPercent: undefined,
          errorMessage: undefined,
        });
      }
      return this.updateState({
        stage: 'error',
        errorMessage: err instanceof Error ? err.message : '安装包下载中断，请重试。',
      });
    }
  }

  async installAndRestart(): Promise<void> {
    if (this.installing) return;

    // 1. Windows（或已签名 macOS）走 electron-updater 静默覆盖 + 强制自动重启
    if (this.downloadedViaAutoUpdater && app.isPackaged) {
      this.installing = true;
      setTimeout(() => {
        try {
          this.options.onBeforeInstall?.();
        } catch {
          // 忽略清理异常，继续完成重启更新
        }
        autoUpdater.quitAndInstall(true, true);
      }, 80);
      return;
    }

    // 2. macOS 未签名零成本一键「重启以更新」：拉起脱离父进程的原子替换脚本后优雅退出当前实例
    if (
      process.platform === 'darwin' &&
      this.stagedMacUpdate &&
      fs.existsSync(this.stagedMacUpdate.stagedAppPath)
    ) {
      this.installing = true;
      const { targetAppPath, stagedAppPath, workDir } = this.stagedMacUpdate;
      const backupAppPath = path.join(
        path.dirname(targetAppPath),
        `.${path.basename(targetAppPath)}.backup-${process.pid}`,
      );
      const scriptPath = path.join(workDir, 'apply-update.sh');
      const scriptBody = buildMacSelfReplaceScript({
        oldPid: process.pid,
        targetAppPath,
        stagedAppPath,
        backupAppPath,
        workDir,
      });
      fs.writeFileSync(scriptPath, scriptBody, { mode: 0o700 });

      const helper = spawn('/bin/sh', [scriptPath], {
        detached: true,
        stdio: 'ignore',
      });
      helper.on('error', () => undefined);
      helper.unref();

      // 先让当前 ipcMain.handle 正常返回，避免同步 app.exit 撕裂 IPC/渲染进程触发 Electron 崩溃弹窗
      setTimeout(() => {
        try {
          this.options.onBeforeInstall?.();
        } catch {
          // 忽略清理异常
        }
        app.quit();
        setTimeout(() => app.exit(0), 1200);
      }, 80);
      return;
    }

    // 3. Windows 降级直链 .exe：同样支持静默覆盖并自动拉起新版
    if (
      process.platform === 'win32' &&
      this.state.downloadedFilePath &&
      this.state.downloadedFilePath.toLowerCase().endsWith('.exe') &&
      fs.existsSync(this.state.downloadedFilePath)
    ) {
      this.installing = true;
      const installer = spawn(this.state.downloadedFilePath, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      installer.on('error', () => undefined);
      installer.unref();

      setTimeout(() => {
        try {
          this.options.onBeforeInstall?.();
        } catch {
          // 忽略清理异常
        }
        app.quit();
        setTimeout(() => app.exit(0), 1200);
      }, 80);
      return;
    }

    // 4. 兜底（如只读 DMG 卷或 Linux）：打开安装包或 Release 页面
    if (this.state.downloadedFilePath && fs.existsSync(this.state.downloadedFilePath)) {
      await shell.openPath(this.state.downloadedFilePath);
      return;
    }
    if (this.state.releaseUrl) {
      await shell.openExternal(this.state.releaseUrl);
    }
  }
}
