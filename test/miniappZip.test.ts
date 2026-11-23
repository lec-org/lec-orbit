import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  extractZipBundleSafely,
  inspectZipBundle,
  sha256Hex,
} from '../electron/miniapp/zipExtractor';
import { LocalDB } from '../electron/storage/localDb';

/** 生成用于单测的标准 ZIP Buffer（支持 STORED 0 与 DEFLATE 8）。 */
function buildTestZip(
  files: Array<{ name: string; content: string | Buffer; deflate?: boolean }>,
): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    const method = f.deflate ? 8 : 0;
    const comp = f.deflate ? zlib.deflateRawSync(raw) : raw;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);

    localChunks.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);

    cdChunks.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

const VALID_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  id: 'demo-game',
  name: '测试小游戏',
  version: '1.0.0',
  type: 'minigame',
  engine: 'unity',
  entry: 'index.html',
});

describe('miniapp zipExtractor & LocalDB v2', () => {
  test('正常解压 STORED + DEFLATE 混合包，并自动剥离单层包装目录', () => {
    const zip = buildTestZip([
      { name: 'my-folder/orbit.manifest.json', content: VALID_MANIFEST, deflate: true },
      { name: 'my-folder/index.html', content: '<!doctype html><h1>hi</h1>', deflate: true },
      { name: 'my-folder/Build/game.wasm.br', content: Buffer.from([1, 2, 3, 4]), deflate: false },
    ]);

    const destDir = path.join(os.tmpdir(), `orbit-zip-ok-${Date.now()}`);
    try {
      const result = extractZipBundleSafely(zip, destDir, {
        expectedSha256: sha256Hex(zip),
      });
      expect(result.manifest.id).toBe('demo-game');
      expect(result.stripPrefix).toBe('my-folder/');
      expect(fs.existsSync(path.join(destDir, 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'Build', 'game.wasm.br'))).toBe(true);
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  test('严格拦截 Zip Slip 路径穿越与错误的 SHA256', () => {
    const evilZip = buildTestZip([
      { name: 'orbit.manifest.json', content: VALID_MANIFEST },
      { name: '../evil.sh', content: 'echo pwned' },
    ]);
    expect(() => inspectZipBundle(evilZip)).toThrow(/路径穿越/);

    const okZip = buildTestZip([
      { name: 'orbit.manifest.json', content: VALID_MANIFEST },
      { name: 'index.html', content: '<h1>ok</h1>' },
    ]);
    expect(() =>
      inspectZipBundle(okZip, { expectedSha256: '0'.repeat(64) }),
    ).toThrow(/SHA256/);
  });

  test('LocalDB v2 正确持久化已安装应用、三态偏好与离线云存档缓存', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-v2-'));
    try {
      const db = new LocalDB(dir, 'orbit.db');
      const { info } = inspectZipBundle(
        buildTestZip([
          { name: 'orbit.manifest.json', content: VALID_MANIFEST },
          { name: 'index.html', content: '<h1>ok</h1>' },
        ]),
      );

      db.upsertInstalledApp({
        appId: 'demo-game',
        version: '1.0.0',
        sha256: info.sha256,
        sizeBytes: 1024,
        installDir: '/tmp/demo-game',
        manifest: info.manifest,
        installedAt: 1000,
        lastOpenedAt: 2000,
      });
      expect(db.getInstalledApp('demo-game')?.version).toBe('1.0.0');

      const pref = db.setAppPref('campus:u1', 'demo-game', {
        preferredMode: 'sidepanel',
        sidepanelWidth: 420,
        pinned: true,
      });
      expect(pref.preferredMode).toBe('sidepanel');
      expect(db.getAppPref('campus:u1', 'demo-game').sidepanelWidth).toBe(420);

      db.setMiniAppKv('campus:u1', 'demo-game', 'best-score', '999');
      expect(db.getMiniAppKv('campus:u1', 'demo-game', 'best-score')).toBe('999');
      expect(db.listMiniAppKvKeys('campus:u1', 'demo-game')).toEqual(['best-score']);
      db.deleteMiniAppKv('campus:u1', 'demo-game', 'best-score');
      expect(db.getMiniAppKv('campus:u1', 'demo-game', 'best-score')).toBeNull();
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
