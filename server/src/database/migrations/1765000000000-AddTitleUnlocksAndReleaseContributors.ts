import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 为成员表增加长期称号持久化与显隐控制字段，
 * 并新增 orbit_release_contributors 表以支撑「贡献王」称号的定时 GitHub Release/PR 统计。
 */
export class AddTitleUnlocksAndReleaseContributors1765000000000 implements MigrationInterface {
  name = 'AddTitleUnlocksAndReleaseContributors1765000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE punch_users
        ADD COLUMN IF NOT EXISTS persistent_title_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS hidden_title_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS orbit_release_contributors (
        tag_name TEXT PRIMARY KEY,
        repo TEXT NOT NULL DEFAULT 'lec-org/lec-orbit',
        published_at TIMESTAMPTZ NOT NULL,
        contributor_logins JSONB NOT NULL DEFAULT '[]'::jsonb,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_orbit_release_contributors_published
        ON orbit_release_contributors (published_at DESC);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_orbit_release_contributors_published;`);
    await queryRunner.query(`DROP TABLE IF EXISTS orbit_release_contributors;`);
    await queryRunner.query(`
      ALTER TABLE punch_users
        DROP COLUMN IF EXISTS hidden_title_ids,
        DROP COLUMN IF EXISTS persistent_title_ids;
    `);
  }
}
