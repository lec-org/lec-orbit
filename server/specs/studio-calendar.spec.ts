import { describe, expect, it } from 'bun:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuthUser } from '../src/modules/auth/auth.types.js';
import type { RealtimeEvent, RealtimeHub } from '../src/modules/realtime/realtime.hub.js';
import type { MemberDTO, RosterService } from '../src/modules/roster/roster.service.js';
import type { MemberBusySnapshotEntity } from '../src/modules/calendar/entities/member-busy-snapshot.entity.js';
import type {
  AttendeeResponseStatus,
  StudioCalendarEventEntity,
} from '../src/modules/calendar/entities/studio-calendar-event.entity.js';
import {
  expandScheduleSnapshotForDate,
  sliceEventForDate,
  StudioCalendarService,
} from '../src/modules/calendar/studio-calendar.service.js';

function createMockEventRepo() {
  const store = new Map<string, StudioCalendarEventEntity>();
  let lastAtomicSetSql = '';
  let lastOrderByClauses: Array<{ col: string; dir: 'ASC' | 'DESC' }> = [];

  const repo = {
    create: (partial: Partial<StudioCalendarEventEntity>) =>
      ({ ...partial }) as StudioCalendarEventEntity,
    save: async (entity: StudioCalendarEventEntity) => {
      store.set(entity.id, {
        ...entity,
        attendeeUserIds: [...(entity.attendeeUserIds ?? [])],
        attendeeGrades: [...(entity.attendeeGrades ?? [])],
        attendeeResponses: { ...(entity.attendeeResponses ?? {}) },
      });
      return entity;
    },
    findOne: async (opts: { where?: { id?: string } }) => {
      const id = opts?.where?.id;
      if (!id) return null;
      const found = store.get(id);
      if (!found || found.deletedAt !== null) return null;
      return {
        ...found,
        attendeeUserIds: [...(found.attendeeUserIds ?? [])],
        attendeeGrades: [...(found.attendeeGrades ?? [])],
        attendeeResponses: { ...(found.attendeeResponses ?? {}) },
      };
    },
    createQueryBuilder: () => {
      const filters: Array<(row: StudioCalendarEventEntity) => boolean> = [
        (r) => r.deletedAt === null,
      ];
      let isUpdate = false;
      let updateParams: Record<string, unknown> = {};
      let setObj: Record<string, unknown> = {};
      const orderClauses: Array<{ col: string; dir: 'ASC' | 'DESC' }> = [];

      const qb = {
        update: () => {
          isUpdate = true;
          return qb;
        },
        set: (values: Record<string, unknown>) => {
          setObj = values;
          return qb;
        },
        where: (_clause?: string, params?: Record<string, unknown>) => {
          if (params) updateParams = { ...updateParams, ...params };
          return qb;
        },
        andWhere: (clause: string, params: Record<string, string>) => {
          if (clause.includes(':from') && params.from) {
            const from = params.from;
            filters.push((r) => r.endDate >= from);
          }
          if (clause.includes(':to') && params.to) {
            const to = params.to;
            filters.push((r) => r.startDate <= to);
          }
          if (clause.includes(':date') && params.date) {
            const date = params.date;
            if (clause.includes('start_date')) {
              filters.push((r) => r.startDate <= date);
            }
            if (clause.includes('end_date')) {
              filters.push((r) => r.endDate >= date);
            }
          }
          return qb;
        },
        orderBy: (col: string, dir: 'ASC' | 'DESC') => {
          orderClauses.length = 0;
          orderClauses.push({ col, dir });
          return qb;
        },
        addOrderBy: (col: string, dir: 'ASC' | 'DESC') => {
          orderClauses.push({ col, dir });
          return qb;
        },
        limit: () => qb,
        execute: async () => {
          if (!isUpdate) return { affected: 0 };
          const exprFn = setObj.attendeeResponses;
          if (typeof exprFn === 'function') {
            lastAtomicSetSql = String((exprFn as () => string)());
          }
          const id = String(updateParams.id ?? '');
          const uid = String(updateParams.rsvpUserId ?? '');
          const status = String(updateParams.rsvpStatus ?? '') as AttendeeResponseStatus;
          const existing = store.get(id);
          if (existing && existing.deletedAt === null && uid && status) {
            store.set(id, {
              ...existing,
              attendeeResponses: {
                ...(existing.attendeeResponses ?? {}),
                [uid]: status,
              },
              updatedAt: (setObj.updatedAt as Date) ?? new Date(),
            });
            return { affected: 1 };
          }
          return { affected: 0 };
        },
        getMany: async () => {
          lastOrderByClauses = [...orderClauses];
          const list = Array.from(store.values()).filter((r) => filters.every((fn) => fn(r)));
          list.sort((a, b) => {
            for (const { col, dir } of orderClauses) {
              const sign = dir === 'ASC' ? 1 : -1;
              let cmp = 0;
              if (col.includes('start_date')) cmp = a.startDate.localeCompare(b.startDate);
              else if (col.includes('all_day')) cmp = Number(a.allDay) - Number(b.allDay);
              else if (col.includes('start_time')) cmp = a.startTime.localeCompare(b.startTime);
              if (cmp !== 0) return cmp * sign;
            }
            return 0;
          });
          return list;
        },
      };
      return qb;
    },
  };

  return {
    repo: repo as unknown as Repository<StudioCalendarEventEntity>,
    getLastAtomicSetSql: () => lastAtomicSetSql,
    getLastOrderByClauses: () => lastOrderByClauses,
  };
}

function createMockBusyRepo() {
  const store = new Map<string, MemberBusySnapshotEntity>();
  let upsertCalls = 0;
  const repo = {
    create: (partial: Partial<MemberBusySnapshotEntity>) =>
      ({ ...partial }) as MemberBusySnapshotEntity,
    save: async (entity: MemberBusySnapshotEntity) => {
      store.set(entity.userId, { ...entity });
      return entity;
    },
    upsert: async (entity: Partial<MemberBusySnapshotEntity>, _conflictPaths: string[]) => {
      upsertCalls += 1;
      const uid = String(entity.userId ?? '');
      store.set(uid, {
        userId: uid,
        scheduleJson: entity.scheduleJson ?? null,
        personalEventsJson: entity.personalEventsJson ?? [],
        updatedAt: entity.updatedAt ?? new Date(),
      });
      return { identifiers: [{ userId: uid }], generatedMaps: [], raw: [] };
    },
    find: async (opts?: { where?: { userId?: { _value?: string[] } } }) => {
      const ids = opts?.where?.userId?._value;
      if (Array.isArray(ids)) {
        return ids
          .map((id) => store.get(id))
          .filter((item): item is MemberBusySnapshotEntity => Boolean(item));
      }
      return Array.from(store.values());
    },
  };
  return {
    repo: repo as unknown as Repository<MemberBusySnapshotEntity>,
    getUpsertCalls: () => upsertCalls,
  };
}

describe('StudioCalendarService 工作室共享日历与多人忙闲', () => {
  const alice: AuthUser = {
    userId: 'u_alice',
    username: 'alice',
    displayName: '张三',
    avatar: 'https://example.com/a.png',
    isStudio: true,
    isCaptain: false,
    organizations: ['lec-studio'],
    roles: ['member'],
  };
  const bob: AuthUser = {
    userId: 'u_bob',
    username: 'bob',
    displayName: '李四',
    avatar: '',
    isStudio: true,
    isCaptain: false,
    organizations: ['lec-studio'],
    roles: ['member'],
  };
  const captain: AuthUser = {
    userId: 'u_captain',
    username: 'captain',
    displayName: '王队长',
    avatar: '',
    isStudio: true,
    isCaptain: true,
    organizations: ['lec-studio'],
    roles: ['captain'],
  };

  const mockMembers: MemberDTO[] = [
    {
      userId: 'u_alice',
      username: 'alice',
      displayName: '张三',
      avatar: 'https://example.com/a.png',
      isCaptain: false,
      enrollYear: 2024,
      roles: ['member'],
      social: { github: null, feishu: null },
    },
    {
      userId: 'u_bob',
      username: 'bob',
      displayName: '李四',
      avatar: '',
      isCaptain: false,
      enrollYear: 2023,
      roles: ['member'],
      social: { github: null, feishu: null },
    },
    {
      userId: 'u_captain',
      username: 'captain',
      displayName: '王队长',
      avatar: '',
      isCaptain: true,
      enrollYear: 2022,
      roles: ['captain'],
      social: { github: null, feishu: null },
    },
  ];

  const rosterService = {
    listActive: async () => mockMembers,
  } as unknown as RosterService;

  it('支持成员发布、按年级/成员定向推送、jsonb_set 原子 RSVP、清理已移除成员回复与仅发起人/队长修改删除', async () => {
    const broadcasts: RealtimeEvent[] = [];
    const pushed: Array<{ userId: string; event: RealtimeEvent }> = [];
    const hub = {
      broadcast: async (ev: RealtimeEvent) => {
        broadcasts.push(ev);
      },
      pushToUser: async (userId: string, ev: RealtimeEvent) => {
        pushed.push({ userId, event: ev });
      },
    } as unknown as RealtimeHub;

    const eventMock = createMockEventRepo();
    const busyMock = createMockBusyRepo();
    const service = new StudioCalendarService(eventMock.repo, busyMock.repo, rosterService, hub);

    // 同一天结束早于开始应拒绝
    await expect(
      service.create(alice, {
        title: '非法时间测试',
        startDate: '2026-11-28',
        startTime: '15:00',
        endTime: '14:00',
      }),
    ).rejects.toThrow(BadRequestException);

    // 成员创建按年级+单人邀请的定向工作室日程，仅推送给受邀成员与创建人（不打扰未受邀的 bob）
    const created = await service.create(alice, {
      title: '2024级前端架构评审',
      location: '明理楼B305',
      startDate: '2026-11-28',
      startTime: '19:00',
      endTime: '20:30',
      attendeeGrades: [2024],
      attendeeUserIds: ['u_alice', 'u_captain'],
    });
    expect(created.creatorId).toBe('u_alice');
    expect(created.attendeeGrades).toEqual([2024]);
    expect(created.attendeeUserIds).toEqual(['u_alice', 'u_captain']);
    expect(created.attendeeResponses.u_alice).toBe('accepted');
    expect(broadcasts.length).toBe(0);
    expect(pushed.map((p) => p.userId).sort()).toEqual(['u_alice', 'u_captain']);
    expect(pushed[0]?.event.type).toBe('studio_calendar.created');

    // 未受邀的 bob 不能对定向日程提交 RSVP
    await expect(service.rsvp(bob, created.id, 'accepted')).rejects.toThrow(ForbiddenException);

    // 受邀成员可经由 jsonb_set 原子更新 RSVP 状态
    const rsvped = await service.rsvp(captain, created.id, 'accepted');
    expect(rsvped.attendeeResponses.u_captain).toBe('accepted');
    expect(eventMock.getLastAtomicSetSql()).toContain('jsonb_set');

    // 其他普通成员无权修改或删除
    await expect(service.update(bob, created.id, { title: '私自篡改' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.softDelete(bob, created.id)).rejects.toThrow(ForbiddenException);

    // update 对 endDate < startDate 必须抛 400 而非静默篡改
    await expect(
      service.update(captain, created.id, {
        startDate: '2026-11-29',
        endDate: '2026-11-28',
      }),
    ).rejects.toThrow(BadRequestException);

    // 队长修改受邀人（移出 captain）后，应自动清理 captain 残留的 attendeeResponses
    const updated = await service.update(captain, created.id, {
      location: '思学楼C201',
      attendeeUserIds: ['u_alice'],
      attendeeGrades: [2024],
    });
    expect(updated.location).toBe('思学楼C201');
    expect(updated.attendeeResponses.u_captain).toBeUndefined();
    expect(updated.attendeeResponses.u_alice).toBe('accepted');

    // 全员日程（未指定受邀人与年级）走 broadcast 广播
    const allHands = await service.create(captain, {
      title: '全员月度复盘',
      allDay: true,
      startDate: '2026-11-28',
    });
    expect(broadcasts.some((b) => b.type === 'studio_calendar.created')).toBe(true);

    // list() 无范围分支同一天全天事件排在非全天之前
    const listed = await service.list();
    expect(listed.map((e) => e.id)).toEqual([allHands.id, created.id]);

    // 发起人可以软删除，删除后不再出现在列表
    await service.softDelete(alice, created.id);
    await service.softDelete(captain, allHands.id);
    const afterDelete = await service.list();
    expect(afterDelete.length).toBe(0);
  });

  it('支持原子 upsert 课表与个人日程快照，按年级/单人聚合忙闲时间轴并精准切分跨天非全天时段', async () => {
    const hub = {
      broadcast: async () => {},
      pushToUser: async () => {},
    } as unknown as RealtimeHub;
    const eventMock = createMockEventRepo();
    const busyMock = createMockBusyRepo();
    const service = new StudioCalendarService(eventMock.repo, busyMock.repo, rosterService, hub);

    // queryFreeBusy 未传任何筛选条件必须拒绝
    await expect(service.queryFreeBusy({ date: '2026-09-14' })).rejects.toThrow(BadRequestException);

    // 2026-09-07（周一）为开学第 1 周，2026-09-14（周一）为第 2 周
    await service.upsertFreeBusySnapshot(alice, {
      schedule: {
        scheduleName: 'SWPU 2026秋',
        startDate: '2026-09-07',
        totalWeeks: 20,
        weekStartDay: 1,
        slots: [
          { section: 1, startTime: '08:00', endTime: '08:45' },
          { section: 2, startTime: '08:55', endTime: '09:40' },
        ],
        courses: [
          {
            id: 'c_os',
            name: '操作系统',
            color: '#6366F1',
            meetings: [
              {
                id: 'm1',
                dayOfWeek: 1,
                startSection: 1,
                endSection: 2,
                weeks: [1, 2],
                location: '明理楼B201',
                teacher: '刘老师',
              },
            ],
          },
        ],
      },
      personalEvents: [
        {
          id: 'p1',
          title: '忙碌',
          location: '',
          allDay: false,
          startDate: '2026-09-14',
          endDate: '2026-09-14',
          startTime: '14:00',
          endTime: '15:00',
          color: '#2563EB',
          calendarName: '个人日程',
        },
        {
          id: 'p_cross',
          title: '跨夜值守',
          location: '',
          allDay: false,
          startDate: '2026-09-14',
          endDate: '2026-09-15',
          startTime: '20:00',
          endTime: '09:00',
          color: '#2563EB',
          calendarName: '个人日程',
        },
      ],
    });
    expect(busyMock.getUpsertCalls()).toBe(1);

    const studioEv = await service.create(captain, {
      title: '工作室新生迎新会',
      startDate: '2026-09-14',
      startTime: '16:00',
      endTime: '17:30',
      attendeeGrades: [2024],
      attendeeUserIds: ['u_captain'],
    });

    // 验证纯函数课表展开与跨天切分
    const expanded = expandScheduleSnapshotForDate(
      {
        scheduleName: 'SWPU 2026秋',
        startDate: '2026-09-07',
        totalWeeks: 20,
        weekStartDay: 1,
        slots: [
          { section: 1, startTime: '08:00', endTime: '08:45' },
          { section: 2, startTime: '08:55', endTime: '09:40' },
        ],
        courses: [
          {
            id: 'c_os',
            name: '操作系统',
            color: '#6366F1',
            meetings: [
              {
                id: 'm1',
                dayOfWeek: 1,
                startSection: 1,
                endSection: 2,
                weeks: [1, 2],
                location: '明理楼B201',
                teacher: '刘老师',
              },
            ],
          },
        ],
      },
      '2026-09-14',
    );
    expect(expanded.length).toBe(1);
    expect(expanded[0]?.title).toBe('操作系统');
    expect(expanded[0]?.startTime).toBe('08:00');
    expect(expanded[0]?.endTime).toBe('09:40');

    expect(
      sliceEventForDate(
        {
          allDay: false,
          startDate: '2026-09-14',
          endDate: '2026-09-16',
          startTime: '20:00',
          endTime: '09:00',
        },
        '2026-09-14',
      ),
    ).toEqual({ allDay: false, startTime: '20:00', endTime: '23:59' });
    expect(
      sliceEventForDate(
        {
          allDay: false,
          startDate: '2026-09-14',
          endDate: '2026-09-16',
          startTime: '20:00',
          endTime: '09:00',
        },
        '2026-09-15',
      ),
    ).toEqual({ allDay: true, startTime: '00:00', endTime: '23:59' });
    expect(
      sliceEventForDate(
        {
          allDay: false,
          startDate: '2026-09-14',
          endDate: '2026-09-16',
          startTime: '20:00',
          endTime: '09:00',
        },
        '2026-09-16',
      ),
    ).toEqual({ allDay: false, startTime: '00:00', endTime: '09:00' });

    // 按年级 2024（命中张三）+ 单人 u_bob 混合查询
    const fb = await service.queryFreeBusy({
      date: '2026-09-14',
      grades: [2024],
      userIds: ['u_bob'],
    });
    expect(fb.members.map((m) => m.userId)).toEqual(['u_bob', 'u_alice']);

    const aliceTimeline = fb.members.find((m) => m.userId === 'u_alice')!;
    expect(aliceTimeline.hasScheduleSynced).toBe(true);
    expect(aliceTimeline.blocks.map((b) => b.title)).toEqual([
      '操作系统',
      '忙碌',
      '工作室新生迎新会',
      '跨夜值守',
    ]);
    // 跨夜值守在首日仅占 20:00-23:59，而非全天
    expect(aliceTimeline.blocks[3]?.allDay).toBe(false);
    expect(aliceTimeline.blocks[3]?.startTime).toBe('20:00');
    expect(aliceTimeline.blocks[3]?.endTime).toBe('23:59');
    // 张三尚未回复，应标为 tentative（前端虚线框）
    expect(aliceTimeline.blocks[2]?.status).toBe('tentative');

    // 编辑该工作室日程时排除自身 excludeEventId
    const fbExcluding = await service.queryFreeBusy({
      date: '2026-09-14',
      userIds: ['u_alice'],
      excludeEventId: studioEv.id,
    });
    expect(fbExcluding.members[0]?.blocks.map((b) => b.title)).toEqual([
      '操作系统',
      '忙碌',
      '跨夜值守',
    ]);
  });
});
