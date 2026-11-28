import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 成员称号成就达成幂等记录表：
 * 以 (team_id, user_id, title_id, occurrence_key) 作为复合主键，
 * 通过 INSERT ... ON CONFLICT DO NOTHING 保证多并发评估绝对幂等、零跨列覆写，
 * 支撑全量 24 项可重复称号的「解锁 → 星 → 月亮 → 太阳 → 皇冠」累计升阶体系。
 */
@Entity({ name: 'punch_title_achievements' })
@Index('idx_punch_title_achievements_team_user', ['teamId', 'userId'])
export class PunchTitleAchievementEntity {
  @PrimaryColumn({ name: 'team_id', type: 'text' })
  teamId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @PrimaryColumn({ name: 'title_id', type: 'text' })
  titleId: string;

  /** 单次达成的幂等去重键（如 week:2026-09-07、month:2026-09、streak:2026-09-10、lose-streak:1789...）。 */
  @PrimaryColumn({ name: 'occurrence_key', type: 'text' })
  occurrenceKey: string;

  @Column({ name: 'achieved_at', type: 'timestamptz' })
  achievedAt: Date;
}
