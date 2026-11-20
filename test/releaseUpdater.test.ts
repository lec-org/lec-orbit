import { describe, expect, test } from 'bun:test';
import { compareSemver, parseLatestManifestYaml } from '../electron/updater/manifest';

describe('releaseUpdater manifest parser', () => {
  test('正确解析 latest-mac.yml 并生成直链资产列表', () => {
    const yaml = `
version: 0.1.2
files:
  - url: Orbit-0.1.2-mac-x64.zip
    sha512: abc
    size: 123651194
  - url: Orbit-0.1.2-mac-arm64.dmg
    sha512: def
    size: 124366599
path: Orbit-0.1.2-mac-x64.zip
releaseDate: '2026-11-20T06:06:59.813Z'
`;
    const parsed = parseLatestManifestYaml(yaml, 'lec-org/lec-orbit');
    expect(parsed?.version).toBe('0.1.2');
    expect(parsed?.releaseDate).toBe('2026-11-20T06:06:59.813Z');
    expect(parsed?.assets).toHaveLength(2);
    expect(parsed?.assets[1]).toEqual({
      name: 'Orbit-0.1.2-mac-arm64.dmg',
      browser_download_url: 'https://github.com/lec-org/lec-orbit/releases/download/v0.1.2/Orbit-0.1.2-mac-arm64.dmg',
      size: 124366599,
    });
    expect(compareSemver('0.1.2', '0.1.0')).toBeGreaterThan(0);
  });

  test('正确解析 Windows latest.yml', () => {
    const yaml = `
version: 0.1.2
files:
  - url: Orbit-0.1.2-win-x64-Setup.exe
    size: 109467650
path: Orbit-0.1.2-win-x64-Setup.exe
releaseDate: '2026-11-20T06:06:18.749Z'
`;
    const parsed = parseLatestManifestYaml(yaml, 'lec-org/lec-orbit');
    expect(parsed?.version).toBe('0.1.2');
    expect(parsed?.assets[0]?.name).toBe('Orbit-0.1.2-win-x64-Setup.exe');
    expect(parsed?.assets[0]?.size).toBe(109467650);
  });
});
