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
import { app, net, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UpdateCheckResult } from '../../src/shared/ipc';
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

type GitHubAsset = ReleaseAssetInfo;

interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string;
  assets?: GitHubAsset[];
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
  private downloadedViaAutoUpdater = false;
  private downloading = false;
  private expectedAssetSha512: string | undefined;
  private stagedMacUpdate: StagedMacUpdate | null = null;
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

  /** 启动后延迟静默检查 + 每 4 小时后台自动检查。 */
  startAutoCheck(): void {
    this.stopAutoCheck();
    this.initialTimer = setTimeout(() => {
      void this.check();
    }, 6_000);
    this.pollTimer = setInterval(() => {
      if (this.state.stage !== 'downloading' && this.state.stage !== 'downloaded') {
        void this.check();
      }
    }, 4 * 60 * 60 * 1000);
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
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: LATEST_DOWNLOAD_BASE,
    });
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
      this.downloading = false;
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

  private async fetchReleaseNotesBestEffort(version: string): Promise<string | undefined> {
    try {
      const res = await net.fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${encodeURIComponent(version)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `Orbit-Desktop/${app.getVersion()}`,
          },
        },
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as GitHubReleasePayload;
      return (data.body || '').trim() || undefined;
    } catch {
      return undefined;
    }
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

  async check(): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();
    const preferMacZip = Boolean(this.getReplaceableMacAppPath());
    this.updateState({
      currentVersion,
      stage: 'checking',
      errorMessage: undefined,
    });

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
        const releaseNotes = available ? await this.fetchReleaseNotesBestEffort(latestVersion) : undefined;
        return this.updateState({
          currentVersion,
          latestVersion,
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${latestVersion}`,
          releaseNotes,
          publishedAt: manifest.releaseDate,
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
        return this.updateState({
          currentVersion,
          latestVersion,
          releaseUrl: gh.html_url || LATEST_RELEASE_PAGE,
          releaseNotes: (gh.body || '').trim() || undefined,
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

  async download(): Promise<UpdateCheckResult> {
    if (this.downloading) return this.state;

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
      if (this.state.releaseUrl) {
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
        return this.updateState({
          stage: 'downloaded',
          progressPercent: 100,
          downloadedFilePath: staged.stagedAppPath,
          canAutoInstall: true,
        });
      }

      this.downloading = false;
      return this.updateState({
        stage: 'downloaded',
        progressPercent: 100,
        downloadedFilePath: finalPath,
        canAutoInstall: willDirectWinExe,
      });
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      this.downloading = false;
      return this.updateState({
        stage: 'error',
        errorMessage: err instanceof Error ? err.message : '安装包下载中断，请重试。',
      });
    }
  }

  async installAndRestart(): Promise<void> {
    // 1. Windows（或已签名 macOS）走 electron-updater 静默覆盖 + 强制自动重启
    if (this.downloadedViaAutoUpdater && app.isPackaged) {
      this.options.onBeforeInstall?.();
      autoUpdater.quitAndInstall(true, true);
      return;
    }

    // 2. macOS 未签名零成本一键「重启以更新」：拉起脱离父进程的原子替换脚本并立刻退出当前实例
    if (
      process.platform === 'darwin' &&
      this.stagedMacUpdate &&
      fs.existsSync(this.stagedMacUpdate.stagedAppPath)
    ) {
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
      helper.unref();

      this.options.onBeforeInstall?.();
      app.exit(0);
      return;
    }

    // 3. Windows 降级直链 .exe：同样支持静默覆盖并自动拉起新版
    if (
      process.platform === 'win32' &&
      this.state.downloadedFilePath &&
      this.state.downloadedFilePath.toLowerCase().endsWith('.exe') &&
      fs.existsSync(this.state.downloadedFilePath)
    ) {
      const installer = spawn(this.state.downloadedFilePath, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      installer.unref();

      this.options.onBeforeInstall?.();
      app.exit(0);
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
