/**
 * Orbit 客户端 GitHub Releases 自动更新与应用内进度下载：
 * - 统一拉取 https://api.github.com/repos/lec-org/lec-orbit/releases/latest 的版本号、更新日志与对应平台安装包资产；
 * - 启动延迟静默检查 + 每 4 小时后台自动轮询，推送状态给全局更新提示条；
 * - Windows 打包态（及签名 macOS）优先走 electron-updater 全自动下载并重启安装；
 * - 未签名 macOS 或直链安装包场景：直接通过主进程流式下载 .dmg/.exe 到系统下载目录（实时回传 0~100% 进度），下完一键打开安装包完成升级。
 */
import { app, net, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateCheckResult } from '../../src/shared/ipc';
import {
  compareSemver,
  parseLatestManifestYaml,
  type ParsedLatestManifest,
  type ReleaseAssetInfo,
} from './manifest';

const GITHUB_REPO = process.env.ORBIT_UPDATE_GITHUB_REPO?.trim() || 'lec-org/lec-orbit';
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const LATEST_RELEASE_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;
const LATEST_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO}/releases/latest/download`;

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

export { compareSemver, parseLatestManifestYaml };

function pickPlatformAsset(assets: GitHubAsset[] | undefined): GitHubAsset | null {
  if (!assets || assets.length === 0) return null;
  const platform = process.platform;
  const arch = process.arch; // arm64 / x64

  const score = (asset: GitHubAsset): number => {
    const n = asset.name.toLowerCase();
    if (n.endsWith('.blockmap') || n.endsWith('.yml') || n.endsWith('.yaml') || n.endsWith('.sha256')) {
      return -100;
    }
    if (platform === 'darwin') {
      let s = 0;
      if (n.endsWith('.dmg')) s += 40;
      else if (n.endsWith('.zip') && (n.includes('mac') || n.includes('darwin') || n.includes('arm64') || n.includes('x64'))) s += 20;
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
  private state: UpdateCheckResult = {
    currentVersion: app.getVersion(),
    available: false,
    checked: false,
    stage: 'idle',
  };
  private readonly listeners = new Set<(state: UpdateCheckResult) => void>();

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

  private supportsNativeAutoInstall(): boolean {
    if (!app.isPackaged) return false;
    // Windows NSIS 完整支持原位自动安装；macOS 仅在明确开启签名模式时走 Squirrel 原位替换
    if (process.platform === 'win32') return true;
    if (process.platform === 'darwin') return process.env.ORBIT_MAC_SIGNED_AUTO_UPDATE === '1';
    return false;
  }

  private ensureAutoUpdaterInit(): void {
    if (this.initialized) return;
    this.initialized = true;
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
        const asset = pickPlatformAsset(manifest.assets);
        const canAutoInstall = this.supportsNativeAutoInstall();
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
        const asset = pickPlatformAsset(gh.assets);
        const canAutoInstall = this.supportsNativeAutoInstall();
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

      // 仓库尚无正式 Release（404）时视为已是最新，不弹红错
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

  async download(): Promise<UpdateCheckResult> {
    if (this.downloading) return this.state;

    // 1. 支持原生自动安装（Windows NSIS / 已签名 macOS）-> 走 electron-updater
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

    // 2. 应用内流式下载 GitHub Release 对应平台安装包（.dmg / .exe / .AppImage），实时汇报进度
    const assetUrl = this.state.assetUrl;
    if (!assetUrl) {
      if (this.state.releaseUrl) {
        await shell.openExternal(this.state.releaseUrl);
      }
      return this.state;
    }

    this.downloading = true;
    this.downloadedViaAutoUpdater = false;
    this.updateState({ stage: 'downloading', progressPercent: 0, errorMessage: undefined });

    try {
      const res = await net.fetch(assetUrl, {
        headers: { 'User-Agent': `Orbit-Desktop/${app.getVersion()}` },
      });
      if (!res.ok || !res.body) {
        throw new Error(`下载安装包失败（HTTP ${res.status}）`);
      }

      const totalBytes = Number(res.headers.get('content-length')) || this.state.assetSize || 0;
      const safeFileName = (this.state.assetName || `Orbit-${this.state.latestVersion || 'latest'}.dmg`).replace(
        /[^a-zA-Z0-9._-]/g,
        '_',
      );
      const targetDir = app.getPath('downloads');
      const finalPath = path.join(targetDir, safeFileName);
      const partPath = `${finalPath}.part`;

      fs.mkdirSync(targetDir, { recursive: true });
      const fileStream = fs.createWriteStream(partPath);
      const reader = res.body.getReader();

      let received = 0;
      let lastPercent = -1;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          fileStream.write(Buffer.from(value));
          received += value.byteLength;
          if (totalBytes > 0) {
            const pct = Math.min(99, Math.round((received / totalBytes) * 100));
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

      fs.renameSync(partPath, finalPath);
      this.downloading = false;
      return this.updateState({
        stage: 'downloaded',
        progressPercent: 100,
        downloadedFilePath: finalPath,
        canAutoInstall: false,
      });
    } catch (err) {
      this.downloading = false;
      return this.updateState({
        stage: 'error',
        errorMessage: err instanceof Error ? err.message : '安装包下载中断，请重试。',
      });
    }
  }

  async installAndRestart(): Promise<void> {
    if (this.downloadedViaAutoUpdater && app.isPackaged) {
      autoUpdater.quitAndInstall();
      return;
    }
    if (this.state.downloadedFilePath && fs.existsSync(this.state.downloadedFilePath)) {
      await shell.openPath(this.state.downloadedFilePath);
      return;
    }
    if (this.state.releaseUrl) {
      await shell.openExternal(this.state.releaseUrl);
    }
  }
}
