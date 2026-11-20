/**
 * 轻柔专注提醒引擎（纯函数决策器，方便单测与跨平台复用）：
 * 1. 连续专注满 2 小时 -> 轻柔久坐/饮水提醒；
 * 2. 连续专注满 4 小时 15 分 -> 防忘签退提醒（LecPunch 单次超过 5 小时将判定无效）；
 * 3. 连续专注满 4 小时 45 分 -> 临近 5 小时上限紧急提醒；
 * 4. 周六/周日 10:00~22:00 未在岗且本周未达标 -> 周末考核冲刺提醒（每周一次）。
 */
import { formatReadableDuration } from './punch';

export const BREAK_REMINDER_SECONDS = 2 * 3600;
export const CHECKOUT_WARN_SECONDS = 4 * 3600 + 15 * 60;
export const CHECKOUT_URGENT_SECONDS = 4 * 3600 + 45 * 60;

export interface FocusReminderInput {
  now: Date;
  authenticated: boolean;
  remindersEnabled: boolean;
  isCheckedIn: boolean;
  sessionKey?: string | null;
  elapsedSeconds: number;
  weekTotalSeconds: number;
  weekTargetSeconds: number;
  weekKey: string;
  sentKeys: ReadonlySet<string>;
}

export interface FocusReminderNotice {
  key: string;
  title: string;
  body: string;
  tone: 'info' | 'warning';
}

export function evaluateFocusReminder(input: FocusReminderInput): FocusReminderNotice | null {
  if (!input.authenticated || !input.remindersEnabled) return null;

  if (input.isCheckedIn) {
    const sid = input.sessionKey?.trim() || 'active-session';
    const elapsed = Math.max(0, Math.floor(input.elapsedSeconds));

    if (elapsed >= CHECKOUT_URGENT_SECONDS) {
      const key = `session:${sid}:urgent`;
      if (!input.sentKeys.has(key)) {
        return {
          key,
          title: '即将达到单次 5 小时上限',
          body: '本次专注已超过 4 小时 45 分，超过 5 小时系统将判定无效，请尽快签退保存时长！',
          tone: 'warning',
        };
      }
      return null;
    }

    if (elapsed >= CHECKOUT_WARN_SECONDS) {
      const key = `session:${sid}:warn`;
      if (!input.sentKeys.has(key)) {
        return {
          key,
          title: '记得适时签退保存时长',
          body: '本次专注已满 4 小时 15 分，单次超过 5 小时将无法计入考核，建议近期签退休息。',
          tone: 'warning',
        };
      }
      return null;
    }

    if (elapsed >= BREAK_REMINDER_SECONDS) {
      const key = `session:${sid}:break`;
      if (!input.sentKeys.has(key)) {
        return {
          key,
          title: '已连续专注 2 小时',
          body: '起身活动一下、眺望远处或喝口水，保持好状态再继续吧。',
          tone: 'info',
        };
      }
      return null;
    }

    return null;
  }

  // 未在岗时：周六/周日白天若本周尚未达标，每周轻柔提醒一次
  const day = input.now.getDay();
  const hour = input.now.getHours();
  const isWeekend = day === 0 || day === 6;
  const remaining = Math.max(0, Math.floor(input.weekTargetSeconds - input.weekTotalSeconds));
  if (isWeekend && hour >= 10 && hour < 22 && input.weekTargetSeconds > 0 && remaining > 0) {
    const key = `weekend:${input.weekKey}`;
    if (!input.sentKeys.has(key)) {
      return {
        key,
        title: '本周考核进度提醒',
        body: `本周考核还差 ${formatReadableDuration(remaining)} 达标，记得安排时间到工作室打卡哦。`,
        tone: 'info',
      };
    }
  }

  return null;
}
