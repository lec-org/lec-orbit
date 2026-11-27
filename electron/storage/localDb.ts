/**
 * L3 结构化缓存与本地数据层：借鉴 Cherry Studio / AFFiNE 模式，
 * 使用 Node/Electron 内置 node:sqlite（WAL 模式 + PRAGMA user_version 迁移 + withWriteTx 同步事务），
 * 零 C++ 原生编译依赖，避免跨平台 electron-rebuild 陷阱。
 */
import crypto from 'node:crypto';
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
import {
  COURSE_COLOR_PALETTE,
  DEFAULT_TIMETABLE_ID,
  DEFAULT_TIMETABLE_NAME,
  SWPU_CHENGDU_DEFAULT_SLOTS,
  formatLocalDate,
  formatWeeksCompact,
  getStartOfWeekLocal,
  type ApplySwpuImportInput,
  type CreateScheduleInput,
  type OrbitSharePackage,
  type SaveTimetableInput,
  type ScheduleCourse,
  type ScheduleCourseWithMeetings,
  type ScheduleDetail,
  type ScheduleMeeting,
  type ScheduleSummary,
  type ScheduleTimetable,
  type TimetableSlot,
  type UpdateScheduleInput,
  type UpsertCourseInput,
} from '../../src/shared/schedule';
import {
  CALENDAR_COLOR_PALETTE,
  DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID,
  DEFAULT_PERSONAL_CALENDAR_ID,
  DEFAULT_STUDIO_CALENDAR_ID,
  type CalendarCategory,
  type CalendarEvent,
  type CalendarSnapshot,
  type CalendarSubscription,
  type CalendarSubscriptionItem,
  type CalendarTask,
  type SaveCalendarCategoryInput,
  type SaveCalendarSubscriptionInput,
  type UpsertCalendarEventInput,
  type UpsertCalendarTaskInput,
} from '../../src/shared/calendar';
import type { ParsedCalendarEntry } from '../../src/shared/icsParser';

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
  private readonly memoryTimetables = new Map<string, ScheduleTimetable>();
  private readonly memorySchedules = new Map<string, ScheduleSummary>();
  private readonly memoryCourses = new Map<string, ScheduleCourse>();
  private readonly memoryMeetings = new Map<string, ScheduleMeeting>();
  private readonly memoryCalCategories = new Map<string, CalendarCategory>();
  private readonly memoryCalEvents = new Map<string, CalendarEvent>();
  private readonly memoryCalTasks = new Map<string, CalendarTask>();
  private readonly memoryCalSubscriptions = new Map<string, CalendarSubscription>();
  private readonly memoryCalSubItems = new Map<string, CalendarSubscriptionItem>();

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

    if (version < 3) {
      this.withWriteTx(() => {
        this.db!.exec(`
          CREATE TABLE IF NOT EXISTS schedule_timetables (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            fixed_duration_enabled INTEGER NOT NULL DEFAULT 1,
            default_duration_minutes INTEGER NOT NULL DEFAULT 45,
            slots_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE TABLE IF NOT EXISTS schedules (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            term_code TEXT NOT NULL DEFAULT '',
            timetable_id TEXT NOT NULL,
            start_date TEXT NOT NULL,
            week_start_day INTEGER NOT NULL DEFAULT 1,
            total_weeks INTEGER NOT NULL DEFAULT 20,
            max_sections INTEGER NOT NULL DEFAULT 12,
            compact_mode INTEGER NOT NULL DEFAULT 0,
            reminder_enabled INTEGER NOT NULL DEFAULT 1,
            reminder_minutes INTEGER NOT NULL DEFAULT 15,
            holidays_json TEXT NOT NULL DEFAULT '[]',
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE INDEX IF NOT EXISTS idx_schedules_scope
            ON schedules (scope, is_active DESC, updated_at DESC);
          CREATE TABLE IF NOT EXISTS schedule_courses (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            schedule_id TEXT NOT NULL,
            name TEXT NOT NULL,
            course_code TEXT NOT NULL DEFAULT '',
            credit REAL,
            category TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE INDEX IF NOT EXISTS idx_schedule_courses_sched
            ON schedule_courses (scope, schedule_id);
          CREATE TABLE IF NOT EXISTS schedule_meetings (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            schedule_id TEXT NOT NULL,
            course_id TEXT NOT NULL,
            teacher TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            campus TEXT NOT NULL DEFAULT '',
            day_of_week INTEGER NOT NULL,
            start_section INTEGER NOT NULL,
            end_section INTEGER NOT NULL,
            start_time_override TEXT,
            end_time_override TEXT,
            weeks_json TEXT NOT NULL,
            weeks_text TEXT NOT NULL DEFAULT '',
            is_adjusted INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'manual',
            PRIMARY KEY (scope, id)
          );
          CREATE INDEX IF NOT EXISTS idx_schedule_meetings_sched
            ON schedule_meetings (scope, schedule_id);
          CREATE INDEX IF NOT EXISTS idx_schedule_meetings_course
            ON schedule_meetings (scope, course_id);
          PRAGMA user_version = 3;
        `);
      });
    }

    if (version < 4) {
      this.withWriteTx(() => {
        this.db!.exec(`
          CREATE TABLE IF NOT EXISTS calendar_categories (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            visible INTEGER NOT NULL DEFAULT 1,
            is_builtin INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE TABLE IF NOT EXISTS calendar_events (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            calendar_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            all_day INTEGER NOT NULL DEFAULT 0,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            start_time TEXT NOT NULL DEFAULT '09:00',
            end_time TEXT NOT NULL DEFAULT '10:00',
            reminder_minutes INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE INDEX IF NOT EXISTS idx_calendar_events_scope_date
            ON calendar_events (scope, start_date, end_date);
          CREATE TABLE IF NOT EXISTS calendar_tasks (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            due_date TEXT,
            due_time TEXT,
            priority TEXT NOT NULL DEFAULT 'medium',
            completed INTEGER NOT NULL DEFAULT 0,
            completed_at INTEGER,
            reminder_minutes INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE INDEX IF NOT EXISTS idx_calendar_tasks_scope_due
            ON calendar_tasks (scope, completed, due_date);
          PRAGMA user_version = 4;
        `);
      });
    }

    if (version < 5) {
      this.withWriteTx(() => {
        this.db!.exec(`
          CREATE TABLE IF NOT EXISTS calendar_subscriptions (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'ics-url',
            url TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL,
            visible INTEGER NOT NULL DEFAULT 1,
            is_builtin INTEGER NOT NULL DEFAULT 0,
            last_synced_at INTEGER,
            last_error TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, id)
          );
          CREATE TABLE IF NOT EXISTS calendar_subscription_items (
            scope TEXT NOT NULL,
            id TEXT NOT NULL,
            subscription_id TEXT NOT NULL,
            uid TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            all_day INTEGER NOT NULL DEFAULT 1,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            start_time TEXT NOT NULL DEFAULT '00:00',
            end_time TEXT NOT NULL DEFAULT '23:59',
            badge TEXT,
            PRIMARY KEY (scope, id)
          );
          CREATE INDEX IF NOT EXISTS idx_calendar_sub_items_sub
            ON calendar_subscription_items (scope, subscription_id, start_date);
          PRAGMA user_version = 5;
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

  // ─────────────────────────────────────────────────────────────────────────
  // 课程表模块（LocalDB v3：时间表、多课表、聚合课程、排课时间段）
  // ─────────────────────────────────────────────────────────────────────────

  private makeDefaultTimetable(): ScheduleTimetable {
    return {
      id: DEFAULT_TIMETABLE_ID,
      name: DEFAULT_TIMETABLE_NAME,
      fixedDurationEnabled: true,
      defaultDurationMinutes: 45,
      slots: SWPU_CHENGDU_DEFAULT_SLOTS.map((s) => ({ ...s })),
      updatedAt: Date.now(),
    };
  }

  ensureDefaultTimetable(scope: string): ScheduleTimetable {
    const existing = this.getTimetable(scope, DEFAULT_TIMETABLE_ID);
    if (existing) return existing;
    const def = this.makeDefaultTimetable();
    return this.saveTimetable(scope, {
      id: def.id,
      name: def.name,
      fixedDurationEnabled: def.fixedDurationEnabled,
      defaultDurationMinutes: def.defaultDurationMinutes,
      slots: def.slots,
    });
  }

  private mapTimetableRow(row: Record<string, unknown>): ScheduleTimetable {
    let slots: TimetableSlot[] = SWPU_CHENGDU_DEFAULT_SLOTS.map((s) => ({ ...s }));
    try {
      const parsed = JSON.parse(String(row.slots_json || '[]')) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        slots = parsed as TimetableSlot[];
      }
    } catch {
      // 回退默认作息
    }
    return {
      id: String(row.id),
      name: String(row.name),
      fixedDurationEnabled: Boolean(row.fixed_duration_enabled),
      defaultDurationMinutes: Number(row.default_duration_minutes || 45),
      slots,
      updatedAt: Number(row.updated_at || 0),
    };
  }

  getTimetable(scope: string, id: string): ScheduleTimetable | null {
    if (!this.db) {
      return this.memoryTimetables.get(`${scope}::${id}`) ?? null;
    }
    const row = this.db
      .prepare(
        `SELECT id, name, fixed_duration_enabled, default_duration_minutes, slots_json, updated_at
         FROM schedule_timetables WHERE scope = ? AND id = ?`,
      )
      .get(scope, id);
    return row ? this.mapTimetableRow(row) : null;
  }

  listTimetables(scope: string): ScheduleTimetable[] {
    this.ensureDefaultTimetable(scope);
    if (!this.db) {
      return [...this.memoryTimetables.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v)
        .sort((a, b) => a.updatedAt - b.updatedAt);
    }
    const rows = this.db
      .prepare(
        `SELECT id, name, fixed_duration_enabled, default_duration_minutes, slots_json, updated_at
         FROM schedule_timetables WHERE scope = ? ORDER BY updated_at ASC`,
      )
      .all(scope);
    return rows.map((r) => this.mapTimetableRow(r));
  }

  saveTimetable(scope: string, input: SaveTimetableInput): ScheduleTimetable {
    const id = input.id?.trim() || `tt_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const record: ScheduleTimetable = {
      id,
      name: input.name.trim(),
      fixedDurationEnabled: input.fixedDurationEnabled ?? true,
      defaultDurationMinutes: input.defaultDurationMinutes ?? 45,
      slots: [...input.slots].sort((a, b) => a.section - b.section),
      updatedAt: now,
    };
    if (!this.db) {
      this.memoryTimetables.set(`${scope}::${id}`, record);
      return record;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO schedule_timetables
             (scope, id, name, fixed_duration_enabled, default_duration_minutes, slots_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, id) DO UPDATE SET
             name = excluded.name,
             fixed_duration_enabled = excluded.fixed_duration_enabled,
             default_duration_minutes = excluded.default_duration_minutes,
             slots_json = excluded.slots_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          record.id,
          record.name,
          record.fixedDurationEnabled ? 1 : 0,
          record.defaultDurationMinutes,
          JSON.stringify(record.slots),
          record.updatedAt,
        );
    });
    return record;
  }

  private mapScheduleRow(
    row: Record<string, unknown>,
    courseCount: number,
    meetingCount: number,
  ): ScheduleSummary {
    let holidays: string[] = [];
    try {
      const parsed = JSON.parse(String(row.holidays_json || '[]')) as unknown;
      if (Array.isArray(parsed)) {
        holidays = parsed.filter((d): d is string => typeof d === 'string');
      }
    } catch {
      holidays = [];
    }
    const rawStartDay = Number(row.week_start_day || 1);
    return {
      id: String(row.id),
      name: String(row.name),
      termCode: String(row.term_code || ''),
      timetableId: String(row.timetable_id || DEFAULT_TIMETABLE_ID),
      startDate: String(row.start_date),
      weekStartDay: rawStartDay === 7 ? 7 : 1,
      totalWeeks: Number(row.total_weeks || 20),
      maxSections: Number(row.max_sections || 12),
      compactMode: Boolean(row.compact_mode),
      reminderEnabled: Boolean(row.reminder_enabled),
      reminderMinutes: Number(row.reminder_minutes || 15),
      holidays,
      isActive: Boolean(row.is_active),
      courseCount,
      meetingCount,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  listSchedules(scope: string): ScheduleSummary[] {
    this.ensureDefaultTimetable(scope);
    if (!this.db) {
      return [...this.memorySchedules.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, s]) => {
          const courseCount = [...this.memoryCourses.entries()].filter(
            ([ck, c]) => ck.startsWith(`${scope}::`) && c.scheduleId === s.id,
          ).length;
          const meetingCount = [...this.memoryMeetings.entries()].filter(
            ([mk, m]) => mk.startsWith(`${scope}::`) && m.scheduleId === s.id,
          ).length;
          return { ...s, courseCount, meetingCount };
        })
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.updatedAt - a.updatedAt);
    }

    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(1) FROM schedule_courses c WHERE c.scope = s.scope AND c.schedule_id = s.id) AS course_count,
          (SELECT COUNT(1) FROM schedule_meetings m WHERE m.scope = s.scope AND m.schedule_id = s.id) AS meeting_count
         FROM schedules s
         WHERE s.scope = ?
         ORDER BY s.is_active DESC, s.updated_at DESC`,
      )
      .all(scope);
    return rows.map((r) =>
      this.mapScheduleRow(r, Number(r.course_count || 0), Number(r.meeting_count || 0)),
    );
  }

  createSchedule(scope: string, input: CreateScheduleInput): ScheduleSummary {
    const defTt = this.ensureDefaultTimetable(scope);
    const id = `sched_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const startDate = input.startDate || formatLocalDate(getStartOfWeekLocal(new Date(), input.weekStartDay ?? 1));
    const timetableId = input.timetableId?.trim() || defTt.id;
    const setActive = input.setActive ?? true;

    const record: ScheduleSummary = {
      id,
      name: input.name.trim(),
      termCode: input.termCode ?? '',
      timetableId,
      startDate,
      weekStartDay: input.weekStartDay ?? 1,
      totalWeeks: input.totalWeeks ?? 20,
      maxSections: input.maxSections ?? 12,
      compactMode: false,
      reminderEnabled: true,
      reminderMinutes: 15,
      holidays: input.holidays ?? [],
      isActive: setActive,
      courseCount: 0,
      meetingCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (!this.db) {
      if (setActive) {
        for (const [k, s] of this.memorySchedules.entries()) {
          if (k.startsWith(`${scope}::`) && s.isActive) {
            this.memorySchedules.set(k, { ...s, isActive: false });
          }
        }
      }
      this.memorySchedules.set(`${scope}::${id}`, record);
      return record;
    }

    this.withWriteTx(() => {
      if (setActive) {
        this.db!.prepare('UPDATE schedules SET is_active = 0 WHERE scope = ?').run(scope);
      }
      this.db!
        .prepare(
          `INSERT INTO schedules
            (scope, id, name, term_code, timetable_id, start_date, week_start_day, total_weeks,
             max_sections, compact_mode, reminder_enabled, reminder_minutes, holidays_json,
             is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 15, ?, ?, ?, ?)`,
        )
        .run(
          scope,
          record.id,
          record.name,
          record.termCode,
          record.timetableId,
          record.startDate,
          record.weekStartDay,
          record.totalWeeks,
          record.maxSections,
          JSON.stringify(record.holidays),
          setActive ? 1 : 0,
          now,
          now,
        );
    });
    return record;
  }

  updateSchedule(scope: string, input: UpdateScheduleInput): ScheduleSummary | null {
    const list = this.listSchedules(scope);
    const current = list.find((s) => s.id === input.id);
    if (!current) return null;
    const now = Date.now();
    const next: ScheduleSummary = {
      ...current,
      name: input.name !== undefined ? input.name.trim() : current.name,
      termCode: input.termCode !== undefined ? input.termCode : current.termCode,
      timetableId: input.timetableId !== undefined ? input.timetableId : current.timetableId,
      startDate: input.startDate !== undefined ? input.startDate : current.startDate,
      weekStartDay: input.weekStartDay !== undefined ? input.weekStartDay : current.weekStartDay,
      totalWeeks: input.totalWeeks !== undefined ? input.totalWeeks : current.totalWeeks,
      maxSections: input.maxSections !== undefined ? input.maxSections : current.maxSections,
      compactMode: input.compactMode !== undefined ? input.compactMode : current.compactMode,
      reminderEnabled: input.reminderEnabled !== undefined ? input.reminderEnabled : current.reminderEnabled,
      reminderMinutes: input.reminderMinutes !== undefined ? input.reminderMinutes : current.reminderMinutes,
      holidays: input.holidays !== undefined ? input.holidays : current.holidays,
      updatedAt: now,
    };

    if (!this.db) {
      this.memorySchedules.set(`${scope}::${next.id}`, next);
      return next;
    }

    this.withWriteTx(() => {
      this.db!
        .prepare(
          `UPDATE schedules SET
             name = ?, term_code = ?, timetable_id = ?, start_date = ?, week_start_day = ?,
             total_weeks = ?, max_sections = ?, compact_mode = ?, reminder_enabled = ?,
             reminder_minutes = ?, holidays_json = ?, updated_at = ?
           WHERE scope = ? AND id = ?`,
        )
        .run(
          next.name,
          next.termCode,
          next.timetableId,
          next.startDate,
          next.weekStartDay,
          next.totalWeeks,
          next.maxSections,
          next.compactMode ? 1 : 0,
          next.reminderEnabled ? 1 : 0,
          next.reminderMinutes,
          JSON.stringify(next.holidays),
          now,
          scope,
          next.id,
        );
    });
    return next;
  }

  setActiveSchedule(scope: string, scheduleId: string): boolean {
    const list = this.listSchedules(scope);
    if (!list.some((s) => s.id === scheduleId)) return false;
    const now = Date.now();
    if (!this.db) {
      for (const [k, s] of this.memorySchedules.entries()) {
        if (k.startsWith(`${scope}::`)) {
          this.memorySchedules.set(k, {
            ...s,
            isActive: s.id === scheduleId,
            updatedAt: s.id === scheduleId ? now : s.updatedAt,
          });
        }
      }
      return true;
    }
    this.withWriteTx(() => {
      this.db!.prepare('UPDATE schedules SET is_active = 0 WHERE scope = ?').run(scope);
      this.db!
        .prepare('UPDATE schedules SET is_active = 1, updated_at = ? WHERE scope = ? AND id = ?')
        .run(now, scope, scheduleId);
    });
    return true;
  }

  deleteSchedule(scope: string, scheduleId: string): void {
    if (!this.db) {
      this.memorySchedules.delete(`${scope}::${scheduleId}`);
      for (const [k, c] of [...this.memoryCourses.entries()]) {
        if (k.startsWith(`${scope}::`) && c.scheduleId === scheduleId) this.memoryCourses.delete(k);
      }
      for (const [k, m] of [...this.memoryMeetings.entries()]) {
        if (k.startsWith(`${scope}::`) && m.scheduleId === scheduleId) this.memoryMeetings.delete(k);
      }
      const rest = this.listSchedules(scope);
      if (rest.length > 0 && !rest.some((s) => s.isActive)) {
        this.setActiveSchedule(scope, rest[0]!.id);
      }
      return;
    }
    this.withWriteTx(() => {
      this.db!.prepare('DELETE FROM schedule_meetings WHERE scope = ? AND schedule_id = ?').run(scope, scheduleId);
      this.db!.prepare('DELETE FROM schedule_courses WHERE scope = ? AND schedule_id = ?').run(scope, scheduleId);
      this.db!.prepare('DELETE FROM schedules WHERE scope = ? AND id = ?').run(scope, scheduleId);
      const active = this.db!
        .prepare('SELECT id FROM schedules WHERE scope = ? AND is_active = 1 LIMIT 1')
        .get(scope);
      if (!active) {
        const first = this.db!
          .prepare('SELECT id FROM schedules WHERE scope = ? ORDER BY updated_at DESC LIMIT 1')
          .get(scope);
        if (first?.id) {
          this.db!
            .prepare('UPDATE schedules SET is_active = 1 WHERE scope = ? AND id = ?')
            .run(scope, String(first.id));
        }
      }
    });
  }

  clearScheduleCourses(scope: string, scheduleId: string): void {
    const now = Date.now();
    if (!this.db) {
      for (const [k, c] of [...this.memoryCourses.entries()]) {
        if (k.startsWith(`${scope}::`) && c.scheduleId === scheduleId) this.memoryCourses.delete(k);
      }
      for (const [k, m] of [...this.memoryMeetings.entries()]) {
        if (k.startsWith(`${scope}::`) && m.scheduleId === scheduleId) this.memoryMeetings.delete(k);
      }
      const sched = this.memorySchedules.get(`${scope}::${scheduleId}`);
      if (sched) this.memorySchedules.set(`${scope}::${scheduleId}`, { ...sched, updatedAt: now });
      return;
    }
    this.withWriteTx(() => {
      this.db!.prepare('DELETE FROM schedule_meetings WHERE scope = ? AND schedule_id = ?').run(scope, scheduleId);
      this.db!.prepare('DELETE FROM schedule_courses WHERE scope = ? AND schedule_id = ?').run(scope, scheduleId);
      this.db!.prepare('UPDATE schedules SET updated_at = ? WHERE scope = ? AND id = ?').run(now, scope, scheduleId);
    });
  }

  getScheduleDetail(scope: string, scheduleId?: string): ScheduleDetail | null {
    const list = this.listSchedules(scope);
    if (list.length === 0) return null;
    const target =
      (scheduleId ? list.find((s) => s.id === scheduleId) : list.find((s) => s.isActive)) ?? list[0]!;
    const timetable =
      this.getTimetable(scope, target.timetableId) ?? this.ensureDefaultTimetable(scope);

    let coursesRaw: ScheduleCourse[];
    let meetingsRaw: ScheduleMeeting[];

    if (!this.db) {
      coursesRaw = [...this.memoryCourses.entries()]
        .filter(([k, c]) => k.startsWith(`${scope}::`) && c.scheduleId === target.id)
        .map(([, c]) => c)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      meetingsRaw = [...this.memoryMeetings.entries()]
        .filter(([k, m]) => k.startsWith(`${scope}::`) && m.scheduleId === target.id)
        .map(([, m]) => m)
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startSection - b.startSection);
    } else {
      coursesRaw = this.db
        .prepare(
          `SELECT id, schedule_id, name, course_code, credit, category, color, note, updated_at
           FROM schedule_courses WHERE scope = ? AND schedule_id = ? ORDER BY name ASC`,
        )
        .all(scope, target.id)
        .map((r) => ({
          id: String(r.id),
          scheduleId: String(r.schedule_id),
          name: String(r.name),
          courseCode: String(r.course_code || ''),
          credit: r.credit != null ? Number(r.credit) : null,
          category: String(r.category || ''),
          color: String(r.color || COURSE_COLOR_PALETTE[0]),
          note: String(r.note || ''),
          updatedAt: Number(r.updated_at || 0),
        }));

      meetingsRaw = this.db
        .prepare(
          `SELECT id, schedule_id, course_id, teacher, location, campus, day_of_week,
                  start_section, end_section, start_time_override, end_time_override,
                  weeks_json, weeks_text, is_adjusted, source
           FROM schedule_meetings WHERE scope = ? AND schedule_id = ?
           ORDER BY day_of_week ASC, start_section ASC`,
        )
        .all(scope, target.id)
        .map((r) => {
          let weeks: number[] = [];
          try {
            const parsed = JSON.parse(String(r.weeks_json || '[]')) as unknown;
            if (Array.isArray(parsed)) {
              weeks = parsed.map(Number).filter((w) => Number.isInteger(w) && w >= 1);
            }
          } catch {
            weeks = [];
          }
          return {
            id: String(r.id),
            scheduleId: String(r.schedule_id),
            courseId: String(r.course_id),
            teacher: String(r.teacher || ''),
            location: String(r.location || ''),
            campus: String(r.campus || ''),
            dayOfWeek: Number(r.day_of_week),
            startSection: Number(r.start_section),
            endSection: Number(r.end_section),
            startTimeOverride: r.start_time_override ? String(r.start_time_override) : undefined,
            endTimeOverride: r.end_time_override ? String(r.end_time_override) : undefined,
            weeks,
            weeksText: String(r.weeks_text || formatWeeksCompact(weeks)),
            isAdjusted: Boolean(r.is_adjusted),
            source: (String(r.source || 'manual') as ScheduleMeeting['source']),
          };
        });
    }

    const meetingsByCourse = new Map<string, ScheduleMeeting[]>();
    for (const m of meetingsRaw) {
      const bucket = meetingsByCourse.get(m.courseId) ?? [];
      bucket.push(m);
      meetingsByCourse.set(m.courseId, bucket);
    }

    const courses: ScheduleCourseWithMeetings[] = coursesRaw.map((c) => ({
      ...c,
      meetings: meetingsByCourse.get(c.id) ?? [],
    }));

    return {
      schedule: {
        ...target,
        courseCount: courses.length,
        meetingCount: meetingsRaw.length,
      },
      timetable,
      courses,
    };
  }

  upsertCourseWithMeetings(scope: string, input: UpsertCourseInput): ScheduleCourseWithMeetings {
    const now = Date.now();
    const courseId = input.courseId?.trim() || `crs_${crypto.randomUUID().slice(0, 12)}`;
    const color =
      input.color?.trim() ||
      COURSE_COLOR_PALETTE[Math.floor(Math.random() * COURSE_COLOR_PALETTE.length)]!;

    const course: ScheduleCourse = {
      id: courseId,
      scheduleId: input.scheduleId,
      name: input.name.trim(),
      courseCode: input.courseCode ?? '',
      credit: input.credit ?? null,
      category: input.category ?? '',
      color,
      note: input.note ?? '',
      updatedAt: now,
    };

    const meetings: ScheduleMeeting[] = input.meetings.map((m) => {
      const sortedWeeks = [...new Set(m.weeks)].sort((a, b) => a - b);
      return {
        id: m.id?.trim() || `mtg_${crypto.randomUUID().slice(0, 12)}`,
        scheduleId: input.scheduleId,
        courseId,
        teacher: m.teacher ?? '',
        location: m.location ?? '',
        campus: m.campus ?? '',
        dayOfWeek: m.dayOfWeek,
        startSection: m.startSection,
        endSection: m.endSection,
        startTimeOverride: m.startTimeOverride,
        endTimeOverride: m.endTimeOverride,
        weeks: sortedWeeks,
        weeksText: m.weeksText?.trim() || formatWeeksCompact(sortedWeeks),
        isAdjusted: Boolean(m.isAdjusted),
        source: m.source ?? 'manual',
      };
    });

    if (!this.db) {
      this.memoryCourses.set(`${scope}::${courseId}`, course);
      for (const [k, existing] of [...this.memoryMeetings.entries()]) {
        if (k.startsWith(`${scope}::`) && existing.courseId === courseId) {
          this.memoryMeetings.delete(k);
        }
      }
      for (const mtg of meetings) {
        this.memoryMeetings.set(`${scope}::${mtg.id}`, mtg);
      }
      return { ...course, meetings };
    }

    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO schedule_courses
             (scope, id, schedule_id, name, course_code, credit, category, color, note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, id) DO UPDATE SET
             name = excluded.name,
             course_code = excluded.course_code,
             credit = excluded.credit,
             category = excluded.category,
             color = excluded.color,
             note = excluded.note,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          course.id,
          course.scheduleId,
          course.name,
          course.courseCode,
          course.credit,
          course.category,
          course.color,
          course.note,
          now,
        );
      this.db!.prepare('DELETE FROM schedule_meetings WHERE scope = ? AND course_id = ?').run(scope, courseId);
      const insertMeeting = this.db!.prepare(
        `INSERT INTO schedule_meetings
          (scope, id, schedule_id, course_id, teacher, location, campus, day_of_week,
           start_section, end_section, start_time_override, end_time_override,
           weeks_json, weeks_text, is_adjusted, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const mtg of meetings) {
        insertMeeting.run(
          scope,
          mtg.id,
          mtg.scheduleId,
          mtg.courseId,
          mtg.teacher,
          mtg.location,
          mtg.campus,
          mtg.dayOfWeek,
          mtg.startSection,
          mtg.endSection,
          mtg.startTimeOverride ?? null,
          mtg.endTimeOverride ?? null,
          JSON.stringify(mtg.weeks),
          mtg.weeksText,
          mtg.isAdjusted ? 1 : 0,
          mtg.source,
        );
      }
      this.db!
        .prepare('UPDATE schedules SET updated_at = ? WHERE scope = ? AND id = ?')
        .run(now, scope, input.scheduleId);
    });

    return { ...course, meetings };
  }

  deleteCourses(scope: string, scheduleId: string, courseIds: string[]): void {
    const cleanIds = [...new Set(courseIds.filter(Boolean))];
    if (cleanIds.length === 0) return;
    const now = Date.now();
    if (!this.db) {
      const idSet = new Set(cleanIds);
      for (const id of cleanIds) this.memoryCourses.delete(`${scope}::${id}`);
      for (const [k, m] of [...this.memoryMeetings.entries()]) {
        if (k.startsWith(`${scope}::`) && idSet.has(m.courseId)) this.memoryMeetings.delete(k);
      }
      return;
    }
    this.withWriteTx(() => {
      const delMtg = this.db!.prepare(
        'DELETE FROM schedule_meetings WHERE scope = ? AND schedule_id = ? AND course_id = ?',
      );
      const delCrs = this.db!.prepare(
        'DELETE FROM schedule_courses WHERE scope = ? AND schedule_id = ? AND id = ?',
      );
      for (const cid of cleanIds) {
        delMtg.run(scope, scheduleId, cid);
        delCrs.run(scope, scheduleId, cid);
      }
      this.db!.prepare('UPDATE schedules SET updated_at = ? WHERE scope = ? AND id = ?').run(now, scope, scheduleId);
    });
  }

  /** 原子化落地西柚教务导入结果（支持新建课表或覆盖已有课表） */
  applySwpuImport(scope: string, input: ApplySwpuImportInput): ScheduleDetail {
    const defTt = this.ensureDefaultTimetable(scope);
    const maxSec = Math.max(
      12,
      ...input.courses.flatMap((c) => c.meetings.map((m) => m.endSection)),
    );

    let scheduleId: string;
    if (input.mode === 'replace' && input.targetScheduleId) {
      const updated = this.updateSchedule(scope, {
        id: input.targetScheduleId,
        name: input.scheduleName,
        termCode: input.termCode,
        startDate: input.startDate,
        totalWeeks: input.totalWeeks,
        maxSections: maxSec,
        holidays: input.holidays,
      });
      if (updated) {
        scheduleId = updated.id;
        this.clearScheduleCourses(scope, scheduleId);
        this.setActiveSchedule(scope, scheduleId);
      } else {
        const created = this.createSchedule(scope, {
          name: input.scheduleName,
          termCode: input.termCode,
          timetableId: defTt.id,
          startDate: input.startDate,
          weekStartDay: 1,
          totalWeeks: input.totalWeeks,
          maxSections: maxSec,
          holidays: input.holidays,
          setActive: true,
        });
        scheduleId = created.id;
      }
    } else {
      const created = this.createSchedule(scope, {
        name: input.scheduleName,
        termCode: input.termCode,
        timetableId: defTt.id,
        startDate: input.startDate,
        weekStartDay: 1,
        totalWeeks: input.totalWeeks,
        maxSections: maxSec,
        holidays: input.holidays,
        setActive: true,
      });
      scheduleId = created.id;
    }

    for (const course of input.courses) {
      this.upsertCourseWithMeetings(scope, {
        scheduleId,
        name: course.name,
        courseCode: course.courseCode,
        credit: course.credit,
        category: course.category,
        color: course.color,
        note: course.note,
        meetings: course.meetings,
      });
    }

    return this.getScheduleDetail(scope, scheduleId)!;
  }

  /** 导入来自好友的 Orbit 课表分享包 */
  importSharePackage(scope: string, pkg: OrbitSharePackage): ScheduleDetail {
    const tt = this.saveTimetable(scope, {
      name: `${pkg.timetable.name}（分享）`,
      fixedDurationEnabled: pkg.timetable.fixedDurationEnabled,
      defaultDurationMinutes: pkg.timetable.defaultDurationMinutes,
      slots: pkg.timetable.slots,
    });
    const created = this.createSchedule(scope, {
      name: pkg.schedule.name,
      termCode: pkg.schedule.termCode,
      timetableId: tt.id,
      startDate: pkg.schedule.startDate,
      weekStartDay: pkg.schedule.weekStartDay,
      totalWeeks: pkg.schedule.totalWeeks,
      maxSections: pkg.schedule.maxSections,
      holidays: pkg.schedule.holidays,
      setActive: true,
    });
    for (const course of pkg.courses) {
      this.upsertCourseWithMeetings(scope, {
        scheduleId: created.id,
        name: course.name,
        courseCode: course.courseCode,
        credit: course.credit,
        category: course.category,
        color: course.color,
        note: course.note,
        meetings: course.meetings,
      });
    }
    return this.getScheduleDetail(scope, created.id)!;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 统一日历模块（LocalDB v4：自定义日历分组、日程事件、待办任务）
  // ─────────────────────────────────────────────────────────────────────────

  ensureDefaultCalendarCategories(scope: string): void {
    const existing = this.listCalendarCategoriesRaw(scope);
    const hasPersonal = existing.some((c) => c.id === DEFAULT_PERSONAL_CALENDAR_ID);
    const hasStudio = existing.some((c) => c.id === DEFAULT_STUDIO_CALENDAR_ID);
    const now = Date.now();
    if (!hasPersonal) {
      this.upsertCalendarCategoryInternal(scope, {
        id: DEFAULT_PERSONAL_CALENDAR_ID,
        name: '个人日程',
        color: CALENDAR_COLOR_PALETTE[0],
        visible: true,
        isBuiltin: true,
        sortOrder: 0,
        updatedAt: now,
      });
    }
    if (!hasStudio) {
      this.upsertCalendarCategoryInternal(scope, {
        id: DEFAULT_STUDIO_CALENDAR_ID,
        name: '工作室',
        color: CALENDAR_COLOR_PALETTE[1],
        visible: true,
        isBuiltin: true,
        sortOrder: 1,
        updatedAt: now,
      });
    }
  }

  private upsertCalendarCategoryInternal(scope: string, cat: CalendarCategory): CalendarCategory {
    if (!this.db) {
      this.memoryCalCategories.set(`${scope}::${cat.id}`, cat);
      return cat;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO calendar_categories
             (scope, id, name, color, visible, is_builtin, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, id) DO UPDATE SET
             name = excluded.name,
             color = excluded.color,
             visible = excluded.visible,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          cat.id,
          cat.name,
          cat.color,
          cat.visible ? 1 : 0,
          cat.isBuiltin ? 1 : 0,
          cat.sortOrder,
          cat.updatedAt,
        );
    });
    return cat;
  }

  private listCalendarCategoriesRaw(scope: string): CalendarCategory[] {
    if (!this.db) {
      return [...this.memoryCalCategories.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
    }
    const rows = this.db
      .prepare(
        `SELECT id, name, color, visible, is_builtin, sort_order, updated_at
         FROM calendar_categories WHERE scope = ?
         ORDER BY sort_order ASC, updated_at ASC`,
      )
      .all(scope);
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      color: String(r.color || CALENDAR_COLOR_PALETTE[0]),
      visible: Boolean(r.visible),
      isBuiltin: Boolean(r.is_builtin),
      sortOrder: Number(r.sort_order || 0),
      updatedAt: Number(r.updated_at || 0),
    }));
  }

  listCalendarCategories(scope: string): CalendarCategory[] {
    this.ensureDefaultCalendarCategories(scope);
    return this.listCalendarCategoriesRaw(scope);
  }

  saveCalendarCategory(scope: string, input: SaveCalendarCategoryInput): CalendarCategory {
    this.ensureDefaultCalendarCategories(scope);
    const list = this.listCalendarCategoriesRaw(scope);
    const existing = input.id ? list.find((c) => c.id === input.id) : undefined;
    const now = Date.now();
    const record: CalendarCategory = {
      id: existing?.id ?? input.id?.trim() ?? `cal_${crypto.randomUUID().slice(0, 10)}`,
      name: input.name.trim(),
      color: input.color ?? existing?.color ?? CALENDAR_COLOR_PALETTE[list.length % CALENDAR_COLOR_PALETTE.length]!,
      visible: input.visible ?? existing?.visible ?? true,
      isBuiltin: existing?.isBuiltin ?? false,
      sortOrder: existing?.sortOrder ?? list.length,
      updatedAt: now,
    };
    return this.upsertCalendarCategoryInternal(scope, record);
  }

  setCalendarCategoryVisible(scope: string, categoryId: string, visible: boolean): void {
    const now = Date.now();
    if (!this.db) {
      const hit = this.memoryCalCategories.get(`${scope}::${categoryId}`);
      if (hit) this.memoryCalCategories.set(`${scope}::${categoryId}`, { ...hit, visible, updatedAt: now });
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('UPDATE calendar_categories SET visible = ?, updated_at = ? WHERE scope = ? AND id = ?')
        .run(visible ? 1 : 0, now, scope, categoryId);
    });
  }

  deleteCalendarCategory(scope: string, categoryId: string): void {
    if (categoryId === DEFAULT_PERSONAL_CALENDAR_ID) return;
    if (!this.db) {
      this.memoryCalCategories.delete(`${scope}::${categoryId}`);
      for (const [k, ev] of [...this.memoryCalEvents.entries()]) {
        if (k.startsWith(`${scope}::`) && ev.calendarId === categoryId) {
          this.memoryCalEvents.set(k, { ...ev, calendarId: DEFAULT_PERSONAL_CALENDAR_ID });
        }
      }
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('UPDATE calendar_events SET calendar_id = ? WHERE scope = ? AND calendar_id = ?')
        .run(DEFAULT_PERSONAL_CALENDAR_ID, scope, categoryId);
      this.db!
        .prepare('DELETE FROM calendar_categories WHERE scope = ? AND id = ? AND is_builtin = 0')
        .run(scope, categoryId);
    });
  }

  listCalendarEvents(scope: string): CalendarEvent[] {
    if (!this.db) {
      return [...this.memoryCalEvents.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v)
        .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.startTime.localeCompare(b.startTime));
    }
    const rows = this.db
      .prepare(
        `SELECT id, calendar_id, title, description, location, all_day,
                start_date, end_date, start_time, end_time, reminder_minutes, created_at, updated_at
         FROM calendar_events WHERE scope = ?
         ORDER BY start_date ASC, all_day DESC, start_time ASC`,
      )
      .all(scope);
    return rows.map((r) => ({
      id: String(r.id),
      calendarId: String(r.calendar_id || DEFAULT_PERSONAL_CALENDAR_ID),
      title: String(r.title),
      description: String(r.description || ''),
      location: String(r.location || ''),
      allDay: Boolean(r.all_day),
      startDate: String(r.start_date),
      endDate: String(r.end_date || r.start_date),
      startTime: String(r.start_time || '09:00'),
      endTime: String(r.end_time || '10:00'),
      reminderMinutes: r.reminder_minutes != null ? Number(r.reminder_minutes) : null,
      createdAt: Number(r.created_at || 0),
      updatedAt: Number(r.updated_at || 0),
    }));
  }

  upsertCalendarEvent(scope: string, input: UpsertCalendarEventInput): CalendarEvent {
    this.ensureDefaultCalendarCategories(scope);
    const now = Date.now();
    const id = input.id?.trim() || `evt_${crypto.randomUUID().slice(0, 12)}`;
    const existing = this.listCalendarEvents(scope).find((e) => e.id === id);
    const endDate = input.endDate && input.endDate >= input.startDate ? input.endDate : input.startDate;
    const record: CalendarEvent = {
      id,
      calendarId: input.calendarId ?? DEFAULT_PERSONAL_CALENDAR_ID,
      title: input.title.trim(),
      description: input.description ?? '',
      location: input.location ?? '',
      allDay: input.allDay ?? false,
      startDate: input.startDate,
      endDate,
      startTime: input.startTime ?? '09:00',
      endTime: input.endTime ?? '10:00',
      reminderMinutes: input.reminderMinutes === undefined ? 15 : input.reminderMinutes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (!this.db) {
      this.memoryCalEvents.set(`${scope}::${id}`, record);
      return record;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO calendar_events
             (scope, id, calendar_id, title, description, location, all_day,
              start_date, end_date, start_time, end_time, reminder_minutes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, id) DO UPDATE SET
             calendar_id = excluded.calendar_id,
             title = excluded.title,
             description = excluded.description,
             location = excluded.location,
             all_day = excluded.all_day,
             start_date = excluded.start_date,
             end_date = excluded.end_date,
             start_time = excluded.start_time,
             end_time = excluded.end_time,
             reminder_minutes = excluded.reminder_minutes,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          record.id,
          record.calendarId,
          record.title,
          record.description,
          record.location,
          record.allDay ? 1 : 0,
          record.startDate,
          record.endDate,
          record.startTime,
          record.endTime,
          record.reminderMinutes,
          record.createdAt,
          record.updatedAt,
        );
    });
    return record;
  }

  deleteCalendarEvent(scope: string, eventId: string): void {
    if (!this.db) {
      this.memoryCalEvents.delete(`${scope}::${eventId}`);
      return;
    }
    this.withWriteTx(() => {
      this.db!.prepare('DELETE FROM calendar_events WHERE scope = ? AND id = ?').run(scope, eventId);
    });
  }

  listCalendarTasks(scope: string): CalendarTask[] {
    if (!this.db) {
      return [...this.memoryCalTasks.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v)
        .sort(
          (a, b) =>
            Number(a.completed) - Number(b.completed) ||
            (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99') ||
            (a.dueTime || '99:99').localeCompare(b.dueTime || '99:99'),
        );
    }
    const rows = this.db
      .prepare(
        `SELECT id, title, description, due_date, due_time, priority, completed, completed_at,
                reminder_minutes, created_at, updated_at
         FROM calendar_tasks WHERE scope = ?
         ORDER BY completed ASC, COALESCE(due_date, '9999-99-99') ASC, COALESCE(due_time, '99:99') ASC, created_at DESC`,
      )
      .all(scope);
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      description: String(r.description || ''),
      dueDate: r.due_date ? String(r.due_date) : null,
      dueTime: r.due_time ? String(r.due_time) : null,
      priority: (String(r.priority || 'medium') as CalendarTask['priority']),
      completed: Boolean(r.completed),
      completedAt: r.completed_at != null ? Number(r.completed_at) : null,
      reminderMinutes: r.reminder_minutes != null ? Number(r.reminder_minutes) : null,
      createdAt: Number(r.created_at || 0),
      updatedAt: Number(r.updated_at || 0),
    }));
  }

  upsertCalendarTask(scope: string, input: UpsertCalendarTaskInput): CalendarTask {
    const now = Date.now();
    const id = input.id?.trim() || `tsk_${crypto.randomUUID().slice(0, 12)}`;
    const existing = this.listCalendarTasks(scope).find((t) => t.id === id);
    const completed = input.completed ?? existing?.completed ?? false;
    const record: CalendarTask = {
      id,
      title: input.title.trim(),
      description: input.description ?? existing?.description ?? '',
      dueDate: input.dueDate === undefined ? (existing?.dueDate ?? null) : input.dueDate,
      dueTime: input.dueTime === undefined ? (existing?.dueTime ?? null) : input.dueTime,
      priority: input.priority ?? existing?.priority ?? 'medium',
      completed,
      completedAt: completed ? (existing?.completedAt ?? now) : null,
      reminderMinutes: input.reminderMinutes === undefined ? 15 : input.reminderMinutes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (!this.db) {
      this.memoryCalTasks.set(`${scope}::${id}`, record);
      return record;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO calendar_tasks
             (scope, id, title, description, due_date, due_time, priority,
              completed, completed_at, reminder_minutes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             due_date = excluded.due_date,
             due_time = excluded.due_time,
             priority = excluded.priority,
             completed = excluded.completed,
             completed_at = excluded.completed_at,
             reminder_minutes = excluded.reminder_minutes,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          record.id,
          record.title,
          record.description,
          record.dueDate,
          record.dueTime,
          record.priority,
          record.completed ? 1 : 0,
          record.completedAt,
          record.reminderMinutes,
          record.createdAt,
          record.updatedAt,
        );
    });
    return record;
  }

  toggleCalendarTask(scope: string, taskId: string, completed: boolean): CalendarTask | null {
    const existing = this.listCalendarTasks(scope).find((t) => t.id === taskId);
    if (!existing) return null;
    return this.upsertCalendarTask(scope, {
      id: existing.id,
      title: existing.title,
      description: existing.description,
      dueDate: existing.dueDate,
      dueTime: existing.dueTime,
      priority: existing.priority,
      completed,
      reminderMinutes: existing.reminderMinutes,
    });
  }

  deleteCalendarTask(scope: string, taskId: string): void {
    if (!this.db) {
      this.memoryCalTasks.delete(`${scope}::${taskId}`);
      return;
    }
    this.withWriteTx(() => {
      this.db!.prepare('DELETE FROM calendar_tasks WHERE scope = ? AND id = ?').run(scope, taskId);
    });
  }

  // ── 订阅日历（默认内置「中国法定节假日与调休」+ 外部 .ics / webcal 订阅） ──

  private ensureDefaultCalendarSubscriptions(scope: string): void {
    const existing = this.listCalendarSubscriptionsRaw(scope);
    const hasCnHoliday = existing.some((s) => s.id === DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID);
    if (!hasCnHoliday) {
      const now = Date.now();
      this.upsertCalendarSubscriptionInternal(scope, {
        id: DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID,
        name: '中国法定节假日与调休',
        kind: 'cn-holiday',
        url: 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/',
        color: '#F59E0B',
        visible: true,
        isBuiltin: true,
        lastSyncedAt: null,
        lastError: null,
        sortOrder: 0,
        updatedAt: now,
      });
    }
  }

  private upsertCalendarSubscriptionInternal(
    scope: string,
    sub: CalendarSubscription,
  ): CalendarSubscription {
    if (!this.db) {
      this.memoryCalSubscriptions.set(`${scope}::${sub.id}`, sub);
      return sub;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare(
          `INSERT INTO calendar_subscriptions
             (scope, id, name, kind, url, color, visible, is_builtin,
              last_synced_at, last_error, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, id) DO UPDATE SET
             name = excluded.name,
             url = excluded.url,
             color = excluded.color,
             visible = excluded.visible,
             last_synced_at = excluded.last_synced_at,
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          sub.id,
          sub.name,
          sub.kind,
          sub.url,
          sub.color,
          sub.visible ? 1 : 0,
          sub.isBuiltin ? 1 : 0,
          sub.lastSyncedAt,
          sub.lastError,
          sub.sortOrder,
          sub.updatedAt,
        );
    });
    return sub;
  }

  private listCalendarSubscriptionsRaw(scope: string): CalendarSubscription[] {
    if (!this.db) {
      return [...this.memoryCalSubscriptions.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
    }
    const rows = this.db
      .prepare(
        `SELECT id, name, kind, url, color, visible, is_builtin,
                last_synced_at, last_error, sort_order, updated_at
         FROM calendar_subscriptions WHERE scope = ?
         ORDER BY sort_order ASC, updated_at ASC`,
      )
      .all(scope);
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: (String(r.kind || 'ics-url') as CalendarSubscription['kind']),
      url: String(r.url || ''),
      color: String(r.color || '#F59E0B'),
      visible: Boolean(r.visible),
      isBuiltin: Boolean(r.is_builtin),
      lastSyncedAt: r.last_synced_at != null ? Number(r.last_synced_at) : null,
      lastError: r.last_error != null ? String(r.last_error) : null,
      sortOrder: Number(r.sort_order || 0),
      updatedAt: Number(r.updated_at || 0),
    }));
  }

  listCalendarSubscriptions(scope: string): CalendarSubscription[] {
    this.ensureDefaultCalendarSubscriptions(scope);
    return this.listCalendarSubscriptionsRaw(scope);
  }

  listCalendarSubscriptionItems(scope: string): CalendarSubscriptionItem[] {
    if (!this.db) {
      return [...this.memoryCalSubItems.entries()]
        .filter(([k]) => k.startsWith(`${scope}::`))
        .map(([, v]) => v)
        .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.startTime.localeCompare(b.startTime));
    }
    const rows = this.db
      .prepare(
        `SELECT id, subscription_id, uid, title, description, location, all_day,
                start_date, end_date, start_time, end_time, badge
         FROM calendar_subscription_items WHERE scope = ?
         ORDER BY start_date ASC, all_day DESC, start_time ASC`,
      )
      .all(scope);
    return rows.map((r) => ({
      id: String(r.id),
      subscriptionId: String(r.subscription_id),
      uid: String(r.uid),
      title: String(r.title),
      description: String(r.description || ''),
      location: String(r.location || ''),
      allDay: Boolean(r.all_day),
      startDate: String(r.start_date),
      endDate: String(r.end_date || r.start_date),
      startTime: String(r.start_time || '00:00'),
      endTime: String(r.end_time || '23:59'),
      badge: r.badge === 'off' || r.badge === 'work' ? r.badge : null,
    }));
  }

  saveCalendarSubscription(
    scope: string,
    input: SaveCalendarSubscriptionInput,
  ): CalendarSubscription {
    this.ensureDefaultCalendarSubscriptions(scope);
    const list = this.listCalendarSubscriptionsRaw(scope);
    const existing = input.id ? list.find((s) => s.id === input.id) : undefined;
    const now = Date.now();
    const record: CalendarSubscription = {
      id: existing?.id ?? input.id?.trim() ?? `sub_${crypto.randomUUID().slice(0, 10)}`,
      name: input.name.trim(),
      kind: existing?.kind ?? 'ics-url',
      url: existing?.kind === 'cn-holiday' ? existing.url : input.url.trim(),
      color: input.color ?? existing?.color ?? CALENDAR_COLOR_PALETTE[3],
      visible: input.visible ?? existing?.visible ?? true,
      isBuiltin: existing?.isBuiltin ?? false,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastError: existing?.lastError ?? null,
      sortOrder: existing?.sortOrder ?? list.length,
      updatedAt: now,
    };
    return this.upsertCalendarSubscriptionInternal(scope, record);
  }

  setCalendarSubscriptionVisible(scope: string, subscriptionId: string, visible: boolean): void {
    const now = Date.now();
    if (!this.db) {
      const hit = this.memoryCalSubscriptions.get(`${scope}::${subscriptionId}`);
      if (hit) {
        this.memoryCalSubscriptions.set(`${scope}::${subscriptionId}`, {
          ...hit,
          visible,
          updatedAt: now,
        });
      }
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('UPDATE calendar_subscriptions SET visible = ?, updated_at = ? WHERE scope = ? AND id = ?')
        .run(visible ? 1 : 0, now, scope, subscriptionId);
    });
  }

  replaceCalendarSubscriptionItems(
    scope: string,
    subscriptionId: string,
    entries: ParsedCalendarEntry[],
    meta: { syncedAt: number | null; error: string | null },
  ): void {
    const now = Date.now();
    const items: CalendarSubscriptionItem[] = entries.map((e, idx) => ({
      id: `${subscriptionId}::${idx}_${crypto.createHash('sha1').update(`${e.uid}|${e.startDate}|${e.title}`).digest('hex').slice(0, 10)}`,
      subscriptionId,
      uid: e.uid,
      title: e.title,
      description: e.description,
      location: e.location,
      allDay: e.allDay,
      startDate: e.startDate,
      endDate: e.endDate,
      startTime: e.startTime,
      endTime: e.endTime,
      badge: e.badge,
    }));

    if (!this.db) {
      for (const [k, v] of [...this.memoryCalSubItems.entries()]) {
        if (k.startsWith(`${scope}::`) && v.subscriptionId === subscriptionId) {
          this.memoryCalSubItems.delete(k);
        }
      }
      for (const item of items) {
        this.memoryCalSubItems.set(`${scope}::${item.id}`, item);
      }
      const sub = this.memoryCalSubscriptions.get(`${scope}::${subscriptionId}`);
      if (sub) {
        this.memoryCalSubscriptions.set(`${scope}::${subscriptionId}`, {
          ...sub,
          lastSyncedAt: meta.syncedAt ?? sub.lastSyncedAt,
          lastError: meta.error,
          updatedAt: now,
        });
      }
      return;
    }

    this.withWriteTx(() => {
      this.db!
        .prepare('DELETE FROM calendar_subscription_items WHERE scope = ? AND subscription_id = ?')
        .run(scope, subscriptionId);
      const insertStmt = this.db!.prepare(
        `INSERT INTO calendar_subscription_items
           (scope, id, subscription_id, uid, title, description, location, all_day,
            start_date, end_date, start_time, end_time, badge)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        insertStmt.run(
          scope,
          item.id,
          item.subscriptionId,
          item.uid,
          item.title,
          item.description,
          item.location,
          item.allDay ? 1 : 0,
          item.startDate,
          item.endDate,
          item.startTime,
          item.endTime,
          item.badge,
        );
      }
      this.db!
        .prepare(
          `UPDATE calendar_subscriptions
           SET last_synced_at = COALESCE(?, last_synced_at), last_error = ?, updated_at = ?
           WHERE scope = ? AND id = ?`,
        )
        .run(meta.syncedAt, meta.error, now, scope, subscriptionId);
    });
  }

  markCalendarSubscriptionError(scope: string, subscriptionId: string, error: string): void {
    const now = Date.now();
    if (!this.db) {
      const sub = this.memoryCalSubscriptions.get(`${scope}::${subscriptionId}`);
      if (sub) {
        this.memoryCalSubscriptions.set(`${scope}::${subscriptionId}`, {
          ...sub,
          lastError: error,
          updatedAt: now,
        });
      }
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('UPDATE calendar_subscriptions SET last_error = ?, updated_at = ? WHERE scope = ? AND id = ?')
        .run(error, now, scope, subscriptionId);
    });
  }

  deleteCalendarSubscription(scope: string, subscriptionId: string): void {
    if (subscriptionId === DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID) return;
    if (!this.db) {
      this.memoryCalSubscriptions.delete(`${scope}::${subscriptionId}`);
      for (const [k, v] of [...this.memoryCalSubItems.entries()]) {
        if (k.startsWith(`${scope}::`) && v.subscriptionId === subscriptionId) {
          this.memoryCalSubItems.delete(k);
        }
      }
      return;
    }
    this.withWriteTx(() => {
      this.db!
        .prepare('DELETE FROM calendar_subscription_items WHERE scope = ? AND subscription_id = ?')
        .run(scope, subscriptionId);
      this.db!
        .prepare('DELETE FROM calendar_subscriptions WHERE scope = ? AND id = ? AND is_builtin = 0')
        .run(scope, subscriptionId);
    });
  }

  /** 将本地 .ics 文件解析出的条目一次性导入为新的本地可编辑日历分组 */
  importEntriesAsCalendarCategory(
    scope: string,
    input: { name: string; color?: string; entries: ParsedCalendarEntry[] },
  ): { category: CalendarCategory; importedCount: number } {
    const category = this.saveCalendarCategory(scope, {
      name: input.name.trim() || '导入日历',
      color: input.color,
      visible: true,
    });
    let importedCount = 0;
    for (const entry of input.entries) {
      this.upsertCalendarEvent(scope, {
        calendarId: category.id,
        title: entry.title,
        description: entry.description,
        location: entry.location,
        allDay: entry.allDay,
        startDate: entry.startDate,
        endDate: entry.endDate,
        startTime: entry.startTime,
        endTime: entry.endTime,
        reminderMinutes: entry.allDay ? null : 15,
      });
      importedCount += 1;
    }
    return { category, importedCount };
  }

  getCalendarSnapshot(scope: string): CalendarSnapshot {
    const categories = this.listCalendarCategories(scope);
    const subscriptions = this.listCalendarSubscriptions(scope);
    return {
      categories,
      events: this.listCalendarEvents(scope),
      tasks: this.listCalendarTasks(scope),
      subscriptions,
      subscriptionItems: this.listCalendarSubscriptionItems(scope),
    };
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
