import { expect, test } from 'bun:test';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { WindowsReleaseProvider } from '../electron/updater/windowsReleaseProvider';

test('Windows 增量下载逐段请求，并按新旧标签分别定位分块索引', async () => {
  const provider = new WindowsReleaseProvider(
    { provider: 'custom', repo: 'lec-org/lec-orbit' },
    {} as AppUpdater,
    { platform: 'win32', isUseMultipleRangeRequest: true } as ProviderRuntimeOptions,
  );
  const [file] = provider.resolveFiles({
    version: '0.2.4',
    files: [{ url: 'Orbit-0.2.4-win-x64-Setup.exe', sha512: 'example' }],
  } as UpdateInfo);
  const release = 'https://github.com/lec-org/lec-orbit/releases/download';
  expect(file.url.href).toBe(`${release}/v0.2.4/Orbit-0.2.4-win-x64-Setup.exe`);
  expect(provider.isUseMultipleRangeRequest).toBe(false);
  const maps = await provider.getBlockMapFiles(file.url, '0.2.3', '0.2.4');
  expect(maps.map((url) => url.href)).toEqual([
    `${release}/v0.2.3/Orbit-0.2.3-win-x64-Setup.exe.blockmap`,
    `${release}/v0.2.4/Orbit-0.2.4-win-x64-Setup.exe.blockmap`,
  ]);
});
