import { describe, expect, test } from 'bun:test';
import type { BusyScheduleSnapshot } from '../src/modules/calendar/entities/member-busy-snapshot.entity.js';
import {
  GitHubContributorSyncService,
  attributeMergedPrsToReleases,
} from '../src/modules/punch/github-contributor-sync.service.js';
import {
  TITLE_CATALOG,
  computeTitleAchievementTier,
  formatTitleTierText,
} from '../src/modules/punch/punch-title-catalog.js';
import {
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  extractGambleEventFromReceipt,
  extractNonOverlappingStreakKeys,
  hasSsrPityInReceipt,
  shanghaiDayStartMs,
  type TitleEngineSession,
} from '../src/modules/punch/punch-title-engine.js';
import { PunchTitlesService } from '../src/modules/punch/punch-titles.service.js';

/** 构造上海时间某天 HH:MM 起持续 durationMinutes 分钟的已签退会话。 */
function makeSession(
  userId: string,
  dayKey: string,
  weekKey: string,
  startHour: number,
  startMinute: number,
  durationMinutes: number,
): TitleEngineSession {
  const startMs = shanghaiDayStartMs(dayKey, startHour, startMinute);
  const durSec = durationMinutes * 60;
  return {
    userId,
    checkInAt: new Date(startMs),
    checkOutAt: new Date(startMs + durSec * 1000),
    durationSeconds: durSec,
    status: 'completed',
    weekKey,
  };
}

/** 构造 2026-09-07（第 1 周周一）起周一至周五 1-2 节（08:00-09:35）有课的课表快照。 */
function makeWeekdayMorningSchedule(): BusyScheduleSnapshot {
  return {
    scheduleName: '2026秋测试课表',
    startDate: '2026-09-07',
    totalWeeks: 20,
    weekStartDay: 1,
    slots: [
      { section: 1, startTime: '08:00', endTime: '08:45' },
      { section: 2, startTime: '08:50', endTime: '09:35' },
      { section: 3, startTime: '09:50', endTime: '10:35' },
      { section: 4, startTime: '10:40', endTime: '11:25' },
    ],
    courses: [
      {
        id: 'c1',
        name: '高等数学',
        color: '#4F8EF7',
        meetings: [1, 2, 3, 4, 5].map((dow) => ({
          id: `m-${dow}`,
          dayOfWeek: dow,
          startSection: 1,
          endSection: 2,
          weeks: [1, 2, 3, 4],
          location: '明理楼 A101',
          teacher: '张老师',
        })),
      },
    ],
  };
}

describe('Orbit 扩展称号系统（15 个新增称号 + 课表联动与兜底）', () => {
  // 2026-09-16 为周三（第 2 周），prevWeek1 = 2026-09-07（第 1 周周一）
  const now = new Date(shanghaiDayStartMs('2026-09-16', 20, 0));
  const prevWeekKey = '2026-09-07';
  const curWeekKey = '2026-09-14';
  const oldCreatedAt = new Date(shanghaiDayStartMs('2026-08-01', 0, 0));

  test('称号目录共包含 26 项（11 原有 + 15 新增）且提出人与称号表对齐', () => {
    expect(TITLE_CATALOG.length).toBe(26);
    const byId = new Map(TITLE_CATALOG.map((t) => [t.id, t]));
    expect(byId.get('punch-god')?.proposer).toBe('李子佳');
    expect(byId.get('good-student')?.proposer).toBe('匡思进');
    expect(byId.get('almost-perfect')?.proposer).toBe('牛闻举');
    expect(byId.get('dragon-king')?.proposer).toBe('牛闻举');
    expect(byId.get('gamble-king')?.proposer).toBe('钟晨彬');
    expect(byId.get('quit-gambling')?.proposer).toBe('钟晨彬');
    expect(byId.get('almost-gone')?.proposer).toBe('曾权军');
    expect(byId.get('contributor-king')?.proposer).toBe('曾权军');
    expect(byId.get('lancer-luck-e')?.proposer).toBe('曾权军');
    expect(byId.get('card-collector')?.proposer).toBe('曾权军');
    expect(byId.get('collection-king')?.proposer).toBe('曾权军');
    expect(byId.get('most-honest')?.proposer).toBe('林佳政');
    expect(byId.get('mcgrady-time')?.proposer).toBe('陈昱璋');
    expect(byId.get('low-stamina')?.proposer).toBe('陈昱璋');
    expect(byId.get('uneasy')?.proposer).toBe('陈昱璋');
  });

  test('差一步美满：与周考核结算一致采用综合时长，并按年级目标自适应（25 级 27-28h，24 级 37-38h）', () => {
    // u25: 25级（目标 28h），上周综合时长 27.5h -> 解锁
    // u25_ent: 25级，上周纯打卡 25h + 卡牌娱乐 +2.5h = 综合 27.5h -> 解锁（与结算一致）
    // u25_full: 25级，纯打卡 27.5h + 卡牌娱乐 +1h = 综合 28.5h（已达标）-> 不解锁
    // u24: 24级（目标 38h），上周综合 37.5h -> 解锁
    // u24_low: 24级，上周综合 27.5h -> 不解锁
    const sessions: TitleEngineSession[] = [];
    const prevDays = [
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ];
    // u25 & u25_full: 每天 3.5h * 7 = 24.5h，再加 3h = 27.5h
    for (const d of prevDays) {
      sessions.push(makeSession('u25', d, prevWeekKey, 10, 0, 210));
      sessions.push(makeSession('u25_full', d, prevWeekKey, 10, 0, 210));
    }
    sessions.push(makeSession('u25', '2026-09-07', prevWeekKey, 15, 0, 180));
    sessions.push(makeSession('u25_full', '2026-09-07', prevWeekKey, 15, 0, 180));

    // u25_ent: 纯打卡 25h（7*3h + 4h）+ 娱乐 2.5h = 综合 27.5h
    for (const d of prevDays) {
      sessions.push(makeSession('u25_ent', d, prevWeekKey, 10, 0, 180));
    }
    sessions.push(makeSession('u25_ent', '2026-09-07', prevWeekKey, 15, 0, 240));

    // u24: 纯打卡 37.5h（每天 2 场：4h + 1.5h = 5.5h * 6 = 33h，第 7 天 4.5h）
    for (const d of prevDays.slice(0, 6)) {
      sessions.push(makeSession('u24', d, prevWeekKey, 9, 0, 240));
      sessions.push(makeSession('u24', d, prevWeekKey, 14, 0, 90));
    }
    sessions.push(makeSession('u24', '2026-09-13', prevWeekKey, 9, 0, 270));

    // u24_low: 27.5h
    for (const d of prevDays) {
      sessions.push(makeSession('u24_low', d, prevWeekKey, 10, 0, 210));
    }
    sessions.push(makeSession('u24_low', '2026-09-07', prevWeekKey, 15, 0, 180));

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'u25', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u25_ent', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u25_full', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u24', enrollYear: 2024, createdAt: oldCreatedAt },
        { id: 'u24_low', enrollYear: 2024, createdAt: oldCreatedAt },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map([
        ['u25_ent:2026-09-07', 9000],
        ['u25_full:2026-09-07', 3600],
      ]),
      currentWeekCardInteractions: [],
    });

    const isUnlocked = (uid: string) =>
      res.get(uid)?.catalog.find((c) => c.id === 'almost-perfect')?.unlocked;
    expect(isUnlocked('u25')).toBe(true);
    expect(isUnlocked('u25_ent')).toBe(true);
    expect(isUnlocked('u25_full')).toBe(false);
    expect(isUnlocked('u24')).toBe(true);
    expect(isUnlocked('u24_low')).toBe(false);
  });

  test('赌王（5 连胜长期保留可隐藏）与求求你戒赌吧（5 连败永久强制亮牌、不可手动关闭、下次赌赢即解除）', () => {
    const winReceipts = [1, 2, 3, 4, 5].map((i) =>
      extractGambleEventFromReceipt({
        actorId: 'winner',
        at: new Date(shanghaiDayStartMs('2026-09-10', 10 + i, 0)).toISOString(),
        result: {
          action: 'use',
          actionCard: { id: 'card-03', name: '我赌你的枪里没有子弹' },
          effects: [
            { kind: 'judgement', detail: '自身判定幸运，获得 30 分钟加成' },
            { kind: 'time', deltaSeconds: 1800 },
          ],
        },
      })!,
    );
    const loseReceipts = [1, 2, 3, 4, 5].map((i) =>
      extractGambleEventFromReceipt({
        actorId: 'loser',
        at: new Date(shanghaiDayStartMs('2026-09-10', 10 + i, 0)).toISOString(),
        result: {
          action: 'use',
          actionCard: { id: 'n-gamble', name: '我赌你的枪里没有子弹' },
          effects: [
            // 即使被仁王盾挡掉扣时（deltaSeconds=0），判定仍算失败
            { kind: 'judgement', detail: '自身判定为不利结果，先结算适用防御' },
            { kind: 'time', deltaSeconds: 0 },
          ],
        },
      })!,
    );
    // 5 连败后第 6 次赌赢 -> 应自动解除「求求你戒赌吧」
    const redeemedEvents = [
      ...loseReceipts.map((r) => r.event),
      extractGambleEventFromReceipt({
        actorId: 'redeemed',
        at: new Date(shanghaiDayStartMs('2026-09-15', 16, 0)).toISOString(),
        result: {
          action: 'use',
          actionCard: { id: 'n-gamble', name: '我赌你的枪里没有子弹' },
          effects: [
            { kind: 'judgement', detail: '自身判定幸运，获得 30 分钟加成' },
            { kind: 'time', deltaSeconds: 1800 },
          ],
        },
      })!.event,
    ];

    const gambleEventsByUser = new Map([
      ['winner', winReceipts.map((r) => r.event)],
      ['loser', loseReceipts.map((r) => r.event)],
      ['redeemed', redeemedEvents],
    ]);

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'winner', enrollYear: 2025, createdAt: oldCreatedAt },
        {
          id: 'winner_hidden',
          enrollYear: 2025,
          createdAt: oldCreatedAt,
          persistentTitleIds: ['gamble-king'],
          hiddenTitleIds: ['gamble-king'],
        },
        {
          id: 'loser',
          enrollYear: 2025,
          createdAt: oldCreatedAt,
          // 即使历史数据里带了 hiddenTitleIds，由于求求你戒赌吧不可隐藏，仍必须强制亮牌
          hiddenTitleIds: ['quit-gambling'],
        },
        { id: 'redeemed', enrollYear: 2025, createdAt: oldCreatedAt },
      ],
      sessions: [],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
      gambleEventsByUser,
    });

    expect(res.get('winner')?.catalog.find((c) => c.id === 'gamble-king')?.unlocked).toBe(true);
    expect(res.get('winner')?.newlyUnlockedPersistentTitleIds).toContain('gamble-king');
    expect(res.get('winner_hidden')?.catalog.find((c) => c.id === 'gamble-king')?.hidden).toBe(true);
    expect(res.get('winner_hidden')?.displayTitles.some((t) => t.id === 'gamble-king')).toBe(false);

    // 5 连败未赢过 -> 永久强制亮牌且不写入 persistentTitleIds（以便赌赢即解除）
    expect(res.get('loser')?.catalog.find((c) => c.id === 'quit-gambling')?.unlocked).toBe(true);
    expect(res.get('loser')?.displayTitles.some((t) => t.id === 'quit-gambling')).toBe(true);
    expect(res.get('loser')?.newlyUnlockedPersistentTitleIds).not.toContain('quit-gambling');

    // 5 连败后赢 1 把 -> 立刻解除「求求你戒赌吧」
    expect(res.get('redeemed')?.catalog.find((c) => c.id === 'quit-gambling')?.unlocked).toBe(false);
    expect(res.get('redeemed')?.displayTitles.some((t) => t.id === 'quit-gambling')).toBe(false);
  });

  test('龙王：获得吕洞宾后成功对施害者施加负面效果才解锁（被阻挡不算成功）', () => {
    const t1 = new Date(shanghaiDayStartMs('2026-09-15', 10, 0)).toISOString();
    const t2 = new Date(shanghaiDayStartMs('2026-09-15', 11, 0)).toISOString();
    const t3 = new Date(shanghaiDayStartMs('2026-09-15', 12, 0)).toISOString();
    const t4 = new Date(shanghaiDayStartMs('2026-09-15', 13, 0)).toISOString();

    const baseEvents = [
      // A 先给 B 加时（正面）
      ...extractCardInteractionsFromReceipt({
        actorId: 'A',
        at: t1,
        result: {
          action: 'use',
          actionCard: { name: '加时卡' },
          effects: [{ target: { id: 'B' }, kind: 'time', deltaSeconds: 1800, outcome: 'applied' }],
        },
      }),
      // B 反手对 A 扣时（负面）-> A 获得吕洞宾
      ...extractCardInteractionsFromReceipt({
        actorId: 'B',
        at: t2,
        result: {
          action: 'use',
          actionCard: { name: '红桃 K' },
          effects: [{ target: { id: 'A' }, kind: 'time', deltaSeconds: -1800, outcome: 'applied' }],
        },
      }),
      // A 反击 B 但被无懈可击阻挡（outcome: blocked）-> 尚不算成功
      ...extractCardInteractionsFromReceipt({
        actorId: 'A',
        at: t3,
        result: {
          action: 'use',
          actionCard: { name: '红桃 K' },
          effects: [{ target: { id: 'B' }, kind: 'time', deltaSeconds: 0, outcome: 'blocked' }],
        },
      }),
    ];

    const resBlocked = evaluateTeamTitles({
      now,
      members: [
        { id: 'A', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'B', enrollYear: 2025, createdAt: oldCreatedAt },
      ],
      sessions: [],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: baseEvents,
    });
    expect(resBlocked.get('A')?.catalog.find((c) => c.id === 'lu-dongbin')?.unlocked).toBe(true);
    expect(resBlocked.get('A')?.catalog.find((c) => c.id === 'dragon-king')?.unlocked).toBe(false);

    // A 再次对 B 使用负面卡且成功生效（applied）-> 解锁龙王
    const withRevenge = [
      ...baseEvents,
      ...extractCardInteractionsFromReceipt({
        actorId: 'A',
        at: t4,
        result: {
          action: 'use',
          actionCard: { name: '乐不思蜀' },
          effects: [{ target: { id: 'B' }, kind: 'status', outcome: 'applied' }],
        },
      }),
    ];
    const resSuccess = evaluateTeamTitles({
      now,
      members: [
        { id: 'A', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'B', enrollYear: 2025, createdAt: oldCreatedAt },
      ],
      sessions: [],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: withRevenge,
    });
    expect(resSuccess.get('A')?.catalog.find((c) => c.id === 'dragon-king')?.unlocked).toBe(true);
  });

  test('快思了、自古枪兵幸运e、收集者、收集之王、贡献王、神', () => {
    // 构造 3 个连续版本的合并 PR 归属
    const releases = attributeMergedPrsToReleases(
      [
        { tagName: 'v0.2.2', publishedAt: new Date('2026-07-01T00:00:00Z') },
        { tagName: 'v0.2.3', publishedAt: new Date('2026-08-01T00:00:00Z') },
        { tagName: 'v0.2.4', publishedAt: new Date('2026-09-01T00:00:00Z') },
      ],
      [
        { mergedAt: new Date('2026-06-20T00:00:00Z'), authorLogin: 'AliceDev' },
        { mergedAt: new Date('2026-07-15T00:00:00Z'), authorLogin: 'alicedev' },
        { mergedAt: new Date('2026-08-20T00:00:00Z'), authorLogin: 'ALICEDEV' },
      ],
    );

    expect(
      hasSsrPityInReceipt({
        actorId: 'u_hero',
        result: { action: 'draw', ssrPity: true },
      }),
    ).toBe(true);

    // u_god 上周纯打卡 51h（每天 3 场，共 17 场 * 3h = 51h）
    const godSessions: TitleEngineSession[] = [];
    const prevDays = [
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ];
    for (const d of prevDays.slice(0, 6)) {
      godSessions.push(makeSession('u_god', d, prevWeekKey, 8, 0, 180));
      godSessions.push(makeSession('u_god', d, prevWeekKey, 13, 0, 180));
      godSessions.push(makeSession('u_god', d, prevWeekKey, 18, 0, 150));
    }
    // 6 * 8.5h = 51h

    // u_fake_god 纯打卡 48h + 娱乐 5h = 53h -> 不解锁神
    const fakeGodSessions: TitleEngineSession[] = [];
    for (const d of prevDays.slice(0, 6)) {
      fakeGodSessions.push(makeSession('u_fake_god', d, prevWeekKey, 8, 0, 240));
      fakeGodSessions.push(makeSession('u_fake_god', d, prevWeekKey, 14, 0, 240));
    }

    const res = evaluateTeamTitles({
      now,
      members: [
        {
          id: 'u_hero',
          enrollYear: 2025,
          createdAt: oldCreatedAt,
          githubUsername: 'alicedev',
          discoveredCardCount: 21,
        },
        {
          id: 'u_collector',
          enrollYear: 2025,
          createdAt: oldCreatedAt,
          discoveredCardCount: 5,
        },
        {
          id: 'u_newbie',
          enrollYear: 2025,
          createdAt: new Date(shanghaiDayStartMs('2026-09-15', 0, 0)),
        },
        { id: 'u_god', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u_fake_god', enrollYear: 2025, createdAt: oldCreatedAt },
      ],
      sessions: [...godSessions, ...fakeGodSessions],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map([['u_fake_god:2026-09-07', 5 * 3600]]),
      currentWeekCardInteractions: [],
      ssrPityUsers: new Set(['u_hero']),
      releaseContributors: releases,
      totalCatalogCards: 21,
    });

    // 快思了：u_hero 上周 0 打卡且非新人 -> 触发强制亮牌；u_newbie 本周新人 -> 不触发
    expect(res.get('u_hero')?.catalog.find((c) => c.id === 'almost-gone')?.unlocked).toBe(true);
    expect(res.get('u_hero')?.displayTitles.some((t) => t.id === 'almost-gone')).toBe(true);
    expect(res.get('u_newbie')?.catalog.find((c) => c.id === 'almost-gone')?.unlocked).toBe(false);

    // 贡献王、自古枪兵幸运e、收集者、收集之王
    expect(res.get('u_hero')?.catalog.find((c) => c.id === 'contributor-king')?.unlocked).toBe(true);
    expect(res.get('u_hero')?.catalog.find((c) => c.id === 'lancer-luck-e')?.unlocked).toBe(true);
    expect(res.get('u_hero')?.catalog.find((c) => c.id === 'card-collector')?.unlocked).toBe(true);
    expect(res.get('u_hero')?.catalog.find((c) => c.id === 'collection-king')?.unlocked).toBe(true);

    expect(res.get('u_collector')?.catalog.find((c) => c.id === 'card-collector')?.unlocked).toBe(
      true,
    );
    expect(res.get('u_collector')?.catalog.find((c) => c.id === 'collection-king')?.unlocked).toBe(
      false,
    );

    // 神：仅纯真实打卡 > 50h 才解锁
    expect(res.get('u_god')?.catalog.find((c) => c.id === 'punch-god')?.unlocked).toBe(true);
    expect(res.get('u_fake_god')?.catalog.find((c) => c.id === 'punch-god')?.unlocked).toBe(false);
  });

  test('最老实之人：个人课表精准模式 + 同年级课表兜底 + 标准教学时段兜底', () => {
    const sched = makeWeekdayMorningSchedule();
    const prevWeekdays = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

    // 1. personal_ok: 有个人课表（周一至周五 08:00-09:35），每天 08:00-09:00 打卡 60 分钟 -> 解锁
    // 2. peer_2: 同年级另一名导入课表的同学（用于凑齐 ≥2 人的同年级课表兜底样本）
    // 3. grade_fallback_ok: 2025 级未导入课表，但每天 08:00-09:00 在同年级高频课节次打卡 -> 命中同年级兜底解锁
    // 4. std_fallback_ok: 2024 级全年级无人导课表，每天 09:00-11:00（白昼教学时段 120 分钟 ≥ 90 分钟）-> 命中标准作息兜底解锁
    // 5. std_night_only: 2024 级未导课表，仅每晚 19:30-22:00 打卡 -> 不解锁
    const sessions: TitleEngineSession[] = [];
    for (const d of prevWeekdays) {
      sessions.push(makeSession('personal_ok', d, prevWeekKey, 8, 0, 60));
      sessions.push(makeSession('grade_fallback_ok', d, prevWeekKey, 8, 0, 60));
      sessions.push(makeSession('std_fallback_ok', d, prevWeekKey, 9, 0, 120));
      sessions.push(makeSession('std_night_only', d, prevWeekKey, 19, 30, 150));
    }

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'personal_ok', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
        { id: 'peer_2', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
        { id: 'grade_fallback_ok', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: null },
        { id: 'std_fallback_ok', enrollYear: 2024, createdAt: oldCreatedAt, scheduleSnapshot: null },
        { id: 'std_night_only', enrollYear: 2024, createdAt: oldCreatedAt, scheduleSnapshot: null },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
    });

    const getHonest = (uid: string) => res.get(uid)?.catalog.find((c) => c.id === 'most-honest');
    expect(getHonest('personal_ok')?.unlocked).toBe(true);
    expect(getHonest('grade_fallback_ok')?.unlocked).toBe(true);
    expect(getHonest('grade_fallback_ok')?.progressText).toContain('同年级课表兜底');
    expect(getHonest('std_fallback_ok')?.unlocked).toBe(true);
    expect(getHonest('std_fallback_ok')?.progressText).toContain('标准教学时段兜底');
    expect(getHonest('std_night_only')?.unlocked).toBe(false);
  });

  test('三好学生：上周有效打卡且上课期间从不打卡（含个人课表、标准兜底与零打卡排除）', () => {
    const sched = makeWeekdayMorningSchedule();
    const sessions: TitleEngineSession[] = [
      // personal_good: 有个人课表（08:00-09:35），上周只在 19:00-21:00 打卡 -> 解锁三好学生
      makeSession('personal_good', '2026-09-08', prevWeekKey, 19, 0, 120),
      // personal_bad: 有个人课表（08:00-09:35），上周在 08:30-09:30 上课期间打了卡 -> 不解锁
      makeSession('personal_bad', '2026-09-08', prevWeekKey, 8, 30, 60),
      // std_good: 未导课表且无同年级样本，上周只在 19:30-21:30 晚间打卡 -> 命中标准兜底且课中零打卡 -> 解锁
      makeSession('std_good', '2026-09-09', prevWeekKey, 19, 30, 120),
      // zero_punch: 上周完全没打卡 -> 不应误拿三好学生
    ];

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'personal_good', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
        { id: 'personal_bad', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
        { id: 'std_good', enrollYear: 2024, createdAt: oldCreatedAt, scheduleSnapshot: null },
        { id: 'zero_punch', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
    });

    const getGood = (uid: string) => res.get(uid)?.catalog.find((c) => c.id === 'good-student');
    expect(getGood('personal_good')?.unlocked).toBe(true);
    expect(getGood('personal_bad')?.unlocked).toBe(false);
    expect(getGood('std_good')?.unlocked).toBe(true);
    expect(getGood('std_good')?.progressText).toContain('标准教学时段兜底');
    expect(getGood('zero_punch')?.unlocked).toBe(false);
  });

  test('回归 P1-3：雷电被无懈可击阻挡或反弹时跳过 judgement 过程项，不误解锁龙王', () => {
    const t1 = new Date(shanghaiDayStartMs('2026-09-15', 10, 0)).toISOString();
    const t2 = new Date(shanghaiDayStartMs('2026-09-15', 11, 0)).toISOString();
    const t3 = new Date(shanghaiDayStartMs('2026-09-15', 12, 0)).toISOString();
    const t4 = new Date(shanghaiDayStartMs('2026-09-15', 13, 0)).toISOString();

    const blockedLightning = [
      ...extractCardInteractionsFromReceipt({
        actorId: 'A',
        at: t1,
        result: {
          action: 'use',
          actionCard: { name: '加时卡' },
          effects: [{ target: { id: 'B' }, kind: 'time', deltaSeconds: 1800, outcome: 'applied' }],
        },
      }),
      ...extractCardInteractionsFromReceipt({
        actorId: 'B',
        at: t2,
        result: {
          action: 'use',
          actionCard: { name: '红桃 K' },
          effects: [{ target: { id: 'A' }, kind: 'time', deltaSeconds: -1800, outcome: 'applied' }],
        },
      }),
      // 雷电判定命中但被目标无懈可击阻挡 / 反弹
      ...extractCardInteractionsFromReceipt({
        actorId: 'A',
        at: t3,
        result: {
          action: 'use',
          actionCard: { id: 'sr-lightning', name: '雷电' },
          effects: [
            { target: { id: 'B' }, kind: 'judgement', outcome: 'applied' },
            { target: { id: 'B' }, kind: 'time', deltaSeconds: 0, outcome: 'blocked' },
          ],
        },
      }),
      ...extractCardInteractionsFromReceipt({
        actorId: 'A',
        at: t4,
        result: {
          action: 'use',
          actionCard: { id: 'sr-lightning', name: '雷电' },
          effects: [
            { target: { id: 'B' }, kind: 'judgement', outcome: 'applied' },
            { target: { id: 'B' }, kind: 'time', deltaSeconds: 0, outcome: 'reflected' },
          ],
        },
      }),
    ];

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'A', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'B', enrollYear: 2025, createdAt: oldCreatedAt },
      ],
      sessions: [],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: blockedLightning,
    });
    expect(res.get('A')?.catalog.find((c) => c.id === 'lu-dongbin')?.unlocked).toBe(true);
    expect(res.get('A')?.catalog.find((c) => c.id === 'dragon-king')?.unlocked).toBe(false);
  });

  test('回归 P1-4：寒暑假/结课周不穿透标准兜底，且本周有课日 < 3 天时最老实之人可正常解锁', () => {
    const sched = makeWeekdayMorningSchedule();

    // 1. 寒假（2027-02-03，超过第 20 周）：已导个人课表与同年级 ≥ 2 人课表均不应穿透到 standard-fallback
    const winterNow = new Date(shanghaiDayStartMs('2027-02-03', 20, 0));
    const winterPrevDays = ['2027-01-25', '2027-01-26', '2027-01-27', '2027-01-28', '2027-01-29'];
    const winterSessions: TitleEngineSession[] = [];
    for (const d of winterPrevDays) {
      winterSessions.push(makeSession('personal_vac', d, '2027-01-25', 9, 0, 120));
      winterSessions.push(makeSession('grade_vac', d, '2027-01-25', 9, 0, 120));
    }
    const winterRes = evaluateTeamTitles({
      now: winterNow,
      members: [
        { id: 'personal_vac', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
        { id: 'peer_vac', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: sched },
        { id: 'grade_vac', enrollYear: 2025, createdAt: oldCreatedAt, scheduleSnapshot: null },
      ],
      sessions: winterSessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
    });
    expect(winterRes.get('personal_vac')?.catalog.find((c) => c.id === 'most-honest')?.unlocked).toBe(false);
    expect(winterRes.get('personal_vac')?.catalog.find((c) => c.id === 'good-student')?.unlocked).toBe(false);
    expect(winterRes.get('personal_vac')?.catalog.find((c) => c.id === 'most-honest')?.progressText).not.toContain('未导课表');
    expect(winterRes.get('grade_vac')?.catalog.find((c) => c.id === 'most-honest')?.unlocked).toBe(false);
    expect(winterRes.get('grade_vac')?.catalog.find((c) => c.id === 'most-honest')?.progressText).not.toContain('标准教学时段兜底');

    // 2. 本周仅 2 天有课（大三课少场景），本周两天都在课中猛猛打卡应正常解锁「最老实之人」
    const twoDaySched: BusyScheduleSnapshot = {
      ...sched,
      courses: [
        {
          id: 'c_junior',
          name: '编译原理',
          color: '#6366F1',
          meetings: [1, 3].map((dow) => ({
            id: `jm-${dow}`,
            dayOfWeek: dow,
            startSection: 1,
            endSection: 2,
            weeks: [2],
            location: '明理楼 B201',
            teacher: '李老师',
          })),
        },
      ],
    };
    const twoDayRes = evaluateTeamTitles({
      now,
      members: [{ id: 'junior', enrollYear: 2023, createdAt: oldCreatedAt, scheduleSnapshot: twoDaySched }],
      sessions: [
        makeSession('junior', '2026-09-14', curWeekKey, 8, 0, 60),
        makeSession('junior', '2026-09-16', curWeekKey, 8, 0, 60),
      ],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
    });
    expect(twoDayRes.get('junior')?.catalog.find((c) => c.id === 'most-honest')?.unlocked).toBe(true);
  });

  test('回归 P1-5：attributeMergedPrsToReleases 严格遵守历史下界，GitHubContributorSyncService 按 repo 隔离查询', async () => {
    const windows = attributeMergedPrsToReleases(
      [
        { tagName: 'v0.2.3', publishedAt: new Date('2026-08-01T00:00:00Z') },
        { tagName: 'v0.2.4', publishedAt: new Date('2026-09-01T00:00:00Z') },
      ],
      [
        { mergedAt: new Date('2026-06-15T00:00:00Z'), authorLogin: 'ancient_dev' },
        { mergedAt: new Date('2026-07-15T00:00:00Z'), authorLogin: 'current_dev' },
      ],
      { earliestLowerBoundExclusive: new Date('2026-07-01T00:00:00Z') },
    );
    expect(windows[0]!.contributorLogins).toEqual(['current_dev']);

    const findCalls: unknown[] = [];
    const mockReleaseRepo = {
      find: async (opts: unknown) => {
        findCalls.push(opts);
        return [];
      },
      query: async () => [],
    };
    const syncSvc = new GitHubContributorSyncService(
      mockReleaseRepo as never,
      { nodeEnv: 'test', orbitGithubRepo: 'lec-org/lec-orbit' } as never,
    );
    await syncSvc.listReleaseContributors();
    expect(findCalls[0]).toEqual({
      where: { repo: 'lec-org/lec-orbit' },
      order: { publishedAt: 'ASC' },
    });
  });

  test('回归 P0-1 / P1-2 / P2-6：称号服务单列原子持久化、SQL 下推、single-flight 与显隐资格校验', async () => {
    let userSaveCalls = 0;
    let userFindCalls = 0;
    let cardArchiveFindCalls = 0;
    const userQueries: Array<{ sql: string; params: unknown[] }> = [];
    const archiveQueries: Array<{ sql: string; params: unknown[] }> = [];

    const mockMember = {
      id: 'u1',
      teamId: 'team-1',
      logtoUserId: 'sso-u1',
      enrollYear: 2025,
      status: 'active',
      createdAt: oldCreatedAt,
      equippedTitleId: null as string | null,
      persistentTitleIds: [] as string[],
      hiddenTitleIds: [] as string[],
    };

    const mockUserRepo = {
      find: async () => {
        userFindCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return [{ ...mockMember }];
      },
      save: async () => {
        userSaveCalls += 1;
        return [];
      },
      query: async (sql: string, params: unknown[]) => {
        userQueries.push({ sql, params });
        if (sql.includes('RETURNING')) {
          return [{ equippedTitleId: 'card-collector', hiddenTitleIds: [] }];
        }
        return [];
      },
    };

    const mockCardActionRepo = {
      find: async () => {
        cardArchiveFindCalls += 1;
        return [];
      },
      query: async (sql: string, params: unknown[]) => {
        archiveQueries.push({ sql, params });
        return [];
      },
    };

    const achievementInserts: Array<{ sql: string; params: unknown[] }> = [];
    const mockAchievementRepo = {
      find: async () => [],
      query: async (sql: string, params: unknown[]) => {
        achievementInserts.push({ sql, params });
        return [];
      },
    };

    const svc = new PunchTitlesService(
      mockUserRepo as never,
      { find: async () => [] } as never,
      { query: async () => [] } as never,
      {
        findOne: async () => ({
          state: { members: { u1: { discovered: ['c1', 'c2', 'c3', 'c4', 'c5'] } } },
          receipts: {},
        }),
      } as never,
      { find: async () => [] } as never,
      mockCardActionRepo as never,
      { find: async () => [] } as never,
      { find: async () => [] } as never,
      mockAchievementRepo as never,
      { getMemberKey: (id: string) => id } as never,
      { getWeeklyTradeMinutesSummary: async () => ({ items: [], affectsAssessment: false }) } as never,
      { listReleaseContributors: async () => [] } as never,
    );

    // 1. 并发两次读触发 single-flight：仅执行 1 次团队查询，且通过原子 SQL（非 userRepo.save）持久化新解锁长期称号与成就记录
    await Promise.all([
      svc.getTeamDisplayTitlesByUserId('team-1'),
      svc.getTeamDisplayTitlesByUserId('team-1'),
    ]);
    expect(userFindCalls).toBe(1);
    expect(userSaveCalls).toBe(0);
    expect(cardArchiveFindCalls).toBe(0);
    expect(archiveQueries.length).toBe(3);
    expect(userQueries.some((q) => q.sql.includes('SET persistent_title_ids'))).toBe(true);
    expect(
      achievementInserts.some(
        (q) =>
          q.sql.includes('INSERT INTO punch_title_achievements') &&
          q.sql.includes('ON CONFLICT (team_id, user_id, title_id, occurrence_key) DO NOTHING'),
      ),
    ).toBe(true);

    // 2. equipTitle 仅做 1 次团队快照重算，不调用 userRepo.save
    userFindCalls = 0;
    const equipRes = await svc.equipTitle('team-1', 'u1', 'card-collector');
    expect(userFindCalls).toBe(1);
    expect(userSaveCalls).toBe(0);
    expect(equipRes.equippedTitleId).toBe('card-collector');

    // 3. setTitleVisibility 禁止对未解锁称号提前关闭展示，也禁止非近三级成员操作
    await expect(svc.setTitleVisibility('team-1', 'u1', 'collection-king', true)).rejects.toThrow(
      '尚未解锁',
    );
    await expect(svc.setTitleVisibility('team-1', 'non-eligible', 'card-collector', true)).rejects.toThrow(
      '仅大一至大三',
    );
  });

  test('新增 3 项称号：McGrady Time（≥35h 纯打卡）、体力不支（上周有效打卡垫底）与感到不安（落后上一名 >5h）', () => {
    const prevDays = [
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ];
    const sessions: TitleEngineSession[] = [];
    // u_tmac: 上周纯打卡 35h（7 天 × 5h = 35h）-> 解锁 McGrady Time，排第 1（不触发感到不安 / 体力不支）
    for (const d of prevDays) {
      sessions.push(makeSession('u_tmac', d, prevWeekKey, 8, 0, 180));
      sessions.push(makeSession('u_tmac', d, prevWeekKey, 14, 0, 120));
    }
    // u_mid: 上周纯打卡 28h（7 天 × 4h = 28h），落后 u_tmac 7h (> 5h) -> 解锁感到不安，不解锁 McGrady Time
    for (const d of prevDays) {
      sessions.push(makeSession('u_mid', d, prevWeekKey, 9, 0, 240));
    }
    // u_close: 上周纯打卡 24h（6 天 × 4h = 24h），落后 u_mid 4h (<= 5h) -> 不解锁感到不安，不垫底
    for (const d of prevDays.slice(0, 6)) {
      sessions.push(makeSession('u_close', d, prevWeekKey, 9, 0, 240));
    }
    // u_low: 上周纯打卡 6h（2 天 × 3h = 6h），垫底且落后 u_close 18h -> 同时触发「体力不支」（强制亮牌）与「感到不安」
    sessions.push(makeSession('u_low', '2026-09-07', prevWeekKey, 9, 0, 180));
    sessions.push(makeSession('u_low', '2026-09-08', prevWeekKey, 9, 0, 180));
    // u_zero: 上周 0 打卡 -> 触发「快思了」，不触发「体力不支」

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'u_tmac', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u_mid', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u_close', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u_low', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'u_zero', enrollYear: 2025, createdAt: oldCreatedAt },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map([['u_mid:2026-09-07', 0]]),
      currentWeekCardInteractions: [],
    });

    const unlocked = (uid: string, titleId: string) =>
      res.get(uid)?.catalog.find((c) => c.id === titleId)?.unlocked;

    expect(unlocked('u_tmac', 'mcgrady-time')).toBe(true);
    expect(unlocked('u_tmac', 'uneasy')).toBe(false);
    expect(unlocked('u_tmac', 'low-stamina')).toBe(false);

    expect(unlocked('u_mid', 'mcgrady-time')).toBe(false);
    expect(unlocked('u_mid', 'uneasy')).toBe(true);
    expect(unlocked('u_mid', 'low-stamina')).toBe(false);

    expect(unlocked('u_close', 'uneasy')).toBe(false);
    expect(unlocked('u_close', 'low-stamina')).toBe(false);

    expect(unlocked('u_low', 'low-stamina')).toBe(true);
    expect(res.get('u_low')?.displayTitles.some((t) => t.id === 'low-stamina')).toBe(true);
    expect(unlocked('u_low', 'uneasy')).toBe(true);

    expect(unlocked('u_zero', 'almost-gone')).toBe(true);
    expect(unlocked('u_zero', 'low-stamina')).toBe(false);
  });

  test('成就升阶体系（方案 A 6 进制：星→月→日→冠）与全量幂等累计去重', () => {
    // 1. 校验 6 进制升阶进位：1=解锁、2=1星、6=5星、7=1月亮、37=1太阳、217=1皇冠
    expect(formatTitleTierText(computeTitleAchievementTier(1))).toBe('基础解锁');
    expect(formatTitleTierText(computeTitleAchievementTier(2))).toBe('1 星');
    expect(formatTitleTierText(computeTitleAchievementTier(6))).toBe('5 星');
    expect(formatTitleTierText(computeTitleAchievementTier(7))).toBe('1 月亮');
    expect(formatTitleTierText(computeTitleAchievementTier(37))).toBe('1 太阳');
    expect(formatTitleTierText(computeTitleAchievementTier(217))).toBe('1 皇冠');
    expect(computeTitleAchievementTier(5, false).points).toBe(0);

    // 2. 校验连续 3 天不重叠段切分：3/4/5 天均只计 1 段，6/7 天计 2 段
    expect(
      extractNonOverlappingStreakKeys(new Set(['2026-09-01', '2026-09-02']), 3),
    ).toEqual([]);
    expect(
      extractNonOverlappingStreakKeys(
        new Set(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']),
        3,
      ),
    ).toEqual(['streak:2026-09-03']);
    expect(
      extractNonOverlappingStreakKeys(
        new Set([
          '2026-09-01',
          '2026-09-02',
          '2026-09-03',
          '2026-09-04',
          '2026-09-05',
          '2026-09-06',
          '2026-09-07',
        ]),
        3,
      ),
    ).toEqual(['streak:2026-09-03', 'streak:2026-09-06']);

    // 3. 校验「求求你戒赌吧」两轮 5 连败（中间夹 1 赢）累计 2 次 = 1 星，且历史紫蛋周次叠加不重复
    const baseMs = shanghaiDayStartMs('2026-09-01', 10, 0);
    const twoRoundLosses = [
      // 第 1 轮 5 连败
      ...[0, 1, 2, 3, 4].map((i) => ({ atMs: baseMs + i * 60_000, won: false })),
      // 赌赢 1 次（解除亮牌）
      { atMs: baseMs + 10 * 60_000, won: true },
      // 第 2 轮 5 连败（再次强制亮牌，累计 2 次 -> 1 星）
      ...[11, 12, 13, 14, 15].map((i) => ({ atMs: baseMs + i * 60_000, won: false })),
    ];

    const existingKeys = new Map<string, Map<string, Set<string>>>([
      [
        'u_tier',
        new Map<string, Set<string>>([
          // 历史上已挂过 5 周紫蛋（加上本次上周未达标 week:2026-09-07 共 6 次 -> 5 星）
          [
            'purple-egg',
            new Set([
              'week:2026-07-06',
              'week:2026-07-13',
              'week:2026-07-20',
              'week:2026-07-27',
              'week:2026-08-03',
            ]),
          ],
          // 历史上已有 1 条相同周次键（验证幂等不重复）
          ['almost-gone', new Set([`week:${prevWeekKey}`])],
        ]),
      ],
    ]);

    const res = evaluateTeamTitles({
      now,
      members: [
        {
          id: 'u_tier',
          enrollYear: 2025,
          createdAt: oldCreatedAt,
          discoveredCardCount: 21,
        },
      ],
      sessions: [],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
      gambleEventsByUser: new Map([['u_tier', twoRoundLosses]]),
      ssrPityReceiptKeysByUser: new Map([['u_tier', ['rk1', 'rk2', 'rk3']]]),
      existingAchievementKeysByUser: existingKeys,
    });

    const evalRes = res.get('u_tier')!;
    const itemOf = (id: string) => evalRes.catalog.find((c) => c.id === id)!;

    // 求求你戒赌吧：2 轮 5 连败 -> 累计 2 次（1 星）且亮牌自带 unlockCount=2
    expect(itemOf('quit-gambling').unlocked).toBe(true);
    expect(itemOf('quit-gambling').unlockCount).toBe(2);
    expect(
      evalRes.displayTitles.find((t) => t.id === 'quit-gambling')?.unlockCount,
    ).toBe(2);

    // 想吃紫蛋了：5 条历史 + 1 条本周结算 = 6 次（5 星）
    expect(itemOf('purple-egg').unlockCount).toBe(6);
    expect(
      evalRes.newAchievementRecords.some(
        (r) => r.titleId === 'purple-egg' && r.occurrenceKey === `week:${prevWeekKey}`,
      ),
    ).toBe(true);

    // 快思了：已存在 week:2026-09-07 -> 幂等不重复写入，仍为 1 次
    expect(itemOf('almost-gone').unlockCount).toBe(1);
    expect(
      evalRes.newAchievementRecords.some((r) => r.titleId === 'almost-gone'),
    ).toBe(false);

    // 自古枪兵幸运e：3 次独立大保底回执 -> 累计 3 次（2 星）
    expect(itemOf('lancer-luck-e').unlockCount).toBe(3);

    // 收集者 / 收集之王：一次性里程碑 stackable=false，固定为 1 次
    expect(itemOf('card-collector').stackable).toBe(false);
    expect(itemOf('card-collector').unlockCount).toBe(1);
    expect(itemOf('collection-king').stackable).toBe(false);
    expect(itemOf('collection-king').unlockCount).toBe(1);

    // 全目录 26 项中恰有 24 项可升阶、2 项一次性
    expect(TITLE_CATALOG.filter((t) => t.stackable).length).toBe(24);
    expect(TITLE_CATALOG.filter((t) => !t.stackable).length).toBe(2);
  });
});
