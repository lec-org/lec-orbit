/**
 * 多人日程忙闲冲突检测与共同空闲时段推荐纯函数（无 DOM / React 依赖，前后端与单测共享）。
 */

export interface FreeBusyTimeBlock {
  allDay: boolean;
  startTime: string;
  endTime: string;
  status: 'accepted' | 'tentative' | 'declined';
}

export interface FreeBusyMemberLike {
  blocks: readonly FreeBusyTimeBlock[];
}

export function parseHmToMinutes(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return 9 * 60;
  return Math.max(0, Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])));
}

export function formatMinutesToHm(total: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(total)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 计算指定成员在选定时段 [startMin, endMin) 是否与任何非谢绝忙碌块冲突。 */
export function hasConflictInRange(
  blocks: readonly FreeBusyTimeBlock[],
  startMin: number,
  endMin: number,
  allDay: boolean,
): boolean {
  if (blocks.length === 0) return false;
  for (const b of blocks) {
    if (b.status === 'declined') continue;
    if (allDay || b.allDay) return true;
    const bs = parseHmToMinutes(b.startTime);
    const be = Math.max(bs + 5, parseHmToMinutes(b.endTime));
    if (bs < endMin && startMin < be) {
      return true;
    }
  }
  return false;
}

/** 扫描当天 08:00–22:00（兼顾整半点与课程/日程结束边界），返回最多 maxCount 个与所有可见参与人无冲突的推荐空闲时段。 */
export function findCommonFreeSlots(
  members: readonly FreeBusyMemberLike[],
  durationMinutes: number,
  maxCount = 3,
): Array<{ startTime: string; endTime: string }> {
  if (maxCount <= 0) return [];
  const safeDuration = Math.max(30, Math.min(8 * 60, durationMinutes || 60));
  const dayStart = 8 * 60;
  const dayEnd = 22 * 60;
  const step = 30;
  const candidateSet = new Set<number>();

  for (let t = dayStart; t + safeDuration <= dayEnd; t += step) {
    candidateSet.add(t);
  }
  // 将每位成员忙碌块结束时刻纳入候选起点，避免漏掉如 09:40–10:40 等非整半点课间空闲
  for (const m of members) {
    for (const b of m.blocks) {
      if (b.status === 'declined' || b.allDay) continue;
      const bs = parseHmToMinutes(b.startTime);
      const be = Math.max(bs + 5, parseHmToMinutes(b.endTime));
      if (be >= dayStart && be + safeDuration <= dayEnd) {
        candidateSet.add(be);
      }
    }
  }

  const candidates = Array.from(candidateSet).sort((a, b) => a - b);
  const results: Array<{ startTime: string; endTime: string }> = [];

  for (const start of candidates) {
    const end = start + safeDuration;
    const busy = members.some((m) => hasConflictInRange(m.blocks, start, end, false));
    if (!busy) {
      const prev = results[results.length - 1];
      if (prev && parseHmToMinutes(prev.endTime) > start) {
        continue;
      }
      results.push({
        startTime: formatMinutesToHm(start),
        endTime: formatMinutesToHm(end),
      });
      if (results.length >= maxCount) break;
    }
  }
  return results;
}
