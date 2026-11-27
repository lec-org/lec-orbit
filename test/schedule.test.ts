import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDB } from '../electron/storage/localDb';
import {
  SWPU_CHENGDU_DEFAULT_SLOTS,
  applyFixedDurationToSlot,
  buildOrbitSharePackage,
  computeScheduleNowLineTop,
  computeStartDateFromWeek,
  computeWeekFromStartDate,
  evaluateClassReminder,
  formatWeeksCompact,
  generateScheduleIcs,
  getWeekDayColumns,
  inferTermStartDate,
  parseSkzcBitmap,
  parseSwpuWiseduRows,
  parseWeeksExpression,
} from '../src/shared/schedule';

test('金智 SKZC 二进制位图、周次表达式与紧凑格式化可准确处理单双周与跳周', () => {
  assert.deepEqual(parseSkzcBitmap('11111111100000000000'), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseSkzcBitmap('000000000101000000000000000000'), [10, 12]);
  assert.deepEqual(parseSkzcBitmap('000000000011011111000000000000'), [11, 12, 14, 15, 16, 17, 18]);

  assert.equal(formatWeeksCompact([1, 2, 3, 4, 5, 6, 7, 8, 9]), '1-9周');
  assert.equal(formatWeeksCompact([10, 12]), '10-12周(双)');
  assert.equal(formatWeeksCompact([1, 3, 5, 7]), '1-7周(单)');
  assert.equal(formatWeeksCompact([11, 12, 14, 15, 16, 17, 18]), '11-12,14-18周');
  assert.equal(formatWeeksCompact([3, 8]), '3,8周');

  assert.deepEqual(parseWeeksExpression('1-9,11-12'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12]);
  assert.deepEqual(parseWeeksExpression('10-14周(双)'), [10, 12, 14]);
  assert.deepEqual(parseWeeksExpression('1-7单'), [1, 3, 5, 7]);
});

test('开学日期反推、当前周次与周列头计算与西柚实际日历一致', () => {
  // 2026-11-27（周五）为第 13 周 -> 第 1 周周一应精确反推为 2026-08-31
  const startDate = inferTermStartDate('2026-11-27', 13, 1);
  assert.equal(startDate, '2026-08-31');

  const today = new Date(2026, 10, 27, 10, 44);
  assert.equal(computeWeekFromStartDate(startDate, today, 1), 13);
  assert.equal(computeStartDateFromWeek(13, today, 1), '2026-08-31');

  const cols = getWeekDayColumns(startDate, 13, 1, today);
  assert.equal(cols.length, 7);
  assert.equal(cols[0]?.dateStr, '2026-11-23');
  assert.equal(cols[4]?.dateStr, '2026-11-27');
  assert.equal(cols[4]?.isToday, true);
  assert.equal(cols[6]?.dateStr, '2026-11-29');
});

test('固定上课时长开关会随开始时间联动重算结束时间', () => {
  const updated = applyFixedDurationToSlot(SWPU_CHENGDU_DEFAULT_SLOTS, 1, '08:15', 45, true);
  assert.equal(updated[0]?.startTime, '08:15');
  assert.equal(updated[0]?.endTime, '09:00');

  const unlinked = applyFixedDurationToSlot(SWPU_CHENGDU_DEFAULT_SLOTS, 1, '08:15', 45, false);
  assert.equal(unlinked[0]?.endTime, '08:45');
});

test('parseSwpuWiseduRows 按课程聚合西柚真实排课并保留时间、地点、双周与跳周', () => {
  const sampleRows = [
    {
      KCH: '2515650030',
      KCM: '线性代数Ⅰ',
      SKJS: '郑琴',
      JASMC: '思学楼B409',
      XXXQDM_DISPLAY: '成都校区',
      SKXQ: 5,
      KSJC: 1,
      JSJC: 2,
      KSSJ: '08:00',
      JSSJ: '09:35',
      SKZC: '11111111100000000000',
      ZCMC: '1-9周',
      XF: 3,
      KCXZDM_DISPLAY: '必修',
      ISTK: 0,
    },
    {
      KCH: '2515650030',
      KCM: '线性代数Ⅰ',
      SKJS: '郑琴',
      JASMC: '思学楼B409',
      XXXQDM_DISPLAY: '成都校区',
      SKXQ: 2,
      KSJC: 8,
      JSJC: 9,
      KSSJ: '16:20',
      JSSJ: '17:55',
      SKZC: '11111111100000000000',
      ZCMC: '1-9周',
      XF: 3,
      KCXZDM_DISPLAY: '必修',
      ISTK: 0,
    },
    {
      KCH: '2012113003',
      KCM: '形势与政策3',
      SKJS: '于百江',
      JASMC: '思学楼A214',
      XXXQDM_DISPLAY: '成都校区',
      SKXQ: 5,
      KSJC: 1,
      JSJC: 2,
      KSSJ: '08:00',
      JSSJ: '09:35',
      SKZC: '00000000010100000000',
      ZCMC: '10-12周(双)',
      XF: 0.3,
      KCXZDM_DISPLAY: '必修',
      ISTK: 0,
    },
  ];

  const parsed = parseSwpuWiseduRows(sampleRows);
  assert.equal(parsed.campus, '成都校区');
  assert.equal(parsed.courseCount, 2);
  assert.equal(parsed.meetingCount, 3);
  assert.equal(parsed.courses[0]?.name, '线性代数Ⅰ');
  assert.equal(parsed.courses[0]?.meetings.length, 2);
  assert.deepEqual(parsed.courses[1]?.meetings[0]?.weeks, [10, 12]);
});

test('LocalDB v3 支持多课表、聚合课程 CRUD、西柚导入、分享导入、ICS 导出与课前提醒', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-orbit-sched-'));
  const db = new LocalDB(dir);
  try {
    const scope = 'campus:swpu-tester';
    const detail = db.applySwpuImport(scope, {
      mode: 'create',
      scheduleName: '西南石油大学 · 2026秋',
      termCode: '2026-2027-1',
      startDate: '2026-08-31',
      totalWeeks: 20,
      holidays: ['2026-10-01'],
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

    assert.equal(detail.schedule.courseCount, 1);
    assert.equal(detail.schedule.meetingCount, 1);
    assert.equal(detail.timetable.slots.length, 12);

    // 导出标准 ICS 日历并验证 VEVENT 与 VALARM
    const ics = generateScheduleIcs(detail);
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('DTSTART;TZID=Asia/Shanghai:20261127T095000'));
    assert.ok(ics.includes('DTEND;TZID=Asia/Shanghai:20261127T121500'));
    assert.ok(ics.includes('SUMMARY:计算机网络基础'));
    assert.ok(ics.includes('TRIGGER:-PT15M'));

    // 课前 10 分钟（09:40）应命中 09:50 的课前提醒，且去重生效
    const sentKeys = new Set<string>();
    const notice = evaluateClassReminder({
      now: new Date(2026, 10, 27, 9, 40),
      detail,
      sentKeys,
    });
    assert.ok(notice);
    assert.ok(notice.title.includes('10 分钟后上课'));
    sentKeys.add(notice.key);
    assert.equal(
      evaluateClassReminder({
        now: new Date(2026, 10, 27, 9, 40),
        detail,
        sentKeys,
      }),
      null,
    );

    // 分享包导出与导入到另一个账号
    const pkg = buildOrbitSharePackage(detail);
    const imported = db.importSharePackage('campus:friend-user', pkg);
    assert.equal(imported.schedule.name, '西南石油大学 · 2026秋');
    assert.equal(imported.courses[0]?.name, '计算机网络基础');

    // 批量删除课程 & 清空课表
    db.deleteCourses(scope, detail.schedule.id, [detail.courses[0]!.id]);
    assert.equal(db.getScheduleDetail(scope, detail.schedule.id)?.courses.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeScheduleNowLineTop 精准计算课中、课间午休与深夜时间线位置', () => {
  const rowH = 56;
  // 第 6 节为 14:30-15:15 (index=5)，14:52.5 应落在第 6 节正中
  const inClass = computeScheduleNowLineTop(SWPU_CHENGDU_DEFAULT_SLOTS, 14 * 60 + 52.5, rowH);
  assert.ok(inClass !== null && Math.abs(inClass - 5.5 * rowH) < 0.01);

  // 午休 13:00（第 5 节 12:15 结束、第 6 节 14:30 开始）应停靠在 5/6 节交界线
  assert.equal(computeScheduleNowLineTop(SWPU_CHENGDU_DEFAULT_SLOTS, 13 * 60, rowH), 5 * rowH);

  // 深夜 03:00 不在课表时段返回 null
  assert.equal(computeScheduleNowLineTop(SWPU_CHENGDU_DEFAULT_SLOTS, 3 * 60, rowH), null);
});
