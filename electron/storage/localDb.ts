/**
 * L3 结构化缓存与本地数据层：借鉴 Cherry Studio / AFFiNE 模式，
 * 使用 Node/Electron 内置 node:sqlite（WAL 模式 + PRAGMA user_version 迁移 + withWriteTx 同步事务），
 * 零 C++ 原生编译依赖，避免跨平台 electron-rebuild 陷阱。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DocRecentItem, WeeklyDraftRecord } from '../../src/shared/ipc';

interface SqliteStatementLike {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => Record<string, unknown> | null | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}

interface SqliteDatabaseLike {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatementLike;
  close: () => void;
}

function openNativeSqlite(dbPath: string): SqliteDatabaseLike | null {
  try {
    // Electron 主进程 / Node 22+ 使用内置 node:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite') as {
      DatabaseSync?: new (location: string) => SqliteDatabaseLike;
    };
    if (sqlite?.DatabaseSync) {
      return new sqlite.DatabaseSync(dbPath);
    }
  } catch {
    // 非 Node 22+ 环境继续尝试 Bun 内置 bun:sqlite
  }

  try {
    const bunSqliteId = ['bun', 'sqlite'].join(':');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunSqlite = require(bunSqliteId) as {
      Database?: new (location: string) => SqliteDatabaseLike;
    };
    if (bunSqlite?.Database) {
      return new bunSqlite.Database(dbPath);
    }
  } catch {
    // 均不可用时回退内存实现
  }
  return null;
}

export class LocalDB {
  private db: SqliteDatabaseLike | null;
  private readonly memoryCache = new Map<string, { value: string; updatedAt: number }>();
  private readonly memoryDrafts = new Map<string, WeeklyDraftRecord>();
  private readonly memoryRecents = new Map<string, DocRecentItem>();

  constructor(userDataDir: string, dbFileName = 'orbit.db') {
    if (dbFileName !== ':memory:') {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    const dbPath = dbFileName === ':memory:' ? ':memory:' : path.join(userDataDir, dbFileName);
    this.db = openNativeSqlite(dbPath);
    if (this.db) {
      this.initSchema();
    }
  }

  get engine(): 'sqlite' | 'memory-fallback' {
    return this.db ? 'sqlite' : 'memory-fallback';
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    const row = this.db.prepare('PRAGMA user_version').get();
    const version = Number(row?.user_version ?? 0);

    if (version < 1) {
      this.withWriteTx(() => {
        this.db!.exec(`
          CREATE TABLE IF NOT EXISTS kv_cache (
            scope TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, key)
          );
          CREATE TABLE IF NOT EXISTS weekly_report_drafts (
            scope TEXT NOT NULL,
            week TEXT NOT NULL,
            content TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, week)
          );
          CREATE TABLE IF NOT EXISTS doc_recents (
            scope TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            visited_at INTEGER NOT NULL,
            PRIMARY KEY (scope, url)
          );
          CREATE INDEX IF NOT EXISTS idx_doc_recents_visited
            ON doc_recents (scope, visited_at DESC);
          PRAGMA user_version = 1;
        `);
      });
    }
  }

  withWriteTx<T>(fn: () => T): T {
    if (!this.db) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getCache<T = unknown>(scope: string, key: string): { value: T; updatedAt: number } | null {
    if (!this.db) {
      const hit = this.memoryCache.get(`${scope}::${key}`);
      if (!hit) return null;
      return { value: JSON.parse(hit.value) as T, updatedAt: hit.updatedAt };
    }
    const row = this.db
      .prepare('SELECT value, updated_at FROM kv_cache WHERE scope = ? AND key = ?')
      .get(scope, key);
    if (!row) return null;
    try {
      return {
        value: JSON.parse(String(row.value)) as T,
        updatedAt: Number(row.updated_at),
      };
    } catch {
      return null;
    }
  }

  setCache(scope: string, key: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    const now = Date.now();
    if (!this.db) {
      this.memoryCache.set(`${scope}::${key}`, { value: serialized, updatedAt: now });
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO kv_cache (scope, key, value, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(scope, key, serialized, now);
    });
  }

  getWeeklyDraft(scope: string, week: string): WeeklyDraftRecord | null {
    if (!this.db) {
      return this.memoryDrafts.get(`${scope}::${week}`) ?? null;
    }
    const row = this.db
      .prepare('SELECT week, content, updated_at FROM weekly_report_drafts WHERE scope = ? AND week = ?')
      .get(scope, week);
    if (!row) return null;
    return {
      week: String(row.week),
      content: String(row.content),
      updatedAt: Number(row.updated_at),
    };
  }

  saveWeeklyDraft(scope: string, week: string, content: string): WeeklyDraftRecord {
    const now = Date.now();
    const record: WeeklyDraftRecord = { week, content, updatedAt: now };
    if (!this.db) {
      this.memoryDrafts.set(`${scope}::${week}`, record);
      return record;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO weekly_report_drafts (scope, week, content, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope, week) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        )
        .run(scope, week, content, now);
    });
    return record;
  }

  recordDocVisit(scope: string, url: string, title: string): void {
    const now = Date.now();
    const cleanTitle = title.trim() || url;
    if (!this.db) {
      this.memoryRecents.set(`${scope}::${url}`, { url, title: cleanTitle, visitedAt: now });
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO doc_recents (scope, url, title, visited_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope, url) DO UPDATE SET title = excluded.title, visited_at = excluded.visited_at`,
        )
        .run(scope, url, cleanTitle, now);
    });
  }

  listDocRecents(scope: string, query?: string, limit = 12): DocRecentItem[] {
    const q = (query ?? '').trim().toLowerCase();
    if (!this.db) {
      return [...this.memoryRecents.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, item]) => item)
        .filter((item) => !q || item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q))
        .sort((a, b) => b.visitedAt - a.visitedAt)
        .slice(0, limit);
    }
    const rows = q
      ? this.db
          .prepare(
            `SELECT url, title, visited_at FROM doc_recents
             WHERE scope = ? AND (lower(title) LIKE ? OR lower(url) LIKE ?)
             ORDER BY visited_at DESC LIMIT ?`,
          )
          .all(scope, `%${q}%`, `%${q}%`, limit)
      : this.db
          .prepare(
            `SELECT url, title, visited_at FROM doc_recents
             WHERE scope = ? ORDER BY visited_at DESC LIMIT ?`,
          )
          .all(scope, limit);
    return rows.map((row) => ({
      url: String(row.url),
      title: String(row.title),
      visitedAt: Number(row.visited_at),
    }));
  }

  clearScope(scope: string): void {
    if (!this.db) {
      for (const map of [this.memoryCache, this.memoryRecents]) {
        for (const k of [...map.keys()]) {
          if (k.startsWith(`${scope}::`)) map.delete(k);
        }
      }
      return;
    }
    this.withWriteTx(() => {
      this.db!.prepare('DELETE FROM kv_cache WHERE scope = ?').run(scope);
      this.db!.prepare('DELETE FROM doc_recents WHERE scope = ?').run(scope);
    });
  }

  close(): void {
    const current = this.db;
    this.db = null;
    if (!current) return;
    try {
      current.close();
    } catch {
      // 忽略重复关闭异常，保证退出与重启更新幂等
    }
  }
}
