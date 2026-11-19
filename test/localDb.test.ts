import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDB } from '../electron/storage/localDb';

test('LocalDB 支持按 scope 隔离 SWR 缓存、周报草稿与 LecDoc 最近访问检索', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-orbit-db-'));
  const db = new LocalDB(dir);
  try {
    assert.equal(db.engine, 'sqlite');
    const scopeA = 'campus:user-a';
    const scopeB = 'campus:user-b';

    db.setCache(scopeA, 'punch:attendance', { isCheckedIn: true, todayDurationSeconds: 3600 });
    assert.equal(db.getCache<{ isCheckedIn: boolean }>(scopeA, 'punch:attendance')?.value.isCheckedIn, true);
    assert.equal(db.getCache(scopeB, 'punch:attendance'), null);

    db.saveWeeklyDraft(scopeA, '2026-W47', '本周完成 Orbit Stage 1A');
    assert.equal(db.getWeeklyDraft(scopeA, '2026-W47')?.content, '本周完成 Orbit Stage 1A');

    db.recordDocVisit(scopeA, 'https://doc.lecspace.top/s/onboarding', '新人入场手册');
    db.recordDocVisit(scopeA, 'https://doc.lecspace.top/s/deploy', '校园生产部署指南');
    const filtered = db.listDocRecents(scopeA, '部署');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.title, '校园生产部署指南');

    // 清理缓存时清空 kv 与 doc_recents，但保留周报草稿防丢字
    db.clearScope(scopeA);
    assert.equal(db.getCache(scopeA, 'punch:attendance'), null);
    assert.equal(db.listDocRecents(scopeA).length, 0);
    assert.equal(db.getWeeklyDraft(scopeA, '2026-W47')?.content, '本周完成 Orbit Stage 1A');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
