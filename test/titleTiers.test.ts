import { describe, expect, it } from 'bun:test';
import {
  TITLE_TIER_BASE,
  computeTitleAchievementTier,
  formatTitleTierText,
} from '../src/shared/punch';

describe('称号成就升阶纯函数（方案 A：满 5 后第 6 次进位，星→月→日→冠）', () => {
  it('准确计算未解锁、基础解锁、1–5 星、月亮、太阳、皇冠全部关键进位边界', () => {
    expect(TITLE_TIER_BASE).toBe(6);

    // 0 次：未解锁
    const t0 = computeTitleAchievementTier(0);
    expect(t0).toMatchObject({ count: 0, points: 0, crowns: 0, suns: 0, moons: 0, stars: 0 });
    expect(formatTitleTierText(t0)).toBe('未解锁');

    // 第 1 次：基础解锁
    const t1 = computeTitleAchievementTier(1);
    expect(t1).toMatchObject({
      count: 1,
      points: 0,
      crowns: 0,
      suns: 0,
      moons: 0,
      stars: 0,
      nextMajorTierLabel: '1 星',
      nextMajorTierCount: 2,
    });
    expect(formatTitleTierText(t1)).toBe('基础解锁');

    // 第 2 次：1 星
    const t2 = computeTitleAchievementTier(2);
    expect(t2).toMatchObject({ crowns: 0, suns: 0, moons: 0, stars: 1, nextMajorTierLabel: '1 月亮', nextMajorTierCount: 7 });
    expect(formatTitleTierText(t2)).toBe('1 星');

    // 第 6 次：5 星
    const t6 = computeTitleAchievementTier(6);
    expect(t6).toMatchObject({ crowns: 0, suns: 0, moons: 0, stars: 5 });
    expect(formatTitleTierText(t6)).toBe('5 星');

    // 第 7 次：满 5 星后再达成 1 次 -> 1 月亮
    const t7 = computeTitleAchievementTier(7);
    expect(t7).toMatchObject({ crowns: 0, suns: 0, moons: 1, stars: 0, nextMajorTierLabel: '1 太阳', nextMajorTierCount: 37 });
    expect(formatTitleTierText(t7)).toBe('1 月亮');

    // 第 12 次：1 月亮 5 星；第 13 次：2 月亮
    expect(formatTitleTierText(computeTitleAchievementTier(12))).toBe('1 月亮 5 星');
    expect(formatTitleTierText(computeTitleAchievementTier(13))).toBe('2 月亮');

    // 第 36 次：5 月亮 5 星；第 37 次：满 5 月亮后再达成 -> 1 太阳
    expect(formatTitleTierText(computeTitleAchievementTier(36))).toBe('5 月亮 5 星');
    const t37 = computeTitleAchievementTier(37);
    expect(t37).toMatchObject({ crowns: 0, suns: 1, moons: 0, stars: 0, nextMajorTierLabel: '1 皇冠', nextMajorTierCount: 217 });
    expect(formatTitleTierText(t37)).toBe('1 太阳');

    // 第 216 次：5 太阳 5 月亮 5 星；第 217 次：满 5 太阳后再达成 -> 1 皇冠
    expect(formatTitleTierText(computeTitleAchievementTier(216))).toBe('5 太阳 5 月亮 5 星');
    const t217 = computeTitleAchievementTier(217);
    expect(t217).toMatchObject({ crowns: 1, suns: 0, moons: 0, stars: 0, nextMajorTierLabel: '2 皇冠', nextMajorTierCount: 433 });
    expect(formatTitleTierText(t217)).toBe('1 皇冠');
  });

  it('一次性图鉴里程碑（stackable=false）不累计升星', () => {
    const t = computeTitleAchievementTier(10, false);
    expect(t).toMatchObject({
      count: 1,
      points: 0,
      crowns: 0,
      suns: 0,
      moons: 0,
      stars: 0,
      nextMajorTierLabel: null,
      nextMajorTierCount: null,
    });
    expect(formatTitleTierText(t)).toBe('基础解锁');
  });
});
