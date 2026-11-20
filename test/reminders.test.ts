import { describe, expect, test } from 'bun:test';
import {
  BREAK_REMINDER_SECONDS,
  CHECKOUT_URGENT_SECONDS,
  CHECKOUT_WARN_SECONDS,
  evaluateFocusReminder,
} from '../src/shared/reminders';

describe('evaluateFocusReminder', () => {
  const base = {
    now: new Date(2026, 10, 20, 14, 0, 0), // Friday 14:00 local
    authenticated: true,
    remindersEnabled: true,
    isCheckedIn: true,
    sessionKey: 'sess-1',
    elapsedSeconds: 0,
    weekTotalSeconds: 10 * 3600,
    weekTargetSeconds: 28 * 3600,
    weekKey: '2026-W47',
  };

  test('关闭提醒或未登录时不触发', () => {
    expect(
      evaluateFocusReminder({ ...base, remindersEnabled: false, elapsedSeconds: CHECKOUT_URGENT_SECONDS, sentKeys: new Set() }),
    ).toBeNull();
    expect(
      evaluateFocusReminder({ ...base, authenticated: false, elapsedSeconds: CHECKOUT_URGENT_SECONDS, sentKeys: new Set() }),
    ).toBeNull();
  });

  test('按 2h / 4h15m / 4h45m 阶梯去重触发签退与休息提醒', () => {
    const sent = new Set<string>();
    expect(evaluateFocusReminder({ ...base, elapsedSeconds: 3600, sentKeys: sent })).toBeNull();

    const r1 = evaluateFocusReminder({ ...base, elapsedSeconds: BREAK_REMINDER_SECONDS, sentKeys: sent });
    expect(r1?.key).toBe('session:sess-1:break');
    sent.add(r1!.key);
    expect(evaluateFocusReminder({ ...base, elapsedSeconds: BREAK_REMINDER_SECONDS + 300, sentKeys: sent })).toBeNull();

    const r2 = evaluateFocusReminder({ ...base, elapsedSeconds: CHECKOUT_WARN_SECONDS, sentKeys: sent });
    expect(r2?.key).toBe('session:sess-1:warn');
    expect(r2?.tone).toBe('warning');
    sent.add(r2!.key);

    const r3 = evaluateFocusReminder({ ...base, elapsedSeconds: CHECKOUT_URGENT_SECONDS, sentKeys: sent });
    expect(r3?.key).toBe('session:sess-1:urgent');
    sent.add(r3!.key);
    expect(evaluateFocusReminder({ ...base, elapsedSeconds: CHECKOUT_URGENT_SECONDS + 120, sentKeys: sent })).toBeNull();
  });

  test('周末白天未在岗且未达标时触发一次周考核提醒', () => {
    const sent = new Set<string>();
    const sat = new Date(2026, 10, 21, 11, 0, 0); // Saturday 11:00 local
    const r = evaluateFocusReminder({
      ...base,
      now: sat,
      isCheckedIn: false,
      weekTotalSeconds: 20 * 3600,
      weekTargetSeconds: 28 * 3600,
      sentKeys: sent,
    });
    expect(r?.key).toBe('weekend:2026-W47');
    expect(r?.body).toContain('8 小时');
    sent.add(r!.key);
    expect(
      evaluateFocusReminder({
        ...base,
        now: sat,
        isCheckedIn: false,
        weekTotalSeconds: 20 * 3600,
        weekTargetSeconds: 28 * 3600,
        sentKeys: sent,
      }),
    ).toBeNull();
  });
});
