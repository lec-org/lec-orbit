import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** LecPunch 团队主表（对应原 MongoDB teams 集合）。 */
@Entity({ name: 'punch_teams' })
export class PunchTeamEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'name', type: 'text' })
  name: string;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status: 'active' | 'inactive';

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** LecPunch 成员主表（对应原 MongoDB users 集合，通过 logto_user_id 与 Orbit ssoSub 强关联）。 */
@Entity({ name: 'punch_users' })
@Index('idx_punch_users_team_role', ['teamId', 'role'])
export class PunchUserEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index({ unique: true, where: 'logto_user_id IS NOT NULL' })
  @Column({ name: 'logto_user_id', type: 'text', nullable: true })
  logtoUserId: string | null;

  @Index({ unique: true })
  @Column({ name: 'username', type: 'text' })
  username: string;

  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash: string | null;

  @Column({ name: 'display_name', type: 'text' })
  displayName: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'role', type: 'text', default: 'member' })
  role: 'member' | 'admin';

  @Column({ name: 'status', type: 'text', default: 'active' })
  status: 'active' | 'disabled';

  @Column({ name: 'enroll_year', type: 'int' })
  enrollYear: number;

  @Index({ unique: true, where: 'student_id IS NOT NULL' })
  @Column({ name: 'student_id', type: 'text', nullable: true })
  studentId: string | null;

  @Column({ name: 'real_name', type: 'text', nullable: true })
  realName: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl: string | null;

  @Column({ name: 'admin_message_badge_enabled', type: 'boolean', default: true })
  adminMessageBadgeEnabled: boolean;

  @Column({ name: 'avatar_base64', type: 'text', nullable: true })
  avatarBase64: string | null;

  @Column({ name: 'avatar_color', type: 'text', nullable: true })
  avatarColor: string | null;

  @Column({ name: 'avatar_emoji', type: 'text', nullable: true })
  avatarEmoji: string | null;

  @Column({ name: 'equipped_title_id', type: 'text', nullable: true })
  equippedTitleId: string | null;

  /** 已永久解锁的长期称号 ID 列表（如赌王、戒赌、贡献王、自古枪兵幸运e、收集系列）。 */
  @Column({ name: 'persistent_title_ids', type: 'jsonb', default: () => "'[]'::jsonb" })
  persistentTitleIds: string[];

  /** 成员主动关闭展示的称号 ID 列表（默认空，即所有可关闭称号默认打开）。 */
  @Column({ name: 'hidden_title_ids', type: 'jsonb', default: () => "'[]'::jsonb" })
  hiddenTitleIds: string[];

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

export interface WifiAnchorEntry {
  bssid: string;
  ssid?: string;
  sampleRssi?: number;
}

/** 考勤网络策略与工作室 Wi-Fi 指纹表（对应原 MongoDB network_policies 集合）。 */
@Entity({ name: 'punch_network_policies' })
export class PunchNetworkPolicyEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index({ unique: true })
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'allow_any_network', type: 'boolean', default: true })
  allowAnyNetwork: boolean;

  @Column({ name: 'allowed_public_ips', type: 'jsonb', default: () => "'[]'::jsonb" })
  allowedPublicIps: string[];

  @Column({ name: 'allowed_cidrs', type: 'jsonb', default: () => "'[]'::jsonb" })
  allowedCidrs: string[];

  @Column({ name: 'trust_proxy', type: 'boolean', default: false })
  trustProxy: boolean;

  @Column({ name: 'trusted_proxy_hops', type: 'int', default: 1 })
  trustedProxyHops: number;

  @Column({ name: 'wifi_fingerprint_enabled', type: 'boolean', default: false })
  wifiFingerprintEnabled: boolean;

  @Column({ name: 'wifi_anchors', type: 'jsonb', default: () => "'[]'::jsonb" })
  wifiAnchors: WifiAnchorEntry[];

  @Column({ name: 'wifi_min_match_count', type: 'int', default: 2 })
  wifiMinMatchCount: number;

  @Column({ name: 'wifi_min_rssi', type: 'int', default: -82 })
  wifiMinRssi: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 成员准入白名单表（对应原 MongoDB member_eligibilities 集合）。 */
@Entity({ name: 'punch_member_eligibilities' })
@Index('idx_punch_elig_team_student', ['teamId', 'studentId'], { unique: true })
export class PunchMemberEligibilityEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'student_id', type: 'text' })
  studentId: string;

  @Column({ name: 'real_name', type: 'text' })
  realName: string;

  @Column({ name: 'status', type: 'text', default: 'allowed' })
  status: 'allowed' | 'blocked';

  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
