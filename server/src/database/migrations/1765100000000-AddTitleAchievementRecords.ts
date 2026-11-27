import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新增 punch_title_achievements 幂等成就记录表，
 * 支撑全部可重复称号的累计达成次数统计与 6 进制（满 5 进 1：星 → 月亮 → 太阳 → 皇冠）升阶展示。
 */
export class AddTitleAchievementRecords1765100000000 implements MigrationInterface {
  name = 'AddTitleAchievementRecords1765100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS punch_title_achievements (
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        achieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (team_id, user_id, title_id, occurrence_key)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_punch_title_achievements_team_user
        ON punch_title_achievements (team_id, user_id);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_punch_title_achievements_team_user;`);
    await queryRunner.query(`DROP TABLE IF EXISTS punch_title_achievements;`);
  }
}
