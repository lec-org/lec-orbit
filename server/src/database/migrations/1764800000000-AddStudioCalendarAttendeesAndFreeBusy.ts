import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 为工作室共享日程增加参与人/年级邀请与回复状态字段，
 * 并新增 member_busy_snapshots 表以支撑创建多人日程时的右侧忙闲时间轴。
 */
export class AddStudioCalendarAttendeesAndFreeBusy1764800000000 implements MigrationInterface {
  name = 'AddStudioCalendarAttendeesAndFreeBusy1764800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE studio_calendar_events
        ADD COLUMN IF NOT EXISTS attendee_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS attendee_grades JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS attendee_responses JSONB NOT NULL DEFAULT '{}'::jsonb;
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

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS member_busy_snapshots;`);
    await queryRunner.query(`
      ALTER TABLE studio_calendar_events
        DROP COLUMN IF EXISTS attendee_responses,
        DROP COLUMN IF EXISTS attendee_grades,
        DROP COLUMN IF EXISTS attendee_user_ids;
    `);
  }
}
