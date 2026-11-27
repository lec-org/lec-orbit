import { describe, expect, it } from 'bun:test';
import { evaluateCalendarReminders, DEFAULT_STUDIO_CALENDAR_ID } from '../src/shared/calendar';
import { findCommonFreeSlots, sliceFreeBusyEventForDate } from '../src/shared/freeBusy';
import { parseIcsEvents } from '../src/shared/icsParser';
import { computeWeekFromStartDate, generateScheduleIcs, SWPU_CHENGDU_DEFAULT_SLOTS } from '../src/shared/schedule';
import { isPrivateOrReservedIp } from '../electron/schedule/ssrfGuard';
import { LocalDB } from '../electron/storage/localDb';

describe('PR #13 评审修复回归测试', () => {
  it('parseIcsEvents 对 1970 年高频 MINUTELY RRULE 在迭代上限内安全截断不冻死', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:dos-minutely@test',
      'DTSTART:19700101T000000Z',
      'DTEND:19700101T000500Z',
      'RRULE:FREQ=MINUTELY',
      'SUMMARY:恶意高频循环',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const startedAt = Date.now();
    const res = parseIcsEvents(ics, { referenceDate: new Date(2026, 10, 27) });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(res.entries.length).toBeLessThanOrEqual(260);
  });

  it('parseIcsEvents 正确关联 RECURRENCE-ID 改期实例，不保留原时间幽灵重复事件', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:weekly-sync@test',
      'DTSTART:20261102T100000',
      'DTEND:20261102T110000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:工作室周会',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:weekly-sync@test',
      'RECURRENCE-ID:20261109T100000',
      'DTSTART:20261109T150000',
      'DTEND:20261109T160000',
      'SUMMARY:工作室周会（改期）',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const res = parseIcsEvents(ics, { referenceDate: new Date(2026, 10, 1) });
    expect(res.entries.length).toBe(3);
    const nov9 = res.entries.filter((e) => e.startDate === '2026-11-09');
    expect(nov9.length).toBe(1);
    expect(nov9[0]!.startTime).toBe('15:00');
    expect(nov9[0]!.title).toBe('工作室周会（改期）');
  });

  it('evaluateCalendarReminders 跨天事件次日不误报且同分钟多条提醒全部返回', () => {
    const notices = evaluateCalendarReminders({
      now: new Date(2026, 10, 28, 10, 0, 0),
      events: [
        {
          id: 'cross-day',
          calendarId: 'cal_personal',
          title: '跨天黑客松',
          description: '',
          location: '',
          allDay: false,
          startDate: '2026-11-27',
          endDate: '2026-11-28',
          startTime: '10:00',
          endTime: '18:00',
          reminderMinutes: 15,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'today-1',
          calendarId: 'cal_personal',
          title: '例会 A',
          description: '',
          location: '',
          allDay: false,
          startDate: '2026-11-28',
          endDate: '2026-11-28',
          startTime: '10:00',
          endTime: '11:00',
          reminderMinutes: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'today-2',
          calendarId: 'cal_personal',
          title: '例会 B',
          description: '',
          location: '',
          allDay: false,
          startDate: '2026-11-28',
          endDate: '2026-11-28',
          startTime: '10:00',
          endTime: '11:00',
          reminderMinutes: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      tasks: [],
      sentKeys: new Set(),
    });

    expect(notices.map((n) => n.title)).toEqual(['日程开始：例会 A', '日程开始：例会 B']);
  });

  it('findCommonFreeSlots 支持非整半点课间空闲并在 maxCount <= 0 时返回空数组', () => {
    const members = [
      {
        blocks: [
          { allDay: false, startTime: '08:00', endTime: '09:40', status: 'accepted' as const },
          { allDay: false, startTime: '10:40', endTime: '22:00', status: 'accepted' as const },
        ],
      },
    ];
    expect(findCommonFreeSlots(members, 60, 0)).toEqual([]);
    expect(findCommonFreeSlots(members, 60, 2)).toEqual([{ startTime: '09:40', endTime: '10:40' }]);
  });

  it('computeWeekFromStartDate 与 generateScheduleIcs VTIMEZONE 正确工作', () => {
    expect(computeWeekFromStartDate('2026-03-02', new Date(2026, 2, 16), 1)).toBe(3);
    const ics = generateScheduleIcs({
      schedule: {
        id: 's1',
        name: '测试课表',
        termCode: '2026-1',
        timetableId: 'tt1',
        startDate: '2026-03-02',
        weekStartDay: 1,
        totalWeeks: 18,
        maxSections: 12,
        compactMode: false,
        reminderEnabled: true,
        reminderMinutes: 15,
        holidays: [],
        isActive: true,
        courseCount: 0,
        meetingCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      timetable: {
        id: 'tt1',
        name: '默认',
        fixedDurationEnabled: true,
        defaultDurationMinutes: 45,
        slots: SWPU_CHENGDU_DEFAULT_SLOTS,
        updatedAt: 1,
      },
      courses: [],
    });
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('TZID:Asia/Shanghai');
    expect(ics).toContain('END:VTIMEZONE');
  });

  it('parseIcsEvents 在单次 RECURRENCE-ID 改期至窗口外时不提前截断后续窗口内实例，并支持多年历史 DAILY 规则快进', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:rescheduled-far@test',
      'DTSTART:20261102T100000',
      'DTEND:20261102T110000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:每周站会',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:rescheduled-far@test',
      'RECURRENCE-ID:20261109T100000',
      'DTSTART:20320101T100000',
      'DTEND:20320101T110000',
      'SUMMARY:每周站会（延至窗口外）',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:old-daily@test',
      'DTSTART:20100101T083000',
      'DTEND:20100101T090000',
      'RRULE:FREQ=DAILY',
      'SUMMARY:长期晨会',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const res = parseIcsEvents(ics, { referenceDate: new Date(2026, 10, 1) });
    const standups = res.entries.filter((e) => e.uid.startsWith('rescheduled-far@test#'));
    expect(standups.map((e) => e.startDate)).toEqual(['2026-11-02', '2026-11-16']);

    const dailies = res.entries.filter((e) => e.uid.startsWith('old-daily@test#'));
    expect(dailies.length).toBeGreaterThan(0);
    expect(dailies[0]!.startDate >= '2025-01-01').toBe(true);
    expect(dailies[0]!.startTime).toBe('08:30');
  });

  it('sliceFreeBusyEventForDate 按首日/中间日/末日准确拆分跨天非全天日程', () => {
    const ev = {
      allDay: false,
      startDate: '2026-11-27',
      endDate: '2026-11-29',
      startTime: '14:00',
      endTime: '11:30',
    };
    expect(sliceFreeBusyEventForDate(ev, '2026-11-27')).toEqual({
      allDay: false,
      startTime: '14:00',
      endTime: '23:59',
    });
    expect(sliceFreeBusyEventForDate(ev, '2026-11-28')).toEqual({
      allDay: true,
      startTime: '00:00',
      endTime: '23:59',
    });
    expect(sliceFreeBusyEventForDate(ev, '2026-11-29')).toEqual({
      allDay: false,
      startTime: '00:00',
      endTime: '11:30',
    });
  });

  it('isPrivateOrReservedIp 准确拦截回环/私网/云元数据及 IPv6 变体绕过并放行公网 IP', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.10')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateOrReservedIp('::127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:0:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('2002:7f00:1::')).toBe(true);
    expect(isPrivateOrReservedIp('fec0::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('LocalDB 禁止删除内置 cal_studio、校验跨课表 courseId 并防止同课程与跨课程 meeting.id 冲突', () => {
    const db = new LocalDB('', ':memory:');
    const scope = 'campus:test_user';
    db.listCalendarCategories(scope);
    db.deleteCalendarCategory(scope, DEFAULT_STUDIO_CALENDAR_ID);
    expect(db.listCalendarCategories(scope).some((c) => c.id === DEFAULT_STUDIO_CALENDAR_ID)).toBe(true);

    const s1 = db.createSchedule(scope, { name: '课表 A', startDate: '2026-03-02' });
    const s2 = db.createSchedule(scope, { name: '课表 B', startDate: '2026-03-02' });
    const saved = db.upsertCourseWithMeetings(scope, {
      scheduleId: s1.id,
      name: '高数',
      meetings: [
        { id: 'dup_m', dayOfWeek: 1, startSection: 1, endSection: 2, weeks: [1, 2] },
        { id: 'dup_m', dayOfWeek: 3, startSection: 1, endSection: 2, weeks: [1, 2] },
      ],
    });
    expect(saved.meetings.length).toBe(2);
    expect(saved.meetings[0]!.id).not.toBe(saved.meetings[1]!.id);

    // 另一门课程传入已被高数占用的 meeting.id，应自动重生成且不覆盖高数原有排课
    const saved2 = db.upsertCourseWithMeetings(scope, {
      scheduleId: s1.id,
      name: '线代',
      meetings: [{ id: saved.meetings[0]!.id, dayOfWeek: 2, startSection: 3, endSection: 4, weeks: [1] }],
    });
    expect(saved2.meetings[0]!.id).not.toBe(saved.meetings[0]!.id);
    const detail = db.getScheduleDetail(scope, s1.id);
    const math = detail?.courses.find((c) => c.id === saved.id);
    expect(math?.meetings.length).toBe(2);

    expect(() =>
      db.upsertCourseWithMeetings(scope, {
        courseId: saved.id,
        scheduleId: s2.id,
        name: '篡改高数',
        meetings: [],
      }),
    ).toThrow();
    db.close();
  });
});
