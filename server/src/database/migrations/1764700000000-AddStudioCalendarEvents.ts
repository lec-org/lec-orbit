import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 新增工作室全员共享日程表（studio_calendar_events）。 */
export class AddStudioCalendarEvents1764700000000 implements MigrationInterface {
  name = 'AddStudioCalendarEvents1764700000000';

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
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS studio_calendar_events;`);
  }
}
