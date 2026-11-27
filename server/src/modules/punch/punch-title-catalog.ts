/** LEC 工作室考勤与娱乐称号目录（22 个自动判定称号：原 11 个基础称号 + 11 个 Orbit 扩展称号）。 */

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
  | 'sparkles';

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

export interface TitleDefinition {
  id: string;
  name: string;
  description: string;
  proposer: string;
  category: TitleCategory;
  /** 为 true 时属于强制状态标签（如上周未达标/危急预警/戒赌/快思了），自动亮牌且不占用主荣誉称号槽位。 */
  forced: boolean;
  /** 为 true 时达成后永久持久化保留，不会随周/月切换失效。 */
  persistent?: boolean;
  /** 为 true 时成员可在称号图鉴中手动关闭或重新开启展示（默认打开）。 */
  hideable?: boolean;
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
  icon: TitleIconKey;
  theme: TitleThemeKey;
}

export interface TitleEvaluationItem extends MemberTitleBadge {
  unlocked: boolean;
  equipped: boolean;
  /** 仅对 hideable 称号生效：为 true 表示成员主动关闭了该称号的亮牌展示。 */
  hidden?: boolean;
  progressText?: string;
}

export const TITLE_CATALOG: TitleDefinition[] = [
  {
    id: 'punch-god',
    name: '神',
    description: '单周纯真实打卡时长超过 50 小时',
    proposer: 'LEC 工作室',
    category: 'honor',
    forced: false,
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
    icon: 'crown',
    theme: 'amber',
    priority: 100,
  },
  {
    id: 'contributor-king',
    name: '贡献王',
    description: '连续 3 次 Orbit 版本更新都参与并提交合并 PR（长期保留）',
    proposer: 'LEC 工作室',
    category: 'honor',
    forced: false,
    persistent: true,
    hideable: true,
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
    icon: 'trophy',
    theme: 'gold',
    priority: 95,
  },
  {
    id: 'collection-king',
    name: '收集之王',
    description: '集齐卡牌图鉴中全部种类的卡片（长期保留）',
    proposer: 'LEC 工作室',
    category: 'honor',
    forced: false,
    persistent: true,
    hideable: true,
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
    icon: 'zap',
    theme: 'violet',
    priority: 88,
  },
  {
    id: 'gamble-king',
    name: '赌王',
    description: '连续使用 5 张「我赌你的枪里没有子弹」并全部成功（长期保留）',
    proposer: 'LEC 工作室',
    category: 'fun',
    forced: false,
    persistent: true,
    hideable: true,
    icon: 'dices',
    theme: 'amber',
    priority: 86,
  },
  {
    id: 'most-honest',
    name: '最老实之人',
    description: '每天上课期间猛猛打卡（结合个人课表判定，未导课表按同年级/校历教学时段兜底）',
    proposer: 'LEC 工作室',
    category: 'routine',
    forced: false,
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
    icon: 'calendar-check',
    theme: 'emerald',
    priority: 82,
  },
  {
    id: 'good-student',
    name: '三好学生',
    description: '上周有效打卡满 1 小时，且一整周上课期间从不打卡（未导课表按同年级/校历教学时段兜底）',
    proposer: 'LEC 工作室',
    category: 'routine',
    forced: false,
    icon: 'graduation-cap',
    theme: 'emerald',
    priority: 80,
  },
  {
    id: 'dragon-king',
    name: '龙王',
    description: '本周获得「吕洞宾」称号后，成功对使其获得称号的人施加负面效果卡',
    proposer: 'LEC 工作室',
    category: 'fun',
    forced: false,
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
    icon: 'swords',
    theme: 'rose',
    priority: 74,
  },
  {
    id: 'almost-perfect',
    name: '差一步美满',
    description: '上周纯真实打卡时长结算时距本年级目标差不到 1 小时（目标 −1h 至目标之间）',
    proposer: 'LEC 工作室',
    category: 'fun',
    forced: false,
    icon: 'target',
    theme: 'teal',
    priority: 72,
  },
  {
    id: 'lancer-luck-e',
    name: '自古枪兵幸运e',
    description: '抽 SSR 卡触发大保底才出（长期保留）',
    proposer: 'LEC 工作室',
    category: 'fun',
    forced: false,
    persistent: true,
    hideable: true,
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
    icon: 'moon',
    theme: 'indigo',
    priority: 66,
  },
  {
    id: 'card-collector',
    name: '收集者',
    description: '在卡牌图鉴中收集 5 种不同的卡片（长期保留）',
    proposer: 'LEC 工作室',
    category: 'honor',
    forced: false,
    persistent: true,
    hideable: true,
    icon: 'layers',
    theme: 'cyan',
    priority: 64,
  },
  {
    id: 'quit-gambling',
    name: '求求你戒赌吧',
    description: '连续使用 5 张「我赌你的枪里没有子弹」且全部失败（长期保留，可手动关闭）',
    proposer: 'LEC 工作室',
    category: 'debuff',
    forced: true,
    persistent: true,
    hideable: true,
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
    icon: 'hourglass',
    theme: 'alert',
    priority: 50,
  },
  {
    id: 'almost-gone',
    name: '快思了',
    description: '上周连续一整周没有任何有效打卡记录',
    proposer: 'LEC 工作室',
    category: 'debuff',
    forced: true,
    icon: 'ghost',
    theme: 'alert',
    priority: 48,
  },
  {
    id: 'purple-egg',
    name: '想吃紫蛋了',
    description: '上周考核未打满目标时长',
    proposer: '杨东明',
    category: 'debuff',
    forced: true,
    icon: 'egg',
    theme: 'purple',
    priority: 45,
  },
];

export const TITLE_BY_ID = new Map<string, TitleDefinition>(
  TITLE_CATALOG.map((item) => [item.id, item]),
);

/** 将完整称号定义投影为前端亮牌徽章字段。 */
export function toMemberTitleBadge(def: TitleDefinition): MemberTitleBadge {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    proposer: def.proposer,
    category: def.category,
    forced: def.forced,
    ...(def.persistent ? { persistent: true } : {}),
    ...(def.hideable ? { hideable: true } : {}),
    icon: def.icon,
    theme: def.theme,
  };
}
