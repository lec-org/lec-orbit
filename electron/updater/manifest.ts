/**
 * GitHub Releases 更新清单纯解析工具（不依赖 Electron 运行时，便于单测）：
 * 直接解析 electron-builder 生成的 latest-mac.yml / latest.yml，
 * 走 GitHub Releases CDN 绕开 api.github.com 每 IP 60 次/小时的限流。
 */

export interface ReleaseAssetInfo {
  name: string;
  browser_download_url: string;
  size: number;
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

  const flush = () => {
    if (!currentUrl) return;
    const name = currentUrl.trim();
    if (name && !assets.some((a) => a.name === name)) {
      assets.push({
        name,
        browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`,
        size: currentSize,
      });
    }
    currentUrl = null;
    currentSize = 0;
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
      if (/^\S/.test(line)) {
        flush();
      }
    }
  }
  flush();

  if (assets.length === 0) {
    const pathMatch = yamlText.match(/^path:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
    if (pathMatch?.[1]) {
      const name = pathMatch[1].trim();
      assets.push({
        name,
        browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`,
        size: 0,
      });
    }
  }

  return { version, releaseDate, assets };
}
