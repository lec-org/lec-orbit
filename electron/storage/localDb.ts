/**
 * L3 结构化缓存与本地数据层：借鉴 Cherry Studio / AFFiNE 模式，
 * 使用 Node/Electron 内置 node:sqlite（WAL 模式 + PRAGMA user_version 迁移 + withWriteTx 同步事务），
 * 零 C++ 原生编译依赖，避免跨平台 electron-rebuild 陷阱。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DocRecentItem, WeeklyDraftRecord } from '../../src/shared/ipc';
import {
  OrbitAppManifestSchema,
  type InstalledMiniAppRecord,
  type MiniAppDisplayMode,
  type MiniAppPermissionScope,
  type MiniAppUserPref,
} from '../../src/shared/miniapp';

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
  private readonly memoryInstalledApps = new Map<string, InstalledMiniAppRecord>();
  private readonly memoryAppPrefs = new Map<string, MiniAppUserPref>();
  private readonly memoryAppKv = new Map<string, { value: string; updatedAt: number }>();

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

    if (version < 2) {
      this.withWriteTx(() => {
        this.db!.exec(`
          CREATE TABLE IF NOT EXISTS mini_app_installed (
            app_id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            install_dir TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            installed_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS mini_app_prefs (
            scope TEXT NOT NULL,
            app_id TEXT NOT NULL,
            preferred_mode TEXT,
            sidepanel_width INTEGER,
            pinned INTEGER NOT NULL DEFAULT 0,
            granted_scopes_json TEXT NOT NULL DEFAULT '[]',
            last_opened_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (scope, app_id)
          );
          CREATE TABLE IF NOT EXISTS mini_app_kv_cache (
            scope TEXT NOT NULL,
            app_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, app_id, key)
          );
          PRAGMA user_version = 2;
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

  listInstalledApps(): InstalledMiniAppRecord[] {
    if (!this.db) {
      return [...this.memoryInstalledApps.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    }
    const rows = this.db
      .prepare(
        `SELECT app_id, version, sha256, size_bytes, install_dir, manifest_json, installed_at, last_opened_at
         FROM mini_app_installed ORDER BY last_opened_at DESC`,
      )
      .all();
    const out: InstalledMiniAppRecord[] = [];
    for (const row of rows) {
      try {
        const parsed = OrbitAppManifestSchema.parse(JSON.parse(String(row.manifest_json)));
        out.push({
          appId: String(row.app_id),
          version: String(row.version),
          sha256: String(row.sha256),
          sizeBytes: Number(row.size_bytes),
          installDir: String(row.install_dir),
          manifest: parsed,
          installedAt: Number(row.installed_at),
          lastOpenedAt: Number(row.last_opened_at),
        });
      } catch {
        // 忽略损坏的清单记录
      }
    }
    return out;
  }

  getInstalledApp(appId: string): InstalledMiniAppRecord | null {
    if (!this.db) {
      return this.memoryInstalledApps.get(appId) ?? null;
    }
    const row = this.db
      .prepare(
        `SELECT app_id, version, sha256, size_bytes, install_dir, manifest_json, installed_at, last_opened_at
         FROM mini_app_installed WHERE app_id = ?`,
      )
      .get(appId);
    if (!row) return null;
    try {
      return {
        appId: String(row.app_id),
        version: String(row.version),
        sha256: String(row.sha256),
        sizeBytes: Number(row.size_bytes),
        installDir: String(row.install_dir),
        manifest: OrbitAppManifestSchema.parse(JSON.parse(String(row.manifest_json))),
        installedAt: Number(row.installed_at),
        lastOpenedAt: Number(row.last_opened_at),
      };
    } catch {
      return null;
    }
  }

  upsertInstalledApp(record: InstalledMiniAppRecord): void {
    const manifestJson = JSON.stringify(record.manifest);
    if (!this.db) {
      this.memoryInstalledApps.set(record.appId, record);
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO mini_app_installed
             (app_id, version, sha256, size_bytes, install_dir, manifest_json, installed_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(app_id) DO UPDATE SET
             version = excluded.version,
             sha256 = excluded.sha256,
             size_bytes = excluded.size_bytes,
             install_dir = excluded.install_dir,
             manifest_json = excluded.manifest_json,
             installed_at = excluded.installed_at,
             last_opened_at = excluded.last_opened_at`,
        )
        .run(
          record.appId,
          record.version,
          record.sha256,
          record.sizeBytes,
          record.installDir,
          manifestJson,
          record.installedAt,
          record.lastOpenedAt,
        );
    });
  }

  touchInstalledApp(appId: string): void {
    const now = Date.now();
    if (!this.db) {
      const hit = this.memoryInstalledApps.get(appId);
      if (hit) this.memoryInstalledApps.set(appId, { ...hit, lastOpenedAt: now });
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('UPDATE mini_app_installed SET last_opened_at = ? WHERE app_id = ?')
        .run(now, appId);
    });
  }

  removeInstalledApp(appId: string): void {
    if (!this.db) {
      this.memoryInstalledApps.delete(appId);
      return;
    }
    this.withWriteTx(() => {
      this.db!.prepare('DELETE FROM mini_app_installed WHERE app_id = ?').run(appId);
    });
  }

  getAppPref(scope: string, appId: string): MiniAppUserPref {
    if (!this.db) {
      return this.memoryAppPrefs.get(`${scope}::${appId}`) ?? { appId };
    }
    const row = this.db
      .prepare(
        `SELECT app_id, preferred_mode, sidepanel_width, pinned, granted_scopes_json, last_opened_at
         FROM mini_app_prefs WHERE scope = ? AND app_id = ?`,
      )
      .get(scope, appId);
    if (!row) return { appId };
    let grantedScopes: MiniAppPermissionScope[] = [];
    try {
      const raw = JSON.parse(String(row.granted_scopes_json || '[]')) as unknown;
      if (Array.isArray(raw)) {
        grantedScopes = raw.filter((s): s is MiniAppPermissionScope => typeof s === 'string');
      }
    } catch {
      grantedScopes = [];
    }
    return {
      appId: String(row.app_id),
      preferredMode: row.preferred_mode ? (String(row.preferred_mode) as MiniAppDisplayMode) : undefined,
      sidepanelWidth: row.sidepanel_width != null ? Number(row.sidepanel_width) : undefined,
      pinned: Boolean(row.pinned),
      grantedScopes,
      lastOpenedAt: Number(row.last_opened_at || 0),
    };
  }

  listAppPrefs(scope: string): MiniAppUserPref[] {
    if (!this.db) {
      return [...this.memoryAppPrefs.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v);
    }
    const rows = this.db
      .prepare(
        `SELECT app_id, preferred_mode, sidepanel_width, pinned, granted_scopes_json, last_opened_at
         FROM mini_app_prefs WHERE scope = ? ORDER BY last_opened_at DESC`,
      )
      .all(scope);
    return rows.map((row) => {
      let grantedScopes: MiniAppPermissionScope[] = [];
      try {
        const raw = JSON.parse(String(row.granted_scopes_json || '[]')) as unknown;
        if (Array.isArray(raw)) {
          grantedScopes = raw.filter((s): s is MiniAppPermissionScope => typeof s === 'string');
        }
      } catch {
        grantedScopes = [];
      }
      return {
        appId: String(row.app_id),
        preferredMode: row.preferred_mode ? (String(row.preferred_mode) as MiniAppDisplayMode) : undefined,
        sidepanelWidth: row.sidepanel_width != null ? Number(row.sidepanel_width) : undefined,
        pinned: Boolean(row.pinned),
        grantedScopes,
        lastOpenedAt: Number(row.last_opened_at || 0),
      };
    });
  }

  setAppPref(
    scope: string,
    appId: string,
    patch: Partial<Omit<MiniAppUserPref, 'appId'>>,
  ): MiniAppUserPref {
    const current = this.getAppPref(scope, appId);
    const next: MiniAppUserPref = {
      appId,
      preferredMode: patch.preferredMode !== undefined ? patch.preferredMode : current.preferredMode,
      sidepanelWidth: patch.sidepanelWidth !== undefined ? patch.sidepanelWidth : current.sidepanelWidth,
      pinned: patch.pinned !== undefined ? patch.pinned : current.pinned ?? false,
      grantedScopes: patch.grantedScopes !== undefined ? patch.grantedScopes : current.grantedScopes ?? [],
      lastOpenedAt: patch.lastOpenedAt !== undefined ? patch.lastOpenedAt : current.lastOpenedAt ?? 0,
    };
    if (!this.db) {
      this.memoryAppPrefs.set(`${scope}::${appId}`, next);
      return next;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO mini_app_prefs
             (scope, app_id, preferred_mode, sidepanel_width, pinned, granted_scopes_json, last_opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, app_id) DO UPDATE SET
             preferred_mode = excluded.preferred_mode,
             sidepanel_width = excluded.sidepanel_width,
             pinned = excluded.pinned,
             granted_scopes_json = excluded.granted_scopes_json,
             last_opened_at = excluded.last_opened_at`,
        )
        .run(
          scope,
          appId,
          next.preferredMode ?? null,
          next.sidepanelWidth ?? null,
          next.pinned ? 1 : 0,
          JSON.stringify(next.grantedScopes ?? []),
          next.lastOpenedAt ?? 0,
        );
    });
    return next;
  }

  getMiniAppKv(scope: string, appId: string, key: string): string | null {
    if (!this.db) {
      return this.memoryAppKv.get(`${scope}::${appId}::${key}`)?.value ?? null;
    }
    const row = this.db
      .prepare('SELECT value FROM mini_app_kv_cache WHERE scope = ? AND app_id = ? AND key = ?')
      .get(scope, appId, key);
    return row ? String(row.value) : null;
  }

  setMiniAppKv(scope: string, appId: string, key: string, valueJson: string): void {
    const now = Date.now();
    if (!this.db) {
      this.memoryAppKv.set(`${scope}::${appId}::${key}`, { value: valueJson, updatedAt: now });
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO mini_app_kv_cache (scope, app_id, key, value, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope, app_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(scope, appId, key, valueJson, now);
    });
  }

  deleteMiniAppKv(scope: string, appId: string, key: string): void {
    if (!this.db) {
      this.memoryAppKv.delete(`${scope}::${appId}::${key}`);
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('DELETE FROM mini_app_kv_cache WHERE scope = ? AND app_id = ? AND key = ?')
        .run(scope, appId, key);
    });
  }

  listMiniAppKvKeys(scope: string, appId: string): string[] {
    if (!this.db) {
      const prefix = `${scope}::${appId}::`;
      return [...this.memoryAppKv.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
    }
    const rows = this.db
      .prepare('SELECT key FROM mini_app_kv_cache WHERE scope = ? AND app_id = ? ORDER BY key ASC')
      .all(scope, appId);
    return rows.map((r) => String(r.key));
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
