import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Orbit 每次版本发版（Release）对应的 PR 贡献者快照表，供「贡献王」称号离线评估。 */
@Entity({ name: 'orbit_release_contributors' })
@Index('idx_orbit_release_contributors_published', ['publishedAt'])
export class OrbitReleaseContributorEntity {
  @PrimaryColumn({ name: 'tag_name', type: 'text' })
  tagName: string;

  @Column({ name: 'repo', type: 'text', default: 'lec-org/lec-orbit' })
  repo: string;

  @Column({ name: 'published_at', type: 'timestamptz' })
  publishedAt: Date;

  /** 本次版本更新窗口内合并 PR 的作者 GitHub login 列表（全小写去重）。 */
  @Column({ name: 'contributor_logins', type: 'jsonb', default: () => "'[]'::jsonb" })
  contributorLogins: string[];

  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;
}
