import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 合并新增工作室共享日程表（studio_calendar_events，含参与人/年级邀请与 RSVP 状态）
 * 以及成员公开忙闲快照表（member_busy_snapshots）。
 * 时间戳使用 1764900000000，避开 PR #11 已占用的 1764700000000。
 */
export class AddStudioCalendarAndFreeBusy1764900000000 implements MigrationInterface {
  name = 'AddStudioCalendarAndFreeBusy1764900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS studio_calendar_events (
        id UUID PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        all_day BOOLEAN NOT NULL DEFAULT FALSE,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        start_time TEXT NOT NULL DEFAULT '09:00',
        end_time TEXT NOT NULL DEFAULT '10:00',
        reminder_minutes INT DEFAULT 15,
        attendee_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        attendee_grades JSONB NOT NULL DEFAULT '[]'::jsonb,
        attendee_responses JSONB NOT NULL DEFAULT '{}'::jsonb,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL DEFAULT '',
        creator_avatar TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_studio_calendar_events_date
        ON studio_calendar_events (start_date, end_date)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_studio_calendar_events_deleted_at
        ON studio_calendar_events (deleted_at);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS member_busy_snapshots (
        user_id TEXT PRIMARY KEY,
        schedule_json JSONB NULL,
        personal_events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS member_busy_snapshots;`);
    await queryRunner.query(`DROP TABLE IF EXISTS studio_calendar_events;`);
  }
}
