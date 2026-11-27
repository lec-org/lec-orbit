import { describe, expect, test } from 'bun:test';
import type { BusyScheduleSnapshot } from '../src/modules/calendar/entities/member-busy-snapshot.entity.js';
import { attributeMergedPrsToReleases } from '../src/modules/punch/github-contributor-sync.service.js';
import { TITLE_CATALOG } from '../src/modules/punch/punch-title-catalog.js';
import {
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  extractGambleEventFromReceipt,
  hasSsrPityInReceipt,
  shanghaiDayStartMs,
  type TitleEngineSession,
} from '../src/modules/punch/punch-title-engine.js';

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

describe('Orbit 扩展称号系统（11 个新增称号 + 课表联动与兜底）', () => {
  // 2026-09-16 为周三（第 2 周），prevWeek1 = 2026-09-07（第 1 周周一）
  const now = new Date(shanghaiDayStartMs('2026-09-16', 20, 0));
  const prevWeekKey = '2026-09-07';
  const curWeekKey = '2026-09-14';
  const oldCreatedAt = new Date(shanghaiDayStartMs('2026-08-01', 0, 0));

  test('称号目录共包含 23 项（11 原有 + 12 新增）', () => {
    expect(TITLE_CATALOG.length).toBe(23);
  });

  test('差一步美满：按年级目标自适应且仅计算纯真实打卡（25 级 27-28h，24 级 37-38h）', () => {
    // u25: 25级（目标 28h），上周纯打卡 27.5h（9*3h + 0.5h）-> 解锁
    // u25_ent: 25级，上周纯打卡 25h + 卡牌娱乐 +2.5h = 27.5h -> 不解锁
    // u24: 24级（目标 38h），上周纯打卡 37.5h -> 解锁
    // u24_low: 24级，上周纯打卡 27.5h -> 不解锁
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
    // u25: 每天 3.5h * 7 = 24.5h，再加 3h = 27.5h
    for (const d of prevDays) {
      sessions.push(makeSession('u25', d, prevWeekKey, 10, 0, 210));
    }
    sessions.push(makeSession('u25', '2026-09-07', prevWeekKey, 15, 0, 180));

    // u25_ent: 纯打卡 25h（7*3h + 4h）+ 娱乐 2.5h
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
        { id: 'u24', enrollYear: 2024, createdAt: oldCreatedAt },
        { id: 'u24_low', enrollYear: 2024, createdAt: oldCreatedAt },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map([['u25_ent:2026-09-07', 9000]]),
      currentWeekCardInteractions: [],
    });

    const isUnlocked = (uid: string) =>
      res.get(uid)?.catalog.find((c) => c.id === 'almost-perfect')?.unlocked;
    expect(isUnlocked('u25')).toBe(true);
    expect(isUnlocked('u25_ent')).toBe(false);
    expect(isUnlocked('u24')).toBe(true);
    expect(isUnlocked('u24_low')).toBe(false);
  });

  test('赌王、求求你戒赌吧（自动强制亮牌 + 长期保留 + 可手动关闭）', () => {
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

    const gambleEventsByUser = new Map([
      ['winner', winReceipts.map((r) => r.event)],
      ['loser', loseReceipts.map((r) => r.event)],
    ]);

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'winner', enrollYear: 2025, createdAt: oldCreatedAt },
        { id: 'loser', enrollYear: 2025, createdAt: oldCreatedAt },
        {
          id: 'loser_hidden',
          enrollYear: 2025,
          createdAt: oldCreatedAt,
          persistentTitleIds: ['quit-gambling'],
          hiddenTitleIds: ['quit-gambling'],
        },
      ],
      sessions: [],
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
      gambleEventsByUser,
    });

    expect(res.get('winner')?.catalog.find((c) => c.id === 'gamble-king')?.unlocked).toBe(true);
    expect(res.get('winner')?.newlyUnlockedPersistentTitleIds).toContain('gamble-king');

    expect(res.get('loser')?.catalog.find((c) => c.id === 'quit-gambling')?.unlocked).toBe(true);
    // 默认打开且 forced: true -> 出现在 displayTitles 中
    expect(res.get('loser')?.displayTitles.some((t) => t.id === 'quit-gambling')).toBe(true);

    // 长期保留，但成员主动关闭展示后不出现在 displayTitles 中
    const hiddenItem = res.get('loser_hidden')?.catalog.find((c) => c.id === 'quit-gambling');
    expect(hiddenItem?.unlocked).toBe(true);
    expect(hiddenItem?.hidden).toBe(true);
    expect(res.get('loser_hidden')?.displayTitles.some((t) => t.id === 'quit-gambling')).toBe(
      false,
    );
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
});
