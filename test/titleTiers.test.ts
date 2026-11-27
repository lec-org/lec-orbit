import { describe, expect, it } from 'bun:test';
import {
  TITLE_TIER_BASE,
  computeTitleAchievementTier,
  formatTitleTierText,
} from '../src/shared/punch';

describe('称号成就升阶纯函数（标准 5 进制：逢 5 进 1，星→月→日→冠）', () => {
  it('准确计算未解锁、基础解锁、1–4 星、月亮、太阳、皇冠全部关键进位边界', () => {
    expect(TITLE_TIER_BASE).toBe(5);

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
    expect(t2).toMatchObject({
      crowns: 0,
      suns: 0,
      moons: 0,
      stars: 1,
      nextMajorTierLabel: '1 月亮',
      nextMajorTierCount: 6,
    });
    expect(formatTitleTierText(t2)).toBe('1 星');

    // 第 5 次：4 星
    const t5 = computeTitleAchievementTier(5);
    expect(t5).toMatchObject({ crowns: 0, suns: 0, moons: 0, stars: 4 });
    expect(formatTitleTierText(t5)).toBe('4 星');

    // 第 6 次：逢 5 进 1 -> 1 月亮
    const t6 = computeTitleAchievementTier(6);
    expect(t6).toMatchObject({
      crowns: 0,
      suns: 0,
      moons: 1,
      stars: 0,
      nextMajorTierLabel: '1 太阳',
      nextMajorTierCount: 26,
    });
    expect(formatTitleTierText(t6)).toBe('1 月亮');

    // 第 10 次：1 月亮 4 星；第 11 次：2 月亮
    expect(formatTitleTierText(computeTitleAchievementTier(10))).toBe('1 月亮 4 星');
    expect(formatTitleTierText(computeTitleAchievementTier(11))).toBe('2 月亮');

    // 第 25 次：4 月亮 4 星；第 26 次：逢 5 月亮进 1 -> 1 太阳
    expect(formatTitleTierText(computeTitleAchievementTier(25))).toBe('4 月亮 4 星');
    const t26 = computeTitleAchievementTier(26);
    expect(t26).toMatchObject({
      crowns: 0,
      suns: 1,
      moons: 0,
      stars: 0,
      nextMajorTierLabel: '1 皇冠',
      nextMajorTierCount: 126,
    });
    expect(formatTitleTierText(t26)).toBe('1 太阳');

    // 第 125 次：4 太阳 4 月亮 4 星；第 126 次：逢 5 太阳进 1 -> 1 皇冠
    expect(formatTitleTierText(computeTitleAchievementTier(125))).toBe('4 太阳 4 月亮 4 星');
    const t126 = computeTitleAchievementTier(126);
    expect(t126).toMatchObject({
      crowns: 1,
      suns: 0,
      moons: 0,
      stars: 0,
      nextMajorTierLabel: '2 皇冠',
      nextMajorTierCount: 251,
    });
    expect(formatTitleTierText(t126)).toBe('1 皇冠');
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
