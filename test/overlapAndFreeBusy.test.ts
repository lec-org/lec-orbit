import { describe, expect, it } from 'bun:test';
import {
  layoutDayTimedEvents,
  layoutOverlappingIntervals,
} from '../../../packages/liquidglass/src/internal/schedule-utils';
import {
  findCommonFreeSlots,
  hasConflictInRange,
  type FreeBusyMemberLike,
} from '../src/shared/freeBusy';

describe('多任务重叠避让与多人共同空闲算法', () => {
  it('紧邻但不重叠的短日程不应被误判为并发分列', () => {
    const map = layoutDayTimedEvents([
      { id: 'a', startMinutes: 14 * 60, endMinutes: 14 * 60 + 15 },
      { id: 'b', startMinutes: 14 * 60 + 15, endMinutes: 14 * 60 + 30 },
    ]);
    expect(map.get('a')?.columnCount).toBe(1);
    expect(map.get('b')?.columnCount).toBe(1);
    expect(map.get('a')?.widthPercent).toBe(100);
    expect(map.get('b')?.widthPercent).toBe(100);
  });

  it('在 3 列聚类中，右侧无冲突的事件应自动向右扩张 colSpan 消除空白洞', () => {
    const map = layoutOverlappingIntervals([
      { id: 'A', start: 14 * 60, end: 17 * 60 },
      { id: 'B', start: 14 * 60, end: 15 * 60 },
      { id: 'C', start: 14 * 60, end: 15 * 60 },
      { id: 'D', start: 15 * 60 + 30, end: 17 * 60 },
    ]);
    expect(map.get('A')?.columnCount).toBe(3);
    expect(map.get('D')?.column).toBe(1);
    expect(map.get('D')?.colSpan).toBe(2);
    expect(map.get('D')?.widthPercent).toBeCloseTo(66.67, 1);
  });

  it('高并发 3 列同时重叠时，非末列适度阶梯微叠且 zIndex 递增', () => {
    const map = layoutOverlappingIntervals([
      { id: 'e1', start: 10 * 60, end: 12 * 60 },
      { id: 'e2', start: 10 * 60, end: 11 * 60 },
      { id: 'e3', start: 10 * 60 + 15, end: 11 * 60 + 30 },
    ]);
    const b1 = map.get('e1')!;
    const b2 = map.get('e2')!;
    const b3 = map.get('e3')!;
    expect(b1.columnCount).toBe(3);
    expect(b1.widthPercent).toBeGreaterThan(100 / 3);
    expect(b2.zIndex).toBeGreaterThan(b1.zIndex);
    expect(b3.zIndex).toBeGreaterThan(b2.zIndex);
    expect(b3.leftPercent + b3.widthPercent).toBeLessThanOrEqual(100.01);
  });

  it('能正确检测多人冲突并推荐全员共同空闲时段', () => {
    const members: FreeBusyMemberLike[] = [
      {
        blocks: [
          {
            allDay: false,
            startTime: '08:00',
            endTime: '09:40',
            status: 'accepted',
          },
          {
            allDay: false,
            startTime: '10:00',
            endTime: '11:00',
            status: 'declined',
          },
        ],
      },
      {
        blocks: [
          {
            allDay: false,
            startTime: '09:00',
            endTime: '10:00',
            status: 'accepted',
          },
        ],
      },
    ];

    expect(hasConflictInRange(members[0]!.blocks, 8 * 60 + 30, 9 * 60 + 30, false)).toBe(true);
    expect(hasConflictInRange(members[0]!.blocks, 10 * 60, 11 * 60, false)).toBe(false);

    const slots = findCommonFreeSlots(members, 60, 2);
    expect(slots[0]).toEqual({ startTime: '10:00', endTime: '11:00' });
    expect(slots[1]).toEqual({ startTime: '11:00', endTime: '12:00' });
  });
});
