/** LEC 工作室考勤与娱乐称号目录（26 个自动判定称号：原 11 个基础称号 + 15 个 Orbit 扩展称号）。 */

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
  | 'hourglass'
  | 'target'
  | 'dices'
  | 'skull'
  | 'ghost'
  | 'git-pull-request'
  | 'clover'
  | 'layers'
  | 'library'
  | 'book-open'
  | 'graduation-cap'
  | 'sparkles'
  | 'timer'
  | 'battery-low'
  | 'alert-triangle';

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
  | 'alert'
  | 'teal'
  | 'slate';

/** 方案 A 升阶进位基数：满 5 颗同级图标后，再达成 1 次（第 6 进阶点）进位到下一阶。 */
export const TITLE_TIER_BASE = 6;

export interface TitleAchievementTier {
  /** 累计达成次数（0=未解锁，1=基础解锁，>=2 开始计星/月/日/冠）。 */
  count: number;
  /** 进阶点数（count >= 1 时为 count - 1，否则为 0）。 */
  points: number;
  /** 皇冠数量（每 216 进阶点 = 满 5 太阳后再达成 1 次进位）。 */
  crowns: number;
  /** 太阳数量（0..5，每 36 进阶点 = 满 5 月亮后再达成 1 次进位）。 */
  suns: number;
  /** 月亮数量（0..5，每 6 进阶点 = 满 5 星后再达成 1 次进位）。 */
  moons: number;
  /** 星星数量（0..5）。 */
  stars: number;
  /** 下一个大阶位名称（一星成就 / 月亮 / 太阳 / 皇冠），一次性成就为 null。 */
  nextMajorTierLabel: string | null;
  /** 达到下一个大阶位所需的累计达成总次数，一次性成就为 null。 */
  nextMajorTierCount: number | null;
}

/**
 * 方案 A 称号成就阶位纯函数（6 进制：满 5 颗同级图标后再达成 1 次进位）：
 * - 第 1 次：基础解锁（0 进阶点）
 * - 第 2–6 次：1–5 星（1–5 进阶点）
 * - 第 7 次（满 5 星后再达成 1 次）：1 月亮（6 进阶点）
 * - 第 37 次（满 5 月亮后再达成 1 次）：1 太阳（36 进阶点）
 * - 第 217 次（满 5 太阳后再达成 1 次）：1 皇冠（216 进阶点）
 */
export function computeTitleAchievementTier(
  count: number,
  stackable = true,
): TitleAchievementTier {
  const safeCount = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (!stackable) {
    return {
      count: Math.min(1, safeCount),
      points: 0,
      crowns: 0,
      suns: 0,
      moons: 0,
      stars: 0,
      nextMajorTierLabel: null,
      nextMajorTierCount: null,
    };
  }
  if (safeCount <= 0) {
    return {
      count: 0,
      points: 0,
      crowns: 0,
      suns: 0,
      moons: 0,
      stars: 0,
      nextMajorTierLabel: '解锁成就',
      nextMajorTierCount: 1,
    };
  }
  const points = safeCount - 1;
  const base = TITLE_TIER_BASE;
  const sunUnit = base * base; // 36
  const crownUnit = sunUnit * base; // 216
  const stars = points % base;
  const moons = Math.floor(points / base) % base;
  const suns = Math.floor(points / sunUnit) % base;
  const crowns = Math.floor(points / crownUnit);

  let nextMajorTierLabel: string;
  let nextMajorTierCount: number;
  if (points < 1) {
    nextMajorTierLabel = '1 星';
    nextMajorTierCount = 2;
  } else if (points < base) {
    nextMajorTierLabel = '1 月亮';
    nextMajorTierCount = base + 1; // 7
  } else if (points < sunUnit) {
    nextMajorTierLabel = '1 太阳';
    nextMajorTierCount = sunUnit + 1; // 37
  } else if (points < crownUnit) {
    nextMajorTierLabel = '1 皇冠';
    nextMajorTierCount = crownUnit + 1; // 217
  } else {
    nextMajorTierLabel = `${crowns + 1} 皇冠`;
    nextMajorTierCount = (crowns + 1) * crownUnit + 1;
  }

  return {
    count: safeCount,
    points,
    crowns,
    suns,
    moons,
    stars,
    nextMajorTierLabel,
    nextMajorTierCount,
  };
}

/** 将成就阶位格式化为可读中文文案（如「1 月亮 3 星」或「已解锁」）。 */
export function formatTitleTierText(tier: TitleAchievementTier): string {
  if (tier.count <= 0) return '未解锁';
  if (tier.points <= 0) return '基础解锁';
  const parts: string[] = [];
  if (tier.crowns > 0) parts.push(`${tier.crowns} 皇冠`);
  if (tier.suns > 0) parts.push(`${tier.suns} 太阳`);
  if (tier.moons > 0) parts.push(`${tier.moons} 月亮`);
  if (tier.stars > 0) parts.push(`${tier.stars} 星`);
  return parts.join(' ');
}

export interface TitleDefinition {
  id: string;
  name: string;
  description: string;
  proposer: string;
  category: TitleCategory;
  /** 为 true 时属于强制状态标签（如上周未达标/危急预警/戒赌/快思了/体力不支），自动亮牌且不占用主荣誉称号槽位。 */
  forced: boolean;
  /** 为 true 时达成后永久持久化保留，不会随周/月切换失效。 */
  persistent?: boolean;
  /** 为 true 时成员可在称号图鉴中手动关闭或重新开启展示（默认打开）。 */
  hideable?: boolean;
  /** 是否支持重复达成累计升阶（默认 true；仅一次性图鉴里程碑为 false）。 */
  stackable: boolean;
  /** 该称号的累计去重规则说明（展示在称号图鉴卡片中）。 */
  stackRuleText: string;
  icon: TitleIconKey;
  theme: TitleThemeKey;
  /** 自动佩戴与展示排序权重（越高越靠前）。 */
  priority: number;
}

export interface MemberTitleBadge {
  id: string;
  name: string;
  description: string;
  proposer: string;
  category: TitleCategory;
  forced: boolean;
  persistent?: boolean;
  hideable?: boolean;
  stackable?: boolean;
  /** 历史累计达成次数（0=未解锁，1=基础解锁，>=2 按方案 A 满 5 进 1 展示星/月/日/冠）。 */
  unlockCount?: number;
  icon: TitleIconKey;
  theme: TitleThemeKey;
}

export interface TitleEvaluationItem extends MemberTitleBadge {
  unlocked: boolean;
  equipped: boolean;
  /** 仅对 hideable 称号生效：为 true 表示成员主动关闭了该称号的亮牌展示。 */
  hidden?: boolean;
  stackRuleText?: string;
  progressText?: string;
}

export const TITLE_CATALOG: TitleDefinition[] = [
  {
    id: 'punch-god',
    name: '神',
    description: '单周纯真实打卡时长超过 50 小时',
    proposer: '李子佳',
    category: 'honor',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'sparkles',
    theme: 'gold',
    priority: 105,
  },
  {
    id: 'punch-star',
    name: '打卡之星',
    description: '连续 3 天成为该年级打卡时长最多的人',
    proposer: '陈信豪',
    category: 'honor',
    forced: false,
    stackable: true,
    stackRuleText: '按不重叠连续 3 天轮次累计（每段 +1）',
    icon: 'crown',
    theme: 'amber',
    priority: 100,
  },
  {
    id: 'mcgrady-time',
    name: 'McGrady Time',
    description: '单周纯真实打卡时长达到 35 小时',
    proposer: '陈昱璋',
    category: 'honor',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'timer',
    theme: 'crimson',
    priority: 98,
  },
  {
    id: 'contributor-king',
    name: '贡献王',
    description: '连续 3 次 Orbit 版本更新都参与并提交合并 PR（长期保留）',
    proposer: '曾权军',
    category: 'honor',
    forced: false,
    persistent: true,
    hideable: true,
    stackable: true,
    stackRuleText: '每达成一轮连续 3 次正式发版 PR +1',
    icon: 'git-pull-request',
    theme: 'emerald',
    priority: 96,
  },
  {
    id: 'monthly-perfect',
    name: '全勤之王',
    description: '当月每天打卡超过 1 小时',
    proposer: '陈信豪',
    category: 'honor',
    forced: false,
    stackable: true,
    stackRuleText: '按自然月累计（每月最多 +1）',
    icon: 'trophy',
    theme: 'gold',
    priority: 95,
  },
  {
    id: 'collection-king',
    name: '收集之王',
    description: '集齐卡牌图鉴中全部种类的卡片（长期保留）',
    proposer: '曾权军',
    category: 'honor',
    forced: false,
    persistent: true,
    hideable: true,
    stackable: false,
    stackRuleText: '一次性图鉴里程碑（不参与升阶）',
    icon: 'library',
    theme: 'gold',
    priority: 94,
  },
  {
    id: 'general-jin',
    name: '金将军',
    description: '当周每天打卡超过 5 小时',
    proposer: '徐绮',
    category: 'honor',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'flame',
    theme: 'crimson',
    priority: 92,
  },
  {
    id: 'legend-allnighter',
    name: '传奇耐通王',
    description: '连续 3 天在 00:00–09:00 期间打卡超过 4 小时',
    proposer: '陈信豪',
    category: 'routine',
    forced: false,
    stackable: true,
    stackRuleText: '按不重叠连续 3 天轮次累计（每段 +1）',
    icon: 'zap',
    theme: 'violet',
    priority: 88,
  },
  {
    id: 'gamble-king',
    name: '赌王',
    description: '连续使用 5 张「我赌你的枪里没有子弹」并全部成功（长期保留）',
    proposer: '钟晨彬',
    category: 'fun',
    forced: false,
    persistent: true,
    hideable: true,
    stackable: true,
    stackRuleText: '每独立达成一轮 5 连胜 +1',
    icon: 'dices',
    theme: 'amber',
    priority: 86,
  },
  {
    id: 'most-honest',
    name: '最老实之人',
    description: '每天上课期间猛猛打卡（结合个人课表判定，未导课表按同年级/校历教学时段兜底）',
    proposer: '林佳政',
    category: 'routine',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'book-open',
    theme: 'teal',
    priority: 84,
  },
  {
    id: 'weekly-perfect',
    name: '全勤之星',
    description: '当周每天打卡超过 1 小时',
    proposer: '陈信豪',
    category: 'honor',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'calendar-check',
    theme: 'emerald',
    priority: 82,
  },
  {
    id: 'good-student',
    name: '三好学生',
    description: '上周有效打卡满 1 小时，且一整周上课期间从不打卡（未导课表按同年级/校历教学时段兜底）',
    proposer: '匡思进',
    category: 'routine',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周结算累计（每周最多 +1）',
    icon: 'graduation-cap',
    theme: 'emerald',
    priority: 80,
  },
  {
    id: 'dragon-king',
    name: '龙王',
    description: '本周获得「吕洞宾」称号后，成功对使其获得称号的人施加负面效果卡',
    proposer: '牛闻举',
    category: 'fun',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'flame',
    theme: 'crimson',
    priority: 78,
  },
  {
    id: 'deadline-master',
    name: '卡点王',
    description: '连续两周综合时长压线达标（目标时长至目标 +1 小时之间）',
    proposer: '陈信豪',
    category: 'fun',
    forced: false,
    stackable: true,
    stackRuleText: '按结算考核周累计（每周最多 +1）',
    icon: 'crosshair',
    theme: 'cyan',
    priority: 76,
  },
  {
    id: 'lu-dongbin',
    name: '吕洞宾',
    description: '本周被你先使用过正面效果卡的其他人，之后反手对你使用了负面效果卡',
    proposer: '孟令宇',
    category: 'fun',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'swords',
    theme: 'rose',
    priority: 74,
  },
  {
    id: 'almost-perfect',
    name: '差一步美满',
    description: '上周考核结算综合时长距本年级目标差不到 1 小时（目标 −1h 至目标之间）',
    proposer: '牛闻举',
    category: 'fun',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周结算累计（每周最多 +1）',
    icon: 'target',
    theme: 'teal',
    priority: 72,
  },
  {
    id: 'lancer-luck-e',
    name: '自古枪兵幸运e',
    description: '抽 SSR 卡触发大保底才出（长期保留）',
    proposer: '曾权军',
    category: 'fun',
    forced: false,
    persistent: true,
    hideable: true,
    stackable: true,
    stackRuleText: '每触发一次 70 抽 SSR 大保底 +1',
    icon: 'clover',
    theme: 'indigo',
    priority: 70,
  },
  {
    id: 'early-bird',
    name: '早起鸟',
    description: '连续 3 天在早上 9 点之前签到打卡',
    proposer: '陈信豪',
    category: 'routine',
    forced: false,
    stackable: true,
    stackRuleText: '按不重叠连续 3 天轮次累计（每段 +1）',
    icon: 'sunrise',
    theme: 'sun',
    priority: 68,
  },
  {
    id: 'night-owl',
    name: '夜猫子',
    description: '连续 3 天在晚上 9 点之后仍在打卡',
    proposer: '陈信豪',
    category: 'routine',
    forced: false,
    stackable: true,
    stackRuleText: '按不重叠连续 3 天轮次累计（每段 +1）',
    icon: 'moon',
    theme: 'indigo',
    priority: 66,
  },
  {
    id: 'card-collector',
    name: '收集者',
    description: '在卡牌图鉴中收集 5 种不同的卡片（长期保留）',
    proposer: '曾权军',
    category: 'honor',
    forced: false,
    persistent: true,
    hideable: true,
    stackable: false,
    stackRuleText: '一次性图鉴里程碑（不参与升阶）',
    icon: 'layers',
    theme: 'cyan',
    priority: 64,
  },
  {
    id: 'uneasy',
    name: '感到不安',
    description: '单周综合打卡时长落后排行榜上一名超过 5 小时',
    proposer: '陈昱璋',
    category: 'fun',
    forced: false,
    stackable: true,
    stackRuleText: '按考核周累计（每周最多 +1）',
    icon: 'alert-triangle',
    theme: 'rose',
    priority: 62,
  },
  {
    id: 'quit-gambling',
    name: '求求你戒赌吧',
    description: '连续使用 5 张「我赌你的枪里没有子弹」且全部失败（永久强制展示，下次赌赢即可解除）',
    proposer: '钟晨彬',
    category: 'debuff',
    forced: true,
    stackable: true,
    stackRuleText: '每独立达成一轮 5 连败 +1（赌赢解除亮牌但保留阶位）',
    icon: 'skull',
    theme: 'slate',
    priority: 52,
  },
  {
    id: 'lovesick',
    name: '相思了',
    description: '本周还需打卡时间 ÷ 本周剩余时间 ≥ 0.3（补满即可解除）',
    proposer: '黄茂',
    category: 'debuff',
    forced: true,
    stackable: true,
    stackRuleText: '按考核周去重累计（每周最多 +1）',
    icon: 'hourglass',
    theme: 'alert',
    priority: 50,
  },
  {
    id: 'almost-gone',
    name: '快思了',
    description: '上周连续一整周没有任何有效打卡记录',
    proposer: '曾权军',
    category: 'debuff',
    forced: true,
    stackable: true,
    stackRuleText: '按考核周结算累计（每周最多 +1）',
    icon: 'ghost',
    theme: 'alert',
    priority: 48,
  },
  {
    id: 'low-stamina',
    name: '体力不支',
    description: '上周有效打卡成员中综合打卡时长最少',
    proposer: '陈昱璋',
    category: 'debuff',
    forced: true,
    stackable: true,
    stackRuleText: '按考核周结算累计（每周最多 +1）',
    icon: 'battery-low',
    theme: 'slate',
    priority: 46,
  },
  {
    id: 'purple-egg',
    name: '想吃紫蛋了',
    description: '上周考核未打满目标时长',
    proposer: '杨东明',
    category: 'debuff',
    forced: true,
    stackable: true,
    stackRuleText: '按考核周结算累计（每周最多 +1）',
    icon: 'egg',
    theme: 'purple',
    priority: 45,
  },
];

export const TITLE_BY_ID = new Map<string, TitleDefinition>(
  TITLE_CATALOG.map((item) => [item.id, item]),
);

/** 将完整称号定义投影为前端亮牌徽章字段（附带可升阶标记与历史累计达成次数）。 */
export function toMemberTitleBadge(def: TitleDefinition, unlockCount?: number): MemberTitleBadge {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    proposer: def.proposer,
    category: def.category,
    forced: def.forced,
    ...(def.persistent ? { persistent: true } : {}),
    ...(def.hideable ? { hideable: true } : {}),
    stackable: def.stackable,
    ...(unlockCount !== undefined ? { unlockCount } : {}),
    icon: def.icon,
    theme: def.theme,
  };
}
