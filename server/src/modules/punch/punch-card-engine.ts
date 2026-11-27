/**
 * 卡牌工坊纯规则计算引擎（完整等价迁移自 LecPunch card-engine.ts，零 luxon 依赖）：
 * - 完整覆盖全部 21 张卡牌目录、权重概率（N=9000 / R=770 / SR=200 / SSR=30）、大小保底（SR=30 / SSR=70）及十连辉光升级；
 * - 完整覆盖仁王盾 / 名刀司命 / 反弹 / 无懈可击 24h 结界 / 铁索连环 / 加速卡下次签退自动结算等全部 21 张卡交互；
 * - 付费抽卡原生对接新版统一 coin 乐币体系（6 乐币/抽，每周免费 2 抽 + 赠礼抽优先，每周最多付费 20 抽）。
 */
import { createHmac } from 'node:crypto';
import { assessmentEnrollYears, comprehensiveDurationSeconds } from './punch-shared.util.js';
import { addShanghaiDays, shanghaiDayStartMs } from './punch-title-engine.js';

export type CardRarity = 'N' | 'R' | 'SR' | 'SSR';

export interface CardDefinition {
  id: string;
  name: string;
  rarity: CardRarity;
  type: string;
  stat: string;
  summary: string;
  effect: string;
  detail: string;
}

export const CARD_PITY_LIMITS = { sr: 30, ssr: 70 } as const;
export const CARD_DRAW_WEIGHTS: Record<CardRarity, number> = {
  N: 9000,
  R: 770,
  SR: 200,
  SSR: 30,
};
export const CARD_DRAW_WEIGHT_TOTAL = 10_000;
export const WEEKLY_FREE_DRAWS = 2;
export const WEEKLY_MAX_PAID_DRAWS = 20;
export const COIN_COST_PER_DRAW = 6;

export const ASSESSMENT_TARGET_CARDS = ['r-charity', 'sr-angel', 'ssr-harvest'] as const;

export const CARD_CATALOG: CardDefinition[] = [
  { id: 'n-acceleration', name: '加速', rarity: 'N', type: '个人增益', stat: '+15%', summary: '让下一次认真，跑得更快一点。', effect: '下次有效签退获得该次有效时长 15% 的娱乐加成，最多 30 分钟。', detail: '作废打卡不触发、不消耗加速。' },
  { id: 'n-reduce', name: '减时长', rarity: 'N', type: '随机扣时', stat: '−30 MIN', summary: '偷偷拨动指针，时间就溜走了。', effect: '随机选择一名同年级其他玩家，扣除 30 分钟娱乐时长。', detail: '不改变真实考勤记录。' },
  { id: 'n-gamble', name: '我赌你的枪里没有子弹', rarity: 'N', type: '自身判定', stat: '50% · ±30 MIN', summary: '这次，运气站在哪一边？', effect: '50% 概率自己获得 30 分钟加成；50% 概率扣除 30 分钟。', detail: '先判定再处理防御。' },
  { id: 'n-shield', name: '仁王盾', rarity: 'N', type: '被动防御', stat: 'BLOCK · N', summary: '小小盾牌，也要认真守护。', effect: '自动抵挡一次 N 级卡牌造成的扣时或不利判定结果。', detail: '触发后消耗。' },
  { id: 'r-add', name: '加时卡', rarity: 'R', type: '指定增益', stat: '+30 MIN', summary: '把多一点时间，送给你。', effect: '给自己或指定一名同年级玩家增加 30 分钟娱乐时长。', detail: '可对自己或他人使用。' },
  { id: 'r-steal', name: '顺手牵羊', rarity: 'R', type: '指定偷取', stat: 'STEAL 30', summary: '这三十分钟，我就收下啦。', effect: '指定一名同年级其他玩家娱乐时长 −30 分钟，自己 +30 分钟。', detail: '同步影响双方综合时长。' },
  { id: 'r-mystery', name: '?', rarity: 'R', type: '随机换卡', stat: 'MYSTERY', summary: '下一张，会是什么呢？', effect: '按基础概率获得另一张卡，不能获得 ? 自身。', detail: '不消耗普通抽卡机会。' },
  { id: 'r-blade', name: '名刀司命', rarity: 'R', type: '被动防御', stat: 'BLOCK · N–R', summary: '在坏运气落下前，轻轻截住。', effect: '自动抵挡一次 N～R 级对自己不利的卡牌效果。', detail: '触发后消耗。' },
  { id: 'r-charity', name: '慈善家', rarity: 'R', type: '应考成员赠送', stat: 'SHARE 10%', summary: '把拥有的一点光，分给大家。', effect: '将自己正综合时长的 10% 平均转移给当前应考名单中的其他启用成员。', detail: '无正综合时长不能使用。' },
  { id: 'r-skip', name: '乐不思蜀', rarity: 'R', type: '限时禁用', stat: 'PAUSE 1H', summary: '先坐下来，喝一杯再说。', effect: '指定一名成员 1 小时不能主动使用卡牌。', detail: '不影响打卡与抽卡。' },
  { id: 'r-thief', name: '神偷奶爸', rarity: 'R', type: '转移赠送', stat: 'GIFT 30', summary: '拿来的时间，是给你的礼物。', effect: '从随机其他成员处转移 30 分钟送给指定成员。', detail: '供给方与接收方不能相同。' },
  { id: 'sr-angel', name: '天使卡', rarity: 'SR', type: '同年级增益', stat: 'ALL +30', summary: '今天的好运，每个人都有份。', effect: '同年级正式玩家各获得 30 分钟娱乐加成。', detail: '含使用者自身。' },
  { id: 'sr-chain', name: '铁索连环', rarity: 'SR', type: '关联状态', stat: 'LINK ×2', summary: '这一刻，你与我的时间相连。', effect: '绑定两名不同的同年级玩家，下一次娱乐时长变化同步。', detail: '同步后解除。' },
  { id: 'sr-lightning', name: '雷电', rarity: 'SR', type: '顺序判定', stat: '50% · −60', summary: '沿着名单，等待第一道闪电。', effect: '同年级其他玩家依次 50% 判定，首个命中者扣 60 分钟。', detail: '首个命中即结束。' },
  { id: 'sr-reflect', name: '反弹', rarity: 'SR', type: '被动反击', stat: 'RETURN ×1', summary: '这份坏心思，原路奉还。', effect: '将一次针对个人的负面效果反弹给原使用者。', detail: '触发后消耗。' },
  { id: 'sr-famine', name: '兵粮寸断', rarity: 'SR', type: '获取限制', stat: 'LOCK 3H', summary: '补给暂停，先用好手里的牌。', effect: '指定一名成员 3 小时不能获得新卡。', detail: '不影响打卡与使用已有卡牌。' },
  { id: 'sr-invasion', name: '南蛮入侵', rarity: 'SR', type: '群体攻击', stat: 'N / −15', summary: '小小远征，带走一点好运。', effect: '同年级其他玩家各随机失去一张 N 卡，否则扣 15 分钟。', detail: '允许扣为负数。' },
  { id: 'sr-redking', name: '红桃 K', rarity: 'SR', type: '指定扣时', stat: '−30 MIN', summary: '锁定目标，亮出红桃王牌。', effect: '指定一名成员扣除 30 分钟娱乐时长。', detail: '可被反弹或无懈可击抵御。' },
  { id: 'ssr-harvest', name: '五谷丰登', rarity: 'SSR', type: '同年级赠卡', stat: 'ALL +2 DRAWS', summary: '丰收的喜悦，要一起分享。', effect: '同年级正式玩家各获得 2 次额外抽卡机会。', detail: '当周有效。' },
  { id: 'ssr-invincible', name: '无懈可击', rarity: 'SSR', type: '主动保护', stat: 'WARD 24H', summary: '此刻，光芒为你筑起结界。', effect: '保护自己 24 小时免疫负面卡牌效果。', detail: '跨周仍保留至到期。' },
  { id: 'ssr-arrows', name: '万箭穿心', rarity: 'SSR', type: '群体与指定攻击', stat: '10% + STRIKE', summary: '万千星芒，汇于决定的一击。', effect: '其他同年级玩家各扣 10%（上限 15 分钟），指定一人额外扣损失总额一半。', detail: '不修改真实考勤记录。' },
];

export interface PlayerWeek {
  entertainmentSeconds: number;
  mintedSeconds: number;
  spentPoints: number;
  freeUsed: number;
  bonusDraws: number;
  paidDrawsUsed?: number;
  spentCoins?: number;
  accelerationAt?: number;
  immuneUntil?: number;
  lockedUntil?: number;
  starvedUntil?: number;
  boostedSessionIds?: string[];
}

export interface PlayerState {
  inventory: Record<string, number>;
  discovered: string[];
  pitySR: number;
  pitySSR: number;
  /** 24 小时无懈可击保护归属成员本人，跨周归档时继续保留。 */
  wardUntil?: number;
  weeks: Record<string, PlayerWeek>;
}

export interface GameLink {
  a: string;
  b: string;
  week: string;
  createdBy: string;
}

export interface GameState {
  version: 1;
  members: Record<string, PlayerState>;
  links: GameLink[];
}

export interface GameEffect {
  targetId: string;
  actualTargetId?: string;
  sourceId?: string;
  sourceCardId?: string;
  randomTarget?: boolean;
  kind: 'time' | 'cards' | 'status' | 'judgement';
  outcome: 'applied' | 'blocked' | 'reflected' | 'no-effect';
  deltaSeconds?: number;
  detail?: string;
}

export interface GameDefense {
  userId: string;
  attackerId: string;
  attackCardId: string;
  defenseCardId: string;
  outcome: 'blocked' | 'reflected';
}

export interface GameContext {
  week: string;
  now: number;
  players: { id: string; username: string; name: string; enrollYear: number }[];
  baseSeconds: Record<string, number>;
  /** 当前操作者可用统一乐币余额（仅 draw 扣费校验使用）。 */
  actorCoinBalance?: number;
  sessions?: { id: string; userId: string; checkOutAt: number; durationSeconds: number; weekKey: string }[];
  random: () => number;
  effects?: GameEffect[];
  defenses?: GameDefense[];
  assessmentYears?: number[];
}

export interface GameAction {
  action: 'draw' | 'use' | 'gift';
  count?: 1 | 10;
  cardId?: string;
  targetId?: string;
  secondTargetId?: string;
}

export interface GameActionResult {
  message: string;
  gainedCardId?: string;
  gainedCardIds?: string[];
  drawAnimation?: 'blue' | 'purple' | 'gold' | 'radiance';
  ssrPity?: boolean;
  drawCount?: 10;
  radianceCount?: number;
  paidDraws?: number;
  spentCoins?: number;
  affectedUserIds: string[];
  effects?: GameEffect[];
  defenses?: GameDefense[];
}

const rarityValue: Record<CardRarity, number> = { N: 0, R: 1, SR: 2, SSR: 3 };

/** 内部 cardId 转为对外公开编号 card-01..card-21。 */
export function toPublicCardId(internalId: string): string {
  const idx = CARD_CATALOG.findIndex((c) => c.id === internalId);
  return idx >= 0 ? `card-${String(idx + 1).padStart(2, '0')}` : internalId;
}

/** 兼容公开编号 card-01..card-21 与内部 cardId。 */
export function resolveInternalCardId(rawId?: string): string | undefined {
  if (!rawId) return undefined;
  const trimmed = rawId.trim();
  const matched = CARD_CATALOG.find(
    (card, idx) => `card-${String(idx + 1).padStart(2, '0')}` === trimmed || card.id === trimmed,
  );
  return matched?.id;
}

export function getCardTargetMode(id: string): 'none' | 'self-or-other' | 'other' | 'two' | 'recipient' {
  if (id === 'r-add') return 'self-or-other';
  if (id === 'sr-chain') return 'two';
  if (id === 'r-thief') return 'recipient';
  if (['r-steal', 'r-skip', 'sr-famine', 'sr-redking', 'ssr-arrows'].includes(id)) return 'other';
  return 'none';
}

/** 按操作幂等键派生确定性随机数流，保证重试结果可重现。 */
export function seededCardRandom(secret: string, key: string): () => number {
  let counter = 0;
  return () =>
    createHmac('sha256', secret)
      .update(`${key}:${counter++}`)
      .digest()
      .readUInt32BE(0) / 0x100000000;
}

const getCard = (id: string): CardDefinition => {
  const card = CARD_CATALOG.find((item) => item.id === id);
  if (!card) throw new Error('卡片不存在');
  return card;
};

export const createGameState = (): GameState => ({ version: 1, members: {}, links: [] });

export function normalizeGameState(raw: Record<string, unknown> | null | undefined): GameState {
  if (!raw || typeof raw !== 'object') return createGameState();
  const members =
    raw.members && typeof raw.members === 'object'
      ? (raw.members as Record<string, PlayerState>)
      : {};
  const links = Array.isArray(raw.links) ? (raw.links as GameLink[]) : [];
  return { version: 1, members, links };
}

export function getPlayerWeek(state: GameState, id: string, week: string): PlayerWeek {
  const member = (state.members[id] ??= {
    inventory: {},
    discovered: [],
    pitySR: 0,
    pitySSR: 0,
    weeks: {},
  });
  member.inventory ??= {};
  member.discovered ??= [];
  member.pitySR ??= 0;
  member.pitySSR ??= 0;
  member.weeks ??= {};
  const entry = (member.weeks[week] ??= {
    entertainmentSeconds: 0,
    mintedSeconds: 0,
    spentPoints: 0,
    freeUsed: 0,
    bonusDraws: 0,
  });
  entry.entertainmentSeconds ??= 0;
  entry.mintedSeconds ??= 0;
  entry.spentPoints ??= 0;
  entry.freeUsed ??= 0;
  entry.bonusDraws ??= 0;
  return entry;
}

function take(state: GameState, id: string, cardId: string): void {
  const bag = state.members[id].inventory;
  if (!(bag[cardId] > 0)) throw new Error('没有这张卡片');
  bag[cardId] -= 1;
}

function receive(state: GameState, id: string, cardId: string): void {
  const member = state.members[id];
  member.inventory[cardId] = (member.inventory[cardId] ?? 0) + 1;
  if (!member.discovered.includes(cardId)) member.discovered.push(cardId);
}

function pick<T>(items: T[], context: GameContext): T {
  if (!items.length) throw new Error('没有可选目标');
  return items[Math.min(items.length - 1, Math.floor(context.random() * items.length))];
}

function drawCard(context: GameContext, minimum: CardRarity = 'N', excludeMystery = false): CardDefinition {
  const roll = Math.floor(context.random() * CARD_DRAW_WEIGHT_TOTAL);
  let rarity: CardRarity = 'SSR';
  let cumulative = 0;
  for (const [level, weight] of Object.entries(CARD_DRAW_WEIGHTS)) {
    cumulative += weight;
    if (roll < cumulative) {
      rarity = level as CardRarity;
      break;
    }
  }
  if (rarityValue[rarity] < rarityValue[minimum]) rarity = minimum;
  return pick(
    CARD_CATALOG.filter((card) => card.rarity === rarity && (!excludeMystery || card.id !== 'r-mystery')),
    context,
  );
}

/** 结算目标防御（无懈可击 > 仁王盾/名刀司命 > 反弹；反弹后不再二次反弹）。 */
function resolveTarget(
  state: GameState,
  context: GameContext,
  actor: string,
  target: string,
  card: CardDefinition,
  harmful: boolean,
  single: boolean,
  reflected = false,
): string | null {
  const week = getPlayerWeek(state, target, context.week);
  const inventory = state.members[target].inventory;
  if (harmful && actor !== target && (week.immuneUntil ?? 0) > context.now) return null;
  if (harmful) {
    if (card.rarity === 'N' && (inventory['n-shield'] ?? 0) > 0) {
      take(state, target, 'n-shield');
      context.defenses?.push({
        userId: target,
        attackerId: actor,
        attackCardId: card.id,
        defenseCardId: 'n-shield',
        outcome: 'blocked',
      });
      return null;
    }
    if (rarityValue[card.rarity] <= rarityValue.R && (inventory['r-blade'] ?? 0) > 0) {
      take(state, target, 'r-blade');
      context.defenses?.push({
        userId: target,
        attackerId: actor,
        attackCardId: card.id,
        defenseCardId: 'r-blade',
        outcome: 'blocked',
      });
      return null;
    }
  }
  if (harmful && single && actor !== target && !reflected && (inventory['sr-reflect'] ?? 0) > 0) {
    take(state, target, 'sr-reflect');
    context.defenses?.push({
      userId: target,
      attackerId: actor,
      attackCardId: card.id,
      defenseCardId: 'sr-reflect',
      outcome: 'reflected',
    });
    return resolveTarget(state, context, target, actor, card, true, true, true);
  }
  return target;
}

/** 修改目标娱乐时长，并触发铁索连环一次性传导。 */
function change(
  state: GameState,
  context: GameContext,
  target: string,
  delta: number,
  source: string,
  card: CardDefinition,
  single: boolean,
  sync = true,
  directTransferDebit = false,
  randomTarget = false,
): { target: string | null; delta: number } {
  const selection = {
    ...(randomTarget ? { randomTarget: true } : {}),
    ...(card.id === 'sr-chain' ? { sourceId: source, sourceCardId: card.id } : {}),
  };
  delta = Math.trunc(delta);
  if (!delta) {
    context.effects?.push({
      ...selection,
      targetId: target,
      kind: 'time',
      outcome: 'no-effect',
      deltaSeconds: 0,
    });
    return { target, delta: 0 };
  }
  const resolved = directTransferDebit
    ? target
    : resolveTarget(state, context, source, target, card, delta < 0, single);
  if (!resolved) {
    context.effects?.push({
      ...selection,
      targetId: target,
      kind: 'time',
      outcome: 'blocked',
      deltaSeconds: 0,
    });
    return { target: null, delta: 0 };
  }
  const week = getPlayerWeek(state, resolved, context.week);
  const nextSeconds = week.entertainmentSeconds + delta;
  if (!Number.isSafeInteger(nextSeconds)) throw new Error('卡牌时长超出安全范围');
  // 校验综合时长安全整数边界
  comprehensiveDurationSeconds(0, context.baseSeconds[resolved] ?? 0, nextSeconds);
  week.entertainmentSeconds = nextSeconds;
  context.effects?.push({
    ...selection,
    targetId: target,
    actualTargetId: resolved,
    kind: 'time',
    outcome: resolved === target ? 'applied' : 'reflected',
    deltaSeconds: delta,
  });
  if (sync) {
    const links = state.links.filter(
      (link) => link.week === context.week && (link.a === resolved || link.b === resolved),
    );
    state.links = state.links.filter((link) => !links.includes(link));
    for (const link of links) {
      const other = link.a === resolved ? link.b : link.a;
      if (!context.players.some((player) => player.id === other)) continue;
      change(state, context, other, delta, link.createdBy, getCard('sr-chain'), true, false);
    }
  }
  return { target: resolved, delta };
}

/** 推进卡牌状态：延续跨周无懈可击结界、结算待触发的加速卡签退加成并清理过期铁索连环。 */
export function advanceGameState(state: GameState, context: GameContext): void {
  for (const player of context.players) getPlayerWeek(state, player.id, context.week);
  for (const member of Object.values(state.members)) {
    const until = Object.entries(member.weeks ?? {})
      .filter(([key]) => key <= context.week)
      .reduce((latest, [, value]) => Math.max(latest, value.immuneUntil ?? 0), member.wardUntil ?? 0);
    if (until > context.now) {
      member.wardUntil = until;
      if (member.weeks?.[context.week]) member.weeks[context.week].immuneUntil = until;
    } else {
      delete member.wardUntil;
    }
  }

  for (const [userId, player] of Object.entries(state.members)) {
    for (const [weekKey, week] of Object.entries(player.weeks ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (week.accelerationAt === undefined) continue;
      if (weekKey > context.week) continue;
      const historical = weekKey < context.week;
      const endMs = shanghaiDayStartMs(addShanghaiDays(weekKey, 7), 0);
      const session = context.sessions
        ?.filter(
          (item) =>
            item.userId === userId &&
            item.weekKey === weekKey &&
            item.durationSeconds > 0 &&
            item.durationSeconds < 18_000 &&
            item.checkOutAt > week.accelerationAt! &&
            item.checkOutAt <= context.now &&
            (!historical || item.checkOutAt < endMs) &&
            !(week.boostedSessionIds ?? []).includes(item.id),
        )
        .sort((a, b) => a.checkOutAt - b.checkOutAt || a.id.localeCompare(b.id))[0];
      if (!session) {
        if (historical) delete week.accelerationAt;
        continue;
      }
      week.boostedSessionIds = [...(week.boostedSessionIds ?? []), session.id];
      delete week.accelerationAt;
      change(
        state,
        { ...context, week: weekKey, now: session.checkOutAt },
        userId,
        Math.min(1800, Math.floor(session.durationSeconds * 0.15)),
        userId,
        getCard('n-acceleration'),
        true,
      );
    }
  }
  state.links = (state.links ?? []).filter((link) => link.week === context.week);
}

/**
 * 执行一次卡牌操作（draw / gift / use）。
 * 先在深拷贝上演算全部逻辑，完全成功后再覆盖回 state，失败零副作用。
 */
export function applyGameAction(
  state: GameState,
  actorId: string,
  action: GameAction,
  context: GameContext,
): GameActionResult {
  if (action.count !== undefined && (action.action !== 'draw' || ![1, 10].includes(action.count))) {
    throw new Error('仅抽卡支持 1 次或 10 次抽取');
  }
  const next = structuredClone(state);
  advanceGameState(next, context);

  const effects: GameEffect[] = [];
  const defenses: GameDefense[] = [];
  context = { ...context, effects, defenses };

  const actor = context.players.find((player) => player.id === actorId);
  if (!actor) throw new Error('当前成员没有卡牌访问资格');
  const week = getPlayerWeek(next, actorId, context.week);
  const member = next.members[actorId];
  const peers = context.players.filter((player) => player.enrollYear === actor.enrollYear);
  const others = peers.filter((player) => player.id !== actorId);
  const assessmentYears =
    context.assessmentYears ?? assessmentEnrollYears(context.players.map((player) => player.enrollYear));
  const crossGrade =
    action.action === 'use' &&
    (ASSESSMENT_TARGET_CARDS as readonly string[]).includes(action.cardId ?? '');
  const targetPeers = crossGrade
    ? context.players.filter((player) => assessmentYears.includes(player.enrollYear))
    : peers;
  const targetOthers = targetPeers.filter((player) => player.id !== actorId);

  const chooseTarget = (id: string | undefined, allowSelf = false) => {
    const target = targetPeers.find(
      (player) => player.id === id && (allowSelf || player.id !== actorId),
    );
    if (!target) throw new Error(crossGrade ? '请选择当前应考成员中的有效目标' : '请选择同年级的有效目标');
    return target.id;
  };

  let gainedCardId: string | undefined;
  let drawResult:
    | Pick<
        GameActionResult,
        'gainedCardIds' | 'drawAnimation' | 'ssrPity' | 'drawCount' | 'radianceCount' | 'paidDraws' | 'spentCoins'
      >
    | undefined;
  const touched = new Set<string>([actorId]);

  if (action.action === 'draw') {
    if ((week.starvedUntil ?? 0) > context.now) throw new Error('兵粮寸断期间不能获得新卡');
    const count = action.count ?? 1;
    const free = Math.min(count, Math.max(0, WEEKLY_FREE_DRAWS - week.freeUsed));
    const gifts = Math.min(count - free, week.bonusDraws);
    const paidDraws = count - free - gifts;
    const coinCost = paidDraws * COIN_COST_PER_DRAW;

    if (paidDraws > 0) {
      const alreadyPaid = week.paidDrawsUsed ?? 0;
      const remainingPaidQuota = Math.max(0, WEEKLY_MAX_PAID_DRAWS - alreadyPaid);
      if (alreadyPaid + paidDraws > WEEKLY_MAX_PAID_DRAWS) {
        if (remainingPaidQuota === 0) {
          throw new Error(
            `本周付费抽卡已达上限（已用 ${alreadyPaid}/${WEEKLY_MAX_PAID_DRAWS} 抽），下周一零点重置`,
          );
        }
        throw new Error(
          `本周付费抽卡已达上限：本周还剩 ${remainingPaidQuota} 次付费额度（已用 ${alreadyPaid}/${WEEKLY_MAX_PAID_DRAWS} 抽），本次需付费 ${paidDraws} 抽，请改为单抽`,
        );
      }
      const balance = context.actorCoinBalance ?? 0;
      if (balance < coinCost) {
        throw new Error(
            `可用乐币不足：本次需付费 ${paidDraws} 抽（${COIN_COST_PER_DRAW} 乐币/抽，共需 ${coinCost} 乐币），当前仅剩 ${balance} 乐币`,
        );
      }
    }

    const rewards: CardDefinition[] = [];
    const initialPity = { sr: member.pitySR, ssr: member.pitySSR };
    let animation: NonNullable<GameActionResult['drawAnimation']> = 'blue';
    let hitPity = false;
    let radianceCount = 0;
    const animationRank = { blue: 0, purple: 1, gold: 2, radiance: 3 };

    for (let index = 0; index < count; index++) {
      if (week.freeUsed < WEEKLY_FREE_DRAWS) {
        week.freeUsed += 1;
      } else if (week.bonusDraws > 0) {
        week.bonusDraws -= 1;
      } else {
        week.paidDrawsUsed = (week.paidDrawsUsed ?? 0) + 1;
        week.spentCoins = (week.spentCoins ?? 0) + COIN_COST_PER_DRAW;
      }
      const ssrPity = member.pitySSR >= CARD_PITY_LIMITS.ssr - 1;
      const radiance = count === 10 && ssrPity && context.random() < 0.3;
      const ssrPool = CARD_CATALOG.filter((card) => card.rarity === 'SSR');
      const card = ssrPity
        ? pick(ssrPool, context)
        : drawCard(context, member.pitySR >= CARD_PITY_LIMITS.sr - 1 ? 'SR' : 'N');
      member.pitySSR = card.rarity === 'SSR' ? 0 : member.pitySSR + 1;
      member.pitySR = rarityValue[card.rarity] >= rarityValue.SR ? 0 : member.pitySR + 1;
      rewards.push(card);
      hitPity ||= ssrPity;
      if (radiance) radianceCount += 1;
      const selectedAnimation = radiance
        ? 'radiance'
        : card.rarity === 'SSR'
          ? 'gold'
          : card.rarity === 'SR'
            ? 'purple'
            : 'blue';
      if (animationRank[selectedAnimation] > animationRank[animation]) animation = selectedAnimation;
    }

    if (radianceCount > 0) {
      const replacement = rewards.findIndex((card) => card.rarity !== 'SSR');
      if (replacement >= 0) {
        rewards[replacement] = pick(
          CARD_CATALOG.filter((card) => card.rarity === 'SSR'),
          context,
        );
      }
      member.pitySR = initialPity.sr;
      member.pitySSR = initialPity.ssr;
      for (const card of rewards) {
        member.pitySSR = card.rarity === 'SSR' ? 0 : member.pitySSR + 1;
        member.pitySR = rarityValue[card.rarity] >= rarityValue.SR ? 0 : member.pitySR + 1;
      }
    }

    for (const reward of rewards) receive(next, actorId, reward.id);
    gainedCardId = rewards[0].id;
    drawResult = {
      gainedCardIds: rewards.map((reward) => reward.id),
      ssrPity: hitPity,
      drawAnimation: animation,
      paidDraws,
      spentCoins: coinCost,
      ...(count === 10 ? { drawCount: 10, radianceCount } : {}),
    };
  } else if (action.action === 'gift') {
    const card = getCard(action.cardId ?? '');
    const targetPlayer = context.players.find(
      (player) => player.id === action.targetId && player.id !== actorId,
    );
    if (!targetPlayer) throw new Error('请选择团队中的其他有效成员');
    const target = targetPlayer.id;
    if ((getPlayerWeek(next, target, context.week).starvedUntil ?? 0) > context.now) {
      throw new Error('目标兵粮寸断期间不能接收新卡');
    }
    take(next, actorId, card.id);
    receive(next, target, card.id);
    touched.add(target);
    effects.push({
      targetId: target,
      kind: 'cards',
      outcome: 'applied',
      detail: '收到一张卡片，已加入库存并解锁图鉴',
    });
  } else if (action.action === 'use') {
    if ((week.lockedUntil ?? 0) > context.now) throw new Error('乐不思蜀期间不能主动使用卡牌');
    const card = getCard(action.cardId ?? '');
    if (['n-shield', 'r-blade', 'sr-reflect'].includes(card.id)) {
      throw new Error('该卡自动防御，无需主动使用');
    }
    if (card.id === 'n-acceleration' && week.accelerationAt !== undefined) {
      throw new Error('已有待生效加速');
    }
    if (card.id === 'ssr-invincible' && (week.immuneUntil ?? 0) > context.now) {
      throw new Error('无懈可击仍在生效，不能叠加');
    }
    if (card.id === 'r-mystery' && (week.starvedUntil ?? 0) > context.now) {
      throw new Error('兵粮寸断期间不能获得新卡');
    }
    take(next, actorId, card.id);

    const update = (target: string, delta: number, single = true, randomTarget = false) => {
      touched.add(target);
      return change(next, context, target, delta, actorId, card, single, true, false, randomTarget);
    };
    const totalSeconds = (id: string) =>
      comprehensiveDurationSeconds(
        0,
        context.baseSeconds[id] ?? 0,
        getPlayerWeek(next, id, context.week).entertainmentSeconds,
      );

    switch (card.id) {
      case 'n-acceleration':
        week.accelerationAt = context.now;
        effects.push({
          targetId: actorId,
          kind: 'status',
          outcome: 'applied',
          detail: '加速已就绪，等待下一次有效签退',
        });
        break;
      case 'n-reduce':
        update(pick(others, context).id, -1800, true, true);
        break;
      case 'n-gamble':
        if (context.random() < 0.5) {
          effects.push({
            targetId: actorId,
            randomTarget: true,
            kind: 'judgement',
            outcome: 'applied',
            detail: '自身判定为不利结果，先结算适用防御，再决定是否扣除 30 分钟',
          });
          update(actorId, -1800, true, true);
        } else {
          effects.push({
            targetId: actorId,
            randomTarget: true,
            kind: 'judgement',
            outcome: 'applied',
            detail: '自身判定幸运，获得 30 分钟加成',
          });
          update(actorId, 1800, true, true);
        }
        break;
      case 'r-add':
        update(chooseTarget(action.targetId ?? actorId, true), 1800);
        break;
      case 'r-steal': {
        const victim = chooseTarget(action.targetId);
        const stolen = update(victim, -1800);
        if (stolen.delta < 0) {
          update(stolen.target === actorId ? victim : actorId, -stolen.delta);
        }
        break;
      }
      case 'r-mystery': {
        const replacement = drawCard(context, 'N', true);
        receive(next, actorId, replacement.id);
        effects.push({
          targetId: actorId,
          kind: 'cards',
          outcome: 'applied',
          detail: '随机换卡已加入库存',
        });
        gainedCardId = replacement.id;
        break;
      }
      case 'r-charity': {
        const recipients = targetOthers;
        const available = Math.max(0, totalSeconds(actorId));
        if (!recipients.length || !available) throw new Error('没有可接收成员或正综合时长');
        const share = Math.floor(Math.floor(available * 0.1) / recipients.length);
        if (!share) throw new Error('可分配时长不足一秒');
        change(next, context, actorId, -share * recipients.length, actorId, card, false, true, true);
        for (const recipient of targetOthers) update(recipient.id, share, false);
        break;
      }
      case 'r-skip':
      case 'sr-famine': {
        const target = chooseTarget(action.targetId);
        const resolved = resolveTarget(next, context, actorId, target, card, true, true);
        effects.push({
          targetId: target,
          ...(resolved ? { actualTargetId: resolved } : {}),
          kind: 'status',
          outcome: !resolved ? 'blocked' : resolved === target ? 'applied' : 'reflected',
          detail: card.id === 'r-skip' ? '暂停主动用卡 1 小时' : '暂停获得新卡 3 小时',
        });
        if (resolved) {
          const targetWeek = getPlayerWeek(next, resolved, context.week);
          if (card.id === 'r-skip') targetWeek.lockedUntil = context.now + 3_600_000;
          else targetWeek.starvedUntil = context.now + 3 * 3_600_000;
          touched.add(resolved);
        }
        break;
      }
      case 'r-thief': {
        const receiver = chooseTarget(action.targetId);
        const candidates = targetOthers.filter((player) => player.id !== receiver);
        if (!candidates.length) throw new Error('没有可转移的供给方');
        const donor = pick(candidates, context).id;
        const stolen = update(donor, -1800, true, true);
        if (stolen.delta < 0) update(receiver, -stolen.delta);
        else {
          effects.push({
            targetId: receiver,
            kind: 'time',
            outcome: 'no-effect',
            deltaSeconds: 0,
            detail: '扣时被防御或免疫，本次没有可转赠的实际时长',
          });
        }
        break;
      }
      case 'sr-angel':
        for (const peer of peers) update(peer.id, 1800, false);
        break;
      case 'sr-chain': {
        const a = chooseTarget(action.targetId, true);
        const b = chooseTarget(action.secondTargetId, true);
        if (a === b) throw new Error('连环需要两名不同成员');
        if (
          next.links.some(
            (link) => link.week === context.week && [link.a, link.b].some((id) => id === a || id === b),
          )
        ) {
          throw new Error('目标已有未触发连环');
        }
        const resolvedA = resolveTarget(next, context, actorId, a, card, false, true);
        const resolvedB = resolvedA ? resolveTarget(next, context, actorId, b, card, false, true) : null;
        const linked = Boolean(resolvedA && resolvedB);
        effects.push(
          {
            targetId: a,
            kind: 'status',
            outcome: linked ? 'applied' : resolvedA ? 'no-effect' : 'blocked',
            detail: linked ? '连环已建立' : '连环未建立',
          },
          {
            targetId: b,
            kind: 'status',
            outcome: linked ? 'applied' : !resolvedA ? 'no-effect' : 'blocked',
            detail: linked ? '连环已建立' : '连环未建立',
          },
        );
        if (linked) {
          next.links.push({ a, b, week: context.week, createdBy: actorId });
          touched.add(a);
          touched.add(b);
        }
        break;
      }
      case 'sr-lightning':
        for (const other of [...others].sort((a, b) =>
          a.username < b.username ? -1 : a.username > b.username ? 1 : a.id.localeCompare(b.id),
        )) {
          if (context.random() < 0.5) {
            effects.push({
              targetId: other.id,
              randomTarget: true,
              kind: 'judgement',
              outcome: 'applied',
              detail: '雷电判定命中（逐人独立 50% 判定）',
            });
            update(other.id, -3600, true, true);
            break;
          }
          effects.push({
            targetId: other.id,
            randomTarget: true,
            kind: 'judgement',
            outcome: 'no-effect',
            detail: '雷电判定未命中（逐人独立 50% 判定），未扣除时长',
          });
        }
        break;
      case 'sr-invasion':
        for (const other of others) {
          const inventory = next.members[other.id].inventory;
          const nCards = CARD_CATALOG.filter((item) => item.rarity === 'N').flatMap((item) =>
            Array.from({ length: inventory[item.id] ?? 0 }, () => item.id),
          );
          const resolved = resolveTarget(next, context, actorId, other.id, card, true, false);
          if (!resolved) {
            effects.push({ targetId: other.id, kind: 'cards', outcome: 'blocked' });
            continue;
          }
          if (nCards.length > 0) {
            take(next, other.id, pick(nCards, context));
            effects.push({
              targetId: other.id,
              kind: 'cards',
              outcome: 'applied',
              detail: '随机弃置 1 张 N 级卡片',
            });
          } else {
            update(other.id, -900, false);
          }
          touched.add(other.id);
        }
        break;
      case 'sr-redking':
        update(chooseTarget(action.targetId), -1800);
        break;
      case 'ssr-harvest':
        for (const peer of peers) {
          const resolved = resolveTarget(next, context, actorId, peer.id, card, false, false);
          effects.push({
            targetId: peer.id,
            kind: 'status',
            outcome: resolved ? 'applied' : 'blocked',
            detail: '获得 2 次当周抽卡机会',
          });
          if (resolved) {
            getPlayerWeek(next, peer.id, context.week).bonusDraws += 2;
            touched.add(peer.id);
          }
        }
        break;
      case 'ssr-invincible':
        member.wardUntil = week.immuneUntil = context.now + 24 * 3_600_000;
        effects.push({
          targetId: actorId,
          kind: 'status',
          outcome: 'applied',
          detail: '无懈可击已生效，最长持续 24 小时',
        });
        break;
      case 'ssr-arrows': {
        const target = chooseTarget(action.targetId);
        let removed = 0;
        for (const peer of others) {
          const amount = Math.min(900, Math.floor(Math.max(0, totalSeconds(peer.id)) * 0.1));
          removed -= update(peer.id, -amount, false).delta;
        }
        update(target, -Math.min(3600, Math.floor(removed / 2)));
        break;
      }
      default:
        throw new Error('卡片暂不支持主动使用');
    }
  } else {
    throw new Error('不支持的卡牌操作');
  }

  Object.assign(state, next);
  return {
    message:
      action.action === 'draw'
        ? action.count === 10
          ? `十连抽成功，共获得 ${drawResult!.gainedCardIds!.length} 张卡片`
          : '抽卡成功'
        : action.action === 'gift'
          ? '卡片已赠送'
          : '卡片已结算',
    ...(gainedCardId ? { gainedCardId } : {}),
    ...drawResult,
    affectedUserIds: [...touched],
    ...(effects.length ? { effects } : {}),
    ...(defenses.length ? { defenses } : {}),
  };
}
