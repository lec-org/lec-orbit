import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../electron/storage/configStore';

test('ConfigStore 原子持久化并在重载后恢复配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-orbit-cfg-'));
  try {
    const store = new ConfigStore(dir);
    assert.equal(store.get().theme, 'system');
    store.update({ theme: 'dark', docHibernateMinutes: 20, closeToTray: false });

    const reloaded = new ConfigStore(dir);
    assert.equal(reloaded.get().theme, 'dark');
    assert.equal(reloaded.get().docHibernateMinutes, 20);
    assert.equal(reloaded.get().closeToTray, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ConfigStore 遇到损坏 JSON 文件时安全回退默认配置不崩溃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-orbit-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json', 'utf8');
    const store = new ConfigStore(dir);
    assert.equal(store.get().theme, 'system');
    assert.equal(store.get().closeToTray, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
