/**
 * GitHub Releases 更新清单纯解析工具与 macOS 自替换脚本构造器（无 Electron 运行时依赖，便于单测）：
 * - 直接解析 electron-builder 生成的 latest-mac.yml / latest.yml（含 sha512 校验值），
 *   走 GitHub Releases CDN 绕开 api.github.com 每 IP 60 次/小时的限流；
 * - 提供 macOS 原位 .app 路径解析与脱离父进程的原子替换脚本构造（带失败自动回滚）。
 */

export interface ReleaseAssetInfo {
  name: string;
  browser_download_url: string;
  size: number;
  sha512?: string;
}

export interface ParsedLatestManifest {
  version: string;
  releaseDate?: string;
  assets: ReleaseAssetInfo[];
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((n) => Number(n) || 0);
  const pb = b.replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function parseLatestManifestYaml(
  yamlText: string,
  repo: string = 'lec-org/lec-orbit',
): ParsedLatestManifest | null {
  const versionMatch = yamlText.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m);
  if (!versionMatch?.[1]) return null;
  const version = versionMatch[1].replace(/^v/i, '').trim();
  if (!version) return null;

  const dateMatch = yamlText.match(/^releaseDate:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
  const releaseDate = dateMatch?.[1]?.trim();

  const assets: ReleaseAssetInfo[] = [];
  const lines = yamlText.split(/\r?\n/);
  let currentUrl: string | null = null;
  let currentSize = 0;
  let currentSha512: string | undefined;

  const flush = () => {
    if (!currentUrl) return;
    const name = currentUrl.trim();
    if (name && !assets.some((a) => a.name === name)) {
      assets.push({
        name,
        browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`,
        size: currentSize,
        ...(currentSha512 ? { sha512: currentSha512 } : {}),
      });
    }
    currentUrl = null;
    currentSize = 0;
    currentSha512 = undefined;
  };

  for (const line of lines) {
    const urlMatch = line.match(/^\s*-\s*url:\s*['"]?([^'"\r\n]+)['"]?\s*$/);
    if (urlMatch?.[1]) {
      flush();
      currentUrl = urlMatch[1].trim();
      continue;
    }
    if (currentUrl) {
      const sizeMatch = line.match(/^\s+size:\s*(\d+)\s*$/);
      if (sizeMatch?.[1]) {
        currentSize = Number(sizeMatch[1]) || 0;
        continue;
      }
      const shaMatch = line.match(/^\s+sha512:\s*['"]?([^'"\r\n]+)['"]?\s*$/);
      if (shaMatch?.[1]) {
        currentSha512 = shaMatch[1].trim();
        continue;
      }
      if (/^\S/.test(line)) {
        flush();
      }
    }
  }
  flush();

  if (assets.length === 0) {
    const pathMatch = yamlText.match(/^path:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
    const rootShaMatch = yamlText.match(/^sha512:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
    if (pathMatch?.[1]) {
      const name = pathMatch[1].trim();
      assets.push({
        name,
        browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`,
        size: 0,
        ...(rootShaMatch?.[1] ? { sha512: rootShaMatch[1].trim() } : {}),
      });
    }
  }

  return { version, releaseDate, assets };
}

/**
 * 从 macOS `process.execPath`（如 `/Applications/Orbit.app/Contents/MacOS/Orbit`）解析当前运行的 `.app` 根路径。
 * - 若运行在只读 DMG 挂载卷（`/Volumes/...`）或 Gatekeeper 隔离沙箱（`/AppTranslocation/...`）中，返回 null（应回退手动打开 DMG）。
 */
export function resolveMacAppBundlePath(execPath: string): string | null {
  const normalized = execPath.trim();
  if (!normalized.startsWith('/')) return null;
  if (normalized.startsWith('/Volumes/') || normalized.includes('/AppTranslocation/')) {
    return null;
  }
  const marker = '.app/Contents/MacOS/';
  const idx = normalized.indexOf(marker);
  if (idx <= 0) return null;
  const appPath = normalized.slice(0, idx + 4);
  // 排除开发态 Electron.app
  if (/\/node_modules\//i.test(appPath) || /\/Electron\.app$/i.test(appPath)) {
    return null;
  }
  return appPath;
}

/** 将任意路径安全转义为 POSIX `/bin/sh` 单引号字面量。 */
export function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface MacSelfReplaceScriptParams {
  oldPid: number;
  targetAppPath: string;
  stagedAppPath: string;
  backupAppPath: string;
  workDir: string;
}

/**
 * 构造脱离父进程运行的 macOS 原子替换更新脚本：
 * 1. 等待旧进程 PID 完全退出（最长 20 秒）；
 * 2. 将旧 .app 原子移至备份路径，再将新版 .app 移入原路径（跨卷自动回退 ditto）；
 * 3. 若替换失败自动将旧版移回原位并重新拉起旧版；
 * 4. 清除 quarantine 属性、清理临时目录、拉起新版 Orbit。
 */
export function buildMacSelfReplaceScript(params: MacSelfReplaceScriptParams): string {
  const oldPid = Math.max(1, Math.floor(params.oldPid));
  const target = shellQuotePosix(params.targetAppPath);
  const staged = shellQuotePosix(params.stagedAppPath);
  const backup = shellQuotePosix(params.backupAppPath);
  const workDir = shellQuotePosix(params.workDir);

  return [
    '#!/bin/sh',
    'set -u',
    `OLD_PID=${oldPid}`,
    `TARGET_APP=${target}`,
    `STAGED_APP=${staged}`,
    `BACKUP_APP=${backup}`,
    `WORK_DIR=${workDir}`,
    '',
    '# 1. 等待旧版 Orbit 进程完全退出',
    'WAIT_COUNT=0',
    'while kill -0 "$OLD_PID" 2>/dev/null; do',
    '  WAIT_COUNT=$((WAIT_COUNT + 1))',
    '  if [ "$WAIT_COUNT" -eq 50 ]; then',
    '    kill -TERM "$OLD_PID" 2>/dev/null || true',
    '  fi',
    '  if [ "$WAIT_COUNT" -ge 100 ]; then',
    '    exit 1',
    '  fi',
    '  sleep 0.2',
    'done',
    '',
    '# 2. 校验预解压的新版本存在',
    'if [ ! -d "$STAGED_APP" ]; then',
    '  exit 1',
    'fi',
    '',
    '# 3. 原子替换（先备份旧版，失败自动回滚）',
    'rm -rf "$BACKUP_APP" 2>/dev/null || true',
    'if [ -d "$TARGET_APP" ]; then',
    '  if ! mv "$TARGET_APP" "$BACKUP_APP"; then',
    '    exit 1',
    '  fi',
    'fi',
    '',
    'REPLACED=0',
    'if mv "$STAGED_APP" "$TARGET_APP" 2>/dev/null; then',
    '  REPLACED=1',
    'elif /usr/bin/ditto "$STAGED_APP" "$TARGET_APP" 2>/dev/null; then',
    '  REPLACED=1',
    'fi',
    '',
    'if [ "$REPLACED" -ne 1 ]; then',
    '  rm -rf "$TARGET_APP" 2>/dev/null || true',
    '  if [ -d "$BACKUP_APP" ]; then',
    '    mv "$BACKUP_APP" "$TARGET_APP" 2>/dev/null || true',
    '    /usr/bin/open "$TARGET_APP" 2>/dev/null || true',
    '  fi',
    '  exit 1',
    'fi',
    '',
    '# 4. 清除隔离属性、刷新图标时间戳、清理旧备份与临时目录',
    '/usr/bin/xattr -cr "$TARGET_APP" 2>/dev/null || true',
    '/usr/bin/touch "$TARGET_APP" 2>/dev/null || true',
    'rm -rf "$BACKUP_APP" "$WORK_DIR" 2>/dev/null || true',
    '',
    '# 5. 拉起新版本 Orbit',
    '/usr/bin/open "$TARGET_APP" 2>/dev/null || true',
    '',
  ].join('\n');
}
