import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMacSelfReplaceScript,
  compareSemver,
  parseLatestManifestYaml,
  resolveMacAppBundlePath,
  shellQuotePosix,
} from '../electron/updater/manifest';

describe('releaseUpdater manifest parser & macOS self-replace helpers', () => {
  test('正确解析 latest-mac.yml 并提取 sha512 与直链资产列表', () => {
    const yaml = `
version: 0.1.5
files:
  - url: Orbit-0.1.5-mac-x64.zip
    sha512: abc==
    size: 123651194
  - url: Orbit-0.1.5-mac-arm64.dmg
    sha512: def==
    size: 124366599
path: Orbit-0.1.5-mac-x64.zip
releaseDate: '2026-11-21T14:06:59.813Z'
`;
    const parsed = parseLatestManifestYaml(yaml, 'lec-org/lec-orbit');
    expect(parsed?.version).toBe('0.1.5');
    expect(parsed?.releaseDate).toBe('2026-11-21T14:06:59.813Z');
    expect(parsed?.assets).toHaveLength(2);
    expect(parsed?.assets[1]).toEqual({
      name: 'Orbit-0.1.5-mac-arm64.dmg',
      browser_download_url:
        'https://github.com/lec-org/lec-orbit/releases/download/v0.1.5/Orbit-0.1.5-mac-arm64.dmg',
      size: 124366599,
      sha512: 'def==',
    });
    expect(compareSemver('0.1.5', '0.1.4')).toBeGreaterThan(0);
  });

  test('正确解析 Windows latest.yml（含 sha512）', () => {
    const yaml = `
version: 0.1.5
files:
  - url: Orbit-0.1.5-win-x64-Setup.exe
    sha512: winSha512==
    size: 109467650
path: Orbit-0.1.5-win-x64-Setup.exe
releaseDate: '2026-11-21T14:06:18.749Z'
`;
    const parsed = parseLatestManifestYaml(yaml, 'lec-org/lec-orbit');
    expect(parsed?.version).toBe('0.1.5');
    expect(parsed?.assets[0]?.name).toBe('Orbit-0.1.5-win-x64-Setup.exe');
    expect(parsed?.assets[0]?.size).toBe(109467650);
    expect(parsed?.assets[0]?.sha512).toBe('winSha512==');
  });

  test('resolveMacAppBundlePath 正确区分可原位替换的 .app 与只读/沙箱/开发态路径', () => {
    expect(resolveMacAppBundlePath('/Applications/Orbit.app/Contents/MacOS/Orbit')).toBe(
      '/Applications/Orbit.app',
    );
    expect(
      resolveMacAppBundlePath('/Users/alice/Applications/Orbit.app/Contents/MacOS/Orbit'),
    ).toBe('/Users/alice/Applications/Orbit.app');
    // DMG 只读挂载卷不可原位替换
    expect(resolveMacAppBundlePath('/Volumes/Orbit 0.1.4/Orbit.app/Contents/MacOS/Orbit')).toBeNull();
    // Gatekeeper AppTranslocation 沙箱不可原位替换
    expect(
      resolveMacAppBundlePath(
        '/private/var/folders/xx/T/AppTranslocation/ABCD/d/Orbit.app/Contents/MacOS/Orbit',
      ),
    ).toBeNull();
    // 开发态 Electron.app 不可原位替换
    expect(
      resolveMacAppBundlePath(
        '/Users/dev/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      ),
    ).toBeNull();
  });

  test('shellQuotePosix 与 buildMacSelfReplaceScript 通过 /bin/sh -n 语法校验并正确执行原子替换', () => {
    expect(shellQuotePosix("/Applications/Orbit's Test.app")).toBe(
      "'/Applications/Orbit'\\''s Test.app'",
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-self-replace-test-'));
    try {
      const targetApp = path.join(tmpRoot, 'Orbit.app');
      const workDir = path.join(tmpRoot, 'work dir');
      const stagedApp = path.join(workDir, 'extracted', 'Orbit.app');
      const backupApp = path.join(tmpRoot, '.Orbit.app.backup-999');

      fs.mkdirSync(path.join(targetApp, 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(targetApp, 'Contents', 'version.txt'), '0.1.4');

      fs.mkdirSync(path.join(stagedApp, 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(stagedApp, 'Contents', 'version.txt'), '0.1.5');

      const script = buildMacSelfReplaceScript({
        oldPid: 99999999, // 不存在的 PID，脚本应立刻进入替换阶段
        targetAppPath: targetApp,
        stagedAppPath: stagedApp,
        backupAppPath: backupApp,
        workDir,
      });

      const scriptPath = path.join(workDir, 'apply-update.sh');
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });

      if (process.platform !== 'win32') {
        // 1. 语法严格检查
        execFileSync('/bin/sh', ['-n', scriptPath]);

        // 2. 用无副作用版本（去掉最后一行 open 避免拉起 Finder）真实跑一遍原子替换 + 清理
        const testableScript = script.replace(
          '/usr/bin/open "$TARGET_APP" 2>/dev/null || true',
          'true',
        );
        const testablePath = path.join(workDir, 'apply-update-test.sh');
        fs.writeFileSync(testablePath, testableScript, { mode: 0o700 });
        execFileSync('/bin/sh', [testablePath]);

        expect(fs.readFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'utf8')).toBe(
          '0.1.5',
        );
        expect(fs.existsSync(backupApp)).toBe(false);
        expect(fs.existsSync(workDir)).toBe(false);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
