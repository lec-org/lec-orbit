/** LecPunch 业务领域契约（独立维护强类型，与旧 LecPunch 仓库锁文件解耦）。 */

export interface PunchUser {
  id: string;
  username?: string;
  displayName?: string;
  name?: string;
  avatar?: string;
  role?: string;
  isAdmin?: boolean;
  teamName?: string;
}

export interface AttendanceSnapshot {
  isCheckedIn: boolean;
  checkedInAt?: string | null;
  activeSessionId?: string | null;
  todayDurationSeconds: number;
  currentSessionSeconds?: number;
  weekDurationSeconds?: number;
  weekTargetSeconds?: number;
}

export interface NetworkPolicyStatus {
  allowed: boolean;
  clientIp?: string;
  reason?: string;
  policyMode?: string;
  ipAllowed?: boolean;
  wifiFingerprintEnabled?: boolean;
  wifiAllowed?: boolean;
  matchedCount?: number;
  requiredMatchCount?: number;
  configuredAnchorCount?: number;
  scanError?: string;
}

export interface WifiAnchorItem {
  bssid: string;
  ssid?: string;
  sampleRssi?: number;
}

export interface WifiFingerprintConfig {
  teamId: string;
  enabled: boolean;
  anchors: WifiAnchorItem[];
  minMatchCount: number;
  minRssi: number;
  updatedAt: string | null;
}

export interface UpdateWifiFingerprintInput {
  enabled: boolean;
  anchors: WifiAnchorItem[];
  minMatchCount?: number;
  minRssi?: number;
  merge?: boolean;
}

export type TitleCategory = 'honor' | 'routine' | 'fun' | 'debuff';

export type TitleIconKey =
  | 'crown'
  | 'calendar-check'
  | 'trophy'
  | 'moon'
  | 'sunrise'
  | 'zap'
  | 'crosshair'
  | 'flame'
  | 'egg'
  | 'swords'
  | 'hourglass';

export type TitleThemeKey =
  | 'amber'
  | 'emerald'
  | 'gold'
  | 'indigo'
  | 'sun'
  | 'violet'
  | 'cyan'
  | 'crimson'
  | 'purple'
  | 'rose'
  | 'alert';

export interface MemberTitleBadge {
  id: string;
  name: string;
  description: string;
  proposer: string;
  category: TitleCategory;
  forced: boolean;
  icon: TitleIconKey;
  theme: TitleThemeKey;
}

export interface TitleEvaluationItem extends MemberTitleBadge {
  unlocked: boolean;
  equipped: boolean;
  progressText?: string;
}

export interface MyTitlesView {
  weekKey: string;
  equippedTitleId: string | null;
  displayTitles: MemberTitleBadge[];
  catalog: TitleEvaluationItem[];
}

export interface TeamActiveMember {
  userId: string;
  displayName: string;
  realName?: string;
  nickname?: string;
  avatar?: string;
  teamName?: string;
  checkedInAt: string;
  durationSeconds?: number;
  titles?: MemberTitleBadge[];
}

export interface AttendanceRecordItem {
  id: string;
  date?: string;
  checkInTime: string;
  checkOutTime?: string | null;
  durationSeconds: number;
  status?: string;
  note?: string;
}

export interface WeeklyStatPoint {
  date: string;
  durationSeconds: number;
}

export interface MyWeeklyStats {
  week?: string;
  totalDurationSeconds: number;
  targetDurationSeconds?: number;
  qualified?: boolean;
  daily?: WeeklyStatPoint[];
}

export interface TeamWeeklyRankingItem {
  userId: string;
  displayName: string;
  realName?: string;
  nickname?: string;
  avatar?: string;
  teamName?: string;
  totalDurationSeconds: number;
  qualified?: boolean;
  rank?: number;
  titles?: MemberTitleBadge[];
}

export interface PointsSummary {
  totalPoints: number;
  weekPoints?: number;
  cardsCount?: number;
}

export interface PunchNotificationItem {
  id: string;
  title: string;
  body: string;
  type?: string;
  status?: 'unread' | 'read' | 'acknowledged';
  createdAt: string;
}

export interface TeamEventItem {
  id: string;
  title: string;
  description?: string;
  startTime?: string;
  location?: string;
  status?: string;
}

export interface WeeklyReportItem {
  week: string;
  content: string;
  updatedAt?: string;
  submittedAt?: string;
}

export type CardRarity = 'N' | 'R' | 'SR' | 'SSR';

export interface CardCollectionItem {
  id: string;
  rarity: CardRarity;
  unlocked: boolean;
  quantity: number;
  name?: string;
  type?: string;
  stat?: string;
  summary?: string;
  effect?: string;
  detail?: string;
  targetMode?: 'none' | 'self-or-other' | 'other' | 'two' | 'recipient';
  targetScope?: 'same-grade' | 'assessment';
  usable?: boolean;
}

export interface CardGamePlayer {
  id: string;
  username: string;
  displayName: string;
  enrollYear: number;
}

export interface CardGameEvent {
  id: string;
  at: string;
  message: string;
}

export interface CardEffectPlayer {
  id: string;
  username: string;
  displayName: string;
}

export interface CardActionEffect {
  target: CardEffectPlayer;
  actualTarget?: CardEffectPlayer;
  randomTarget?: boolean;
  source?: { user: CardEffectPlayer; card: { id: string; name: string; rarity: CardRarity } };
  outcome: 'applied' | 'blocked' | 'reflected' | 'no-effect';
  kind: 'time' | 'cards' | 'status' | 'judgement';
  deltaSeconds?: number;
  detail?: string;
}

export interface CardGiftNotice {
  id: string;
  at: string;
  sender: CardEffectPlayer;
  card: { id: string; name: string; rarity: CardRarity };
}

export interface CardDefenseNotice {
  id: string;
  at: string;
  randomlySelected?: boolean;
  events: {
    attacker: CardEffectPlayer;
    attackCard: { id: string; name: string; rarity: CardRarity };
    defenseCard: { id: string; name: string; rarity: CardRarity };
    outcome: 'blocked' | 'reflected';
  }[];
  effects?: CardActionEffect[];
}

export interface CardInteractionNotice {
  id: string;
  at: string;
  sender: CardEffectPlayer;
  randomlySelected?: boolean;
  card: { id: string; name: string; rarity: CardRarity };
  effects: CardActionEffect[];
}

export interface CardGameView {
  entertainmentSeconds: number;
  capacityLimited?: boolean;
  week: string;
  points: {
    earned: number;
    bonus: number;
    spent: number;
    balance: number;
    rule?: 'comprehensive-v1';
    comprehensiveSeconds?: number;
  };
  freeRemaining: number;
  giftDraws: number;
  pity: { sinceSR: number; sinceSSR: number; srRemaining: number; ssrRemaining: number };
  collection: CardCollectionItem[];
  players: CardGamePlayer[];
  requiredEnrollYears?: number[];
  statuses: {
    acceleration: boolean;
    immuneUntil: string | null;
    lockedUntil: string | null;
    starvedUntil: string | null;
  };
  events: CardGameEvent[];
  incomingGifts?: CardGiftNotice[];
  incomingDefenses?: CardDefenseNotice[];
  incomingInteractions?: CardInteractionNotice[];
}

export interface CardGameActionInput {
  requestKey: string;
  action: 'draw' | 'use' | 'gift';
  count?: 1 | 10;
  cardId?: string;
  targetId?: string;
  secondTargetId?: string;
}

export interface CardGameActionResult {
  message: string;
  action?: 'draw' | 'use' | 'gift';
  actionCard?: { id: string; name: string; rarity: CardRarity };
  effects?: CardActionEffect[];
  gainedCardId?: string;
  gainedCardIds?: string[];
  drawAnimation?: 'blue' | 'purple' | 'gold' | 'radiance';
  ssrPity?: boolean;
  drawCount?: 10;
  radianceCount?: number;
}

export interface CardGameActionResponse {
  result: CardGameActionResult;
  state: CardGameView;
}

/** 计算当前 ISO 周标识（如 2026-W47），与 LecPunch 考核周口径保持一致。 */
export function getCurrentIsoWeek(date: Date = new Date()): string {
  const thursday = new Date(date.valueOf());
  thursday.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getDay() + 6) % 7)) /
        7,
    );
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 将秒数格式化为等宽计时文本 HH:MM:SS。 */
export function formatClockDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 将秒数格式化为中文易读时长，如「3 小时 25 分」。 */
export function formatReadableDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

/**
 * 统一成员展示名称：LecPunch 的 displayName 往往是成员自定义昵称，realName 为真实姓名。
 * - 若同时存在真名与不同的昵称，展示「真名（昵称）」；
 * - 否则优先展示真名，缺失时回退昵称或用户名。
 */
export function formatMemberDisplayName(member: {
  realName?: unknown;
  displayName?: unknown;
  username?: unknown;
}): string {
  const realName = typeof member.realName === 'string' ? member.realName.trim() : '';
  const nickname = typeof member.displayName === 'string' ? member.displayName.trim() : '';
  const username = typeof member.username === 'string' ? member.username.trim() : '';

  if (realName) {
    if (nickname && nickname !== realName) {
      return `${realName}（${nickname}）`;
    }
    return realName;
  }
  return nickname || username || '工作室成员';
}
