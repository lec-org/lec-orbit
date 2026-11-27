import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDB } from '../electron/storage/localDb';
import {
  DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID,
  DEFAULT_PERSONAL_CALENDAR_ID,
  buildMonthGrid,
  evaluateCalendarReminder,
  eventCoversDate,
  expandCoursesForDate,
  layoutOverlappingBlocks,
} from '../src/shared/calendar';
import {
  convertHolidayCnDaysToEntries,
  normalizeSubscriptionUrl,
  parseIcsEvents,
} from '../src/shared/icsParser';

test('buildMonthGrid 生成完整 42 格月历并精准标出今日与星期', () => {
  const now = new Date(2026, 10, 27, 10, 0); // 2026-11-27 周五
  const grid = buildMonthGrid(2026, 11, 1, now);
  assert.equal(grid.length, 42);
  assert.equal(grid[0]?.dayOfWeek, 1); // 周一起始
  const todayCell = grid.find((c) => c.isToday);
  assert.equal(todayCell?.dateStr, '2026-11-27');
  assert.equal(todayCell?.dayOfWeek, 5);
});

test('layoutOverlappingBlocks 正确处理重叠冲突并排与独立块占满整列', () => {
  const layout = layoutOverlappingBlocks([
    { id: 'course', startMinutes: 9 * 60 + 50, endMinutes: 11 * 60 + 25 },
    { id: 'meeting', startMinutes: 10 * 60 + 30, endMinutes: 11 * 60 + 30 },
    { id: 'evening', startMinutes: 19 * 60, endMinutes: 20 * 60 },
  ]);
  assert.equal(layout.get('course')?.colCount, 2);
  assert.equal(layout.get('meeting')?.colCount, 2);
  assert.notEqual(layout.get('course')?.col, layout.get('meeting')?.col);
  assert.equal(layout.get('evening')?.colCount, 1);
  assert.equal(layout.get('evening')?.col, 0);
});

test('LocalDB v4 支持自定义日历、跨日日程、待办任务勾选与统一提醒决策', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-orbit-cal-'));
  const db = new LocalDB(dir);
  try {
    const scope = 'campus:cal-tester';
    const snap0 = db.getCalendarSnapshot(scope);
    assert.ok(snap0.categories.some((c) => c.id === DEFAULT_PERSONAL_CALENDAR_ID));

    const customCat = db.saveCalendarCategory(scope, { name: '竞赛项目', color: '#EF4444' });
    const ev = db.upsertCalendarEvent(scope, {
      calendarId: customCat.id,
      title: '蓝桥杯校内模拟赛',
      startDate: '2026-11-27',
      endDate: '2026-11-28',
      startTime: '14:00',
      endTime: '17:00',
      location: '明理楼B202',
      reminderMinutes: 15,
    });
    assert.equal(eventCoversDate(ev, '2026-11-27'), true);
    assert.equal(eventCoversDate(ev, '2026-11-28'), true);
    assert.equal(eventCoversDate(ev, '2026-11-29'), false);

    const task = db.upsertCalendarTask(scope, {
      title: '提交操作系统实验报告',
      dueDate: '2026-11-27',
      dueTime: '20:00',
      priority: 'high',
      reminderMinutes: 15,
    });

    const sent = new Set<string>();
    const evNotice = evaluateCalendarReminder({
      now: new Date(2026, 10, 27, 13, 50),
      events: [ev],
      tasks: [task],
      sentKeys: sent,
    });
    assert.equal(evNotice?.kind, 'event');
    assert.ok(evNotice?.title.includes('10 分钟后日程'));

    const taskNotice = evaluateCalendarReminder({
      now: new Date(2026, 10, 27, 19, 50),
      events: [ev],
      tasks: [task],
      sentKeys: sent,
    });
    assert.equal(taskNotice?.kind, 'task');
    assert.ok(taskNotice?.title.includes('提交操作系统实验报告'));

    // 勾选完成后不再触发提醒
    const done = db.toggleCalendarTask(scope, task.id, true);
    assert.equal(done?.completed, true);
    assert.equal(
      evaluateCalendarReminder({
        now: new Date(2026, 10, 27, 19, 50),
        events: [ev],
        tasks: done ? [done] : [],
        sentKeys: sent,
      }),
      null,
    );

    // 验证课表按日期展开与节假日过滤
    const detail = db.applySwpuImport(scope, {
      mode: 'create',
      scheduleName: '西南石油大学',
      termCode: '2026-2027-1',
      startDate: '2026-08-31',
      totalWeeks: 20,
      holidays: ['2026-11-27'],
      courses: [
        {
          name: '计算机网络基础',
          courseCode: '5621571035',
          credit: 3.5,
          category: '必修',
          color: '#4F8EF7',
          note: '',
          meetings: [
            {
              teacher: '何中越',
              location: '思学楼C308',
              campus: '成都校区',
              dayOfWeek: 5,
              startSection: 3,
              endSection: 5,
              weeks: [13],
              weeksText: '13周',
              isAdjusted: false,
              source: 'swpu_wisedu',
            },
          ],
        },
      ],
    });
    // 2026-11-27 在 holidays 中应跳过
    assert.equal(expandCoursesForDate(detail, '2026-11-27').length, 0);
    db.updateSchedule(scope, { id: detail.schedule.id, holidays: [] });
    const updatedDetail = db.getScheduleDetail(scope, detail.schedule.id);
    const expanded = expandCoursesForDate(updatedDetail, '2026-11-27');
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0]?.startTime, '09:50');
    assert.equal(expanded[0]?.endTime, '12:15');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RFC 5545 ICS 解析与 LocalDB v5 默认节假日订阅/外部订阅/导入/删除日历闭环', () => {
  assert.equal(
    normalizeSubscriptionUrl('webcal://calendars.icloud.com/holidays/cn_zh.ics'),
    'https://calendars.icloud.com/holidays/cn_zh.ics',
  );

  const sampleIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:实验室赛程',
    'BEGIN:VEVENT',
    'UID:evt-1@lec',
    'DTSTART;VALUE=DATE:20261001',
    'DTEND;VALUE=DATE:20261004',
    'SUMMARY:国庆集训',
    'DESCRIPTION:第一行\\n第二',
    ' 行续写',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:evt-2@lec',
    'DTSTART:20261127T190000',
    'DTEND:20261127T210000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'SUMMARY:每周技术分享',
    'LOCATION:明理楼B305',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const parsed = parseIcsEvents(sampleIcs, { referenceDate: new Date(2026, 10, 27) });
  assert.equal(parsed.calendarName, '实验室赛程');
  // 1 条跨天全天事件 + 3 次 RRULE 周重复事件 = 4 条
  assert.equal(parsed.entries.length, 4);
  // 全天事件 DTEND=20261004 为独占日，实际结束日应为 2026-10-03
  assert.equal(parsed.entries[0]?.startDate, '2026-10-01');
  assert.equal(parsed.entries[0]?.endDate, '2026-10-03');
  assert.equal(parsed.entries[0]?.description, '第一行\n第二行续写');
  assert.equal(parsed.entries[1]?.allDay, false);
  assert.equal(parsed.entries[1]?.startTime, '19:00');
  assert.equal(parsed.entries[1]?.endTime, '21:00');
  assert.equal(parsed.entries[2]?.startDate, '2026-12-04');
  assert.equal(parsed.entries[3]?.startDate, '2026-12-11');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-orbit-cal-v5-'));
  const db = new LocalDB(dir);
  try {
    const scope = 'campus:sub-tester';
    const snap = db.getCalendarSnapshot(scope);
    // 默认自动创建中国法定节假日与调休订阅记录（不硬编码日期，由在线同步拉取落库）
    const cnSub = snap.subscriptions.find((s) => s.id === DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID);
    assert.ok(cnSub && cnSub.isBuiltin && cnSub.visible);

    // 模拟首次在线拉取国务院节假日 JSON 后写入本地 SQLite 缓存
    const holidayEntries = convertHolidayCnDaysToEntries([
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-10', isOffDay: false },
    ]);
    db.replaceCalendarSubscriptionItems(scope, DEFAULT_CN_HOLIDAY_SUBSCRIPTION_ID, holidayEntries, {
      syncedAt: Date.now(),
      error: null,
    });
    const syncedItems = db.listCalendarSubscriptionItems(scope);
    assert.equal(syncedItems.find((i) => i.startDate === '2026-10-01')?.badge, 'off');
    assert.equal(syncedItems.find((i) => i.startDate === '2026-10-10')?.badge, 'work');

    // 添加外部订阅、同步条目并退订删除
    const extSub = db.saveCalendarSubscription(scope, {
      name: '实验室赛程',
      url: 'https://example.com/lab.ics',
      color: '#EC4899',
    });
    db.replaceCalendarSubscriptionItems(scope, extSub.id, parsed.entries, {
      syncedAt: Date.now(),
      error: null,
    });
    assert.equal(
      db.listCalendarSubscriptionItems(scope).filter((i) => i.subscriptionId === extSub.id).length,
      4,
    );
    db.deleteCalendarSubscription(scope, extSub.id);
    assert.equal(
      db.listCalendarSubscriptions(scope).some((s) => s.id === extSub.id),
      false,
    );

    // 本地 .ics 导入为可编辑自定义日历，并测试删除该日历时日程安全迁回个人日程
    const imported = db.importEntriesAsCalendarCategory(scope, {
      name: parsed.calendarName,
      color: '#10B981',
      entries: parsed.entries,
    });
    assert.equal(imported.importedCount, 4);
    db.deleteCalendarCategory(scope, imported.category.id);
    assert.equal(
      db.listCalendarCategories(scope).some((c) => c.id === imported.category.id),
      false,
    );
    const remainingEvents = db.listCalendarEvents(scope);
    assert.equal(remainingEvents.length, 4);
    assert.ok(remainingEvents.every((e) => e.calendarId === DEFAULT_PERSONAL_CALENDAR_ID));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
