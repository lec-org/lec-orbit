import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDutySchedule1764800000000 implements MigrationInterface {
  name = 'AddDutySchedule1764800000000';

  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE IF NOT EXISTS orbit_duty_schedule (
      id smallint PRIMARY KEY CHECK (id = 1), anchor date NOT NULL, groups_json jsonb NOT NULL
    )`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query('DROP TABLE IF EXISTS orbit_duty_schedule');
  }
}
