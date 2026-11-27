import { describe, expect, it } from 'bun:test';
import { hasFeverOverlap } from '../src/modules/punch/punch-points.service.js';
import {
  assessmentEnrollYears,
  comprehensiveDurationSeconds,
  mondayKeyToIsoWeek,
  parseIsoWeekToMondayKey,
  signMemberKey,
  verifyMemberKey,
  weeklyGoalSeconds,
} from '../src/modules/punch/punch-shared.util.js';
import { CARD_CATALOG } from '../src/modules/punch/punch-cards.service.js';
import {
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  TITLE_CATALOG,
} from '../src/modules/punch/punch-titles.service.js';
import {
  shanghaiWeekKeyOfMs,
  type TitleEngineSession,
} from '../src/modules/punch/punch-title-engine.js';

function shDate(isoWithoutOffset: string): Date {
  return new Date(`${isoWithoutOffset}+08:00`);
}

function makeTitleSession(userId: string, startIso: string, hours: number): TitleEngineSession {
  const start = shDate(startIso);
  const durationSeconds = Math.round(hours * 3600);
  const end = new Date(start.getTime() + durationSeconds * 1000);
  return {
    userId,
    checkInAt: start,
    checkOutAt: end,
    durationSeconds,
    status: 'completed',
    weekKey: shanghaiWeekKeyOfMs(start.getTime()),
  };
}

describe('LecPunch 融合模块核心规则与狂热时段判定', () => {
  it('狂热打卡扫描线：同时在岗达 12 人且重叠 >=1ms 触发狂热，11 人或零重叠不触发', () => {
    const start = new Date(0);
    const end = new Date(660_000);
    const buildRows = (count: number, overlapMs: number) => [
      { checkInAt: start, checkOutAt: end },
      ...Array.from({ length: count - 1 }, () => ({
        checkInAt: start,
        checkOutAt: new Date(1000),
      })),
      { checkInAt: new Date(1000 - overlapMs), checkOutAt: end },
    ];

    // 11 个早期成员 + 1 个新成员重叠 1ms => 共 12 人同时在岗 -> 狂热生效
    expect(hasFeverOverlap({ start, end }, buildRows(11, 1))).toBe(true);
    // 仅 10 + 1 = 11 人 -> 不触发
    expect(hasFeverOverlap({ start, end }, buildRows(10, 1))).toBe(false);
    // 11 个在 1000ms 签退，第 12 个恰好 1000ms 上卡（0ms 重叠）-> 不触发
    expect(hasFeverOverlap({ start, end }, buildRows(11, 0))).toBe(false);
  });

  it('综合时长、周目标与近三届（大一至大三）考核年级判定准确', () => {
    expect(weeklyGoalSeconds(2025)).toBe(28 * 3600);
    expect(weeklyGoalSeconds(2024)).toBe(38 * 3600);
    expect(comprehensiveDurationSeconds(3600, 600, -1800)).toBe(2400);
    expect(() => comprehensiveDurationSeconds(-1, 0, 0)).toThrow();
    expect(assessmentEnrollYears([2022, 2023, 2024, 2025])).toEqual([2025, 2024, 2023]);
  });

  it('ISO 周与周一日期互相转换一致，memberKey 签名防篡改', () => {
    expect(parseIsoWeekToMondayKey('2026-W48')).toBe('2026-11-23');
    expect(mondayKeyToIsoWeek('2026-11-23')).toBe('2026-W48');

    const key = signMemberKey('6a0000000000000000000011', 'test-secret');
    expect(verifyMemberKey(key, 'test-secret')).toBe('6a0000000000000000000011');
    expect(verifyMemberKey(key + 'x', 'test-secret')).toBeNull();
  });

  it('卡池（21 张）与称号目录（23 项）定义完整无重复 ID', () => {
    expect(CARD_CATALOG).toHaveLength(21);
    expect(new Set(CARD_CATALOG.map((c) => c.id)).size).toBe(21);
    expect(TITLE_CATALOG).toHaveLength(23);
    expect(new Set(TITLE_CATALOG.map((t) => t.id)).size).toBe(23);
    const ids = new Set(TITLE_CATALOG.map((t) => t.id));
    for (const expectedId of [
      'punch-star',
      'monthly-perfect',
      'general-jin',
      'legend-allnighter',
      'weekly-perfect',
      'good-student',
      'deadline-master',
      'lu-dongbin',
      'early-bird',
      'night-owl',
      'lovesick',
      'purple-egg',
      'punch-god',
      'contributor-king',
      'collection-king',
      'gamble-king',
      'most-honest',
      'dragon-king',
      'almost-perfect',
      'lancer-luck-e',
      'card-collector',
      'quit-gambling',
      'almost-gone',
    ]) {
      expect(ids.has(expectedId)).toBe(true);
    }
  });

  it('称号引擎正确判定打卡之星、早起鸟、夜猫子、传奇耐通王与佩戴优先级', () => {
    const now = shDate('2026-11-21T15:00:00');
    const sessions: TitleEngineSession[] = [
      makeTitleSession('alice', '2026-11-19T08:00:00', 3),
      makeTitleSession('alice', '2026-11-19T19:00:00', 3),
      makeTitleSession('alice', '2026-11-20T08:15:00', 3),
      makeTitleSession('alice', '2026-11-20T20:00:00', 2),
      makeTitleSession('alice', '2026-11-21T08:30:00', 3),
      makeTitleSession('alice', '2026-11-21T21:10:00', 2),
      makeTitleSession('bob', '2026-11-19T01:00:00', 4.5),
      makeTitleSession('bob', '2026-11-20T01:00:00', 4.5),
      makeTitleSession('bob', '2026-11-21T01:00:00', 4.5),
    ];

    const res = evaluateTeamTitles({
      now,
      members: [
        {
          id: 'alice',
          enrollYear: 2025,
          createdAt: shDate('2026-09-01T00:00:00'),
          equippedTitleId: 'early-bird',
        },
        { id: 'bob', enrollYear: 2025, createdAt: shDate('2026-09-01T00:00:00') },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: [],
    });

    const alice = res.get('alice')!;
    const aliceUnlocked = new Set(alice.catalog.filter((c) => c.unlocked).map((c) => c.id));
    expect(aliceUnlocked.has('punch-star')).toBe(true);
    expect(aliceUnlocked.has('early-bird')).toBe(true);
    expect(aliceUnlocked.has('night-owl')).toBe(true);
    expect(aliceUnlocked.has('legend-allnighter')).toBe(false);
    expect(alice.equippedTitleId).toBe('early-bird');
    expect(alice.displayTitles[0]?.id).toBe('early-bird');

    const bob = res.get('bob')!;
    const bobUnlocked = new Set(bob.catalog.filter((c) => c.unlocked).map((c) => c.id));
    expect(bobUnlocked.has('legend-allnighter')).toBe(true);
    expect(bobUnlocked.has('early-bird')).toBe(false);
    expect(bobUnlocked.has('punch-star')).toBe(false);
    expect(bob.displayTitles[0]?.id).toBe('legend-allnighter');
  });

  it('称号引擎正确判定全勤之星、全勤之王、金将军、卡点王、紫蛋、相思了与吕洞宾', () => {
    const now = shDate('2026-11-22T14:00:00');
    const sessions: TitleEngineSession[] = [];

    for (let day = 1; day <= 31; day += 1) {
      sessions.push(
        makeTitleSession('king', `2026-10-${String(day).padStart(2, '0')}T10:00:00`, 2),
      );
    }
    for (let day = 16; day <= 22; day += 1) {
      sessions.push(
        makeTitleSession('king', `2026-11-${String(day).padStart(2, '0')}T09:00:00`, 3),
      );
      sessions.push(
        makeTitleSession('king', `2026-11-${String(day).padStart(2, '0')}T14:00:00`, 3),
      );
    }

    const prev2WeekDays = [
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ];
    const prev1WeekDays = [
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ];
    for (const d of [...prev2WeekDays, ...prev1WeekDays]) {
      sessions.push(makeTitleSession('sniper', `${d}T10:00:00`, 4));
    }
    sessions.push(makeTitleSession('sniper', '2026-11-08T15:00:00', 0.5));
    sessions.push(makeTitleSession('sniper', '2026-11-15T15:00:00', 0.5));

    for (let day = 16; day <= 20; day += 1) {
      sessions.push(
        makeTitleSession('slacker', `2026-11-${String(day).padStart(2, '0')}T10:00:00`, 4),
      );
    }

    const interactions = [
      ...extractCardInteractionsFromReceipt({
        actorId: 'king',
        at: '2026-11-21T02:00:00.000Z',
        result: {
          action: 'use',
          actionCard: { id: 'card-05', name: '加时卡' },
          effects: [{ target: { id: 'slacker' }, kind: 'time', deltaSeconds: 1800 }],
        },
      }),
      ...extractCardInteractionsFromReceipt({
        actorId: 'slacker',
        at: '2026-11-21T04:00:00.000Z',
        result: {
          action: 'use',
          actionCard: { id: 'card-18', name: '红桃 K' },
          effects: [{ target: { id: 'king' }, kind: 'time', deltaSeconds: -1800 }],
        },
      }),
    ];

    const res = evaluateTeamTitles({
      now,
      members: [
        { id: 'king', enrollYear: 2026, createdAt: shDate('2026-09-01T00:00:00') },
        { id: 'sniper', enrollYear: 2026, createdAt: shDate('2026-09-01T00:00:00') },
        { id: 'slacker', enrollYear: 2026, createdAt: shDate('2026-09-01T00:00:00') },
        { id: 'newbie', enrollYear: 2026, createdAt: shDate('2026-11-20T10:00:00') },
      ],
      sessions,
      manualAdjustmentsByUserWeek: new Map(),
      entertainmentByUserWeek: new Map(),
      currentWeekCardInteractions: interactions,
    });

    const kingSet = new Set(res.get('king')!.catalog.filter((c) => c.unlocked).map((c) => c.id));
    expect(kingSet.has('monthly-perfect')).toBe(true);
    expect(kingSet.has('weekly-perfect')).toBe(true);
    expect(kingSet.has('general-jin')).toBe(true);
    expect(kingSet.has('lu-dongbin')).toBe(true);
    expect(kingSet.has('lovesick')).toBe(false);

    const sniperSet = new Set(res.get('sniper')!.catalog.filter((c) => c.unlocked).map((c) => c.id));
    expect(sniperSet.has('deadline-master')).toBe(true);
    expect(sniperSet.has('purple-egg')).toBe(false);

    const slackerIds = res.get('slacker')!.displayTitles.map((t) => t.id);
    expect(slackerIds).toContain('purple-egg');
    expect(slackerIds).toContain('lovesick');

    const newbieSet = new Set(res.get('newbie')!.catalog.filter((c) => c.unlocked).map((c) => c.id));
    expect(newbieSet.has('purple-egg')).toBe(false);
    expect(newbieSet.has('lovesick')).toBe(true);
  });
});
