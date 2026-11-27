import { describe, expect, it } from 'bun:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuthUser } from '../src/modules/auth/auth.types.js';
import type { RealtimeEvent, RealtimeHub } from '../src/modules/realtime/realtime.hub.js';
import type { MemberDTO, RosterService } from '../src/modules/roster/roster.service.js';
import type { MemberBusySnapshotEntity } from '../src/modules/calendar/entities/member-busy-snapshot.entity.js';
import type { StudioCalendarEventEntity } from '../src/modules/calendar/entities/studio-calendar-event.entity.js';
import {
  expandScheduleSnapshotForDate,
  StudioCalendarService,
} from '../src/modules/calendar/studio-calendar.service.js';

function createMockEventRepo() {
  const store = new Map<string, StudioCalendarEventEntity>();
  const repo = {
    create: (partial: Partial<StudioCalendarEventEntity>) =>
      ({ ...partial }) as StudioCalendarEventEntity,
    save: async (entity: StudioCalendarEventEntity) => {
      store.set(entity.id, { ...entity });
      return entity;
    },
    findOne: async (opts: { where?: { id?: string } }) => {
      const id = opts?.where?.id;
      if (!id) return null;
      const found = store.get(id);
      if (!found || found.deletedAt !== null) return null;
      return { ...found };
    },
    createQueryBuilder: () => {
      const filters: Array<(row: StudioCalendarEventEntity) => boolean> = [
        (r) => r.deletedAt === null,
      ];
      const qb = {
        where: () => qb,
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
        orderBy: () => qb,
        addOrderBy: () => qb,
        limit: () => qb,
        getMany: async () =>
          Array.from(store.values())
            .filter((r) => filters.every((fn) => fn(r)))
            .sort((a, b) => a.startDate.localeCompare(b.startDate)),
      };
      return qb;
    },
  };
  return repo as unknown as Repository<StudioCalendarEventEntity>;
}

function createMockBusyRepo() {
  const store = new Map<string, MemberBusySnapshotEntity>();
  const repo = {
    create: (partial: Partial<MemberBusySnapshotEntity>) =>
      ({ ...partial }) as MemberBusySnapshotEntity,
    save: async (entity: MemberBusySnapshotEntity) => {
      store.set(entity.userId, { ...entity });
      return entity;
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
  return repo as unknown as Repository<MemberBusySnapshotEntity>;
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

  it('支持成员发布、按年级/成员邀请、RSVP 回复、仅发起人/队长修改删除并全员广播', async () => {
    const broadcasts: RealtimeEvent[] = [];
    const hub = {
      broadcast: async (ev: RealtimeEvent) => {
        broadcasts.push(ev);
      },
    } as unknown as RealtimeHub;

    const service = new StudioCalendarService(
      createMockEventRepo(),
      createMockBusyRepo(),
      rosterService,
      hub,
    );

    // 同一天结束早于开始应拒绝
    await expect(
      service.create(alice, {
        title: '非法时间测试',
        startDate: '2026-11-28',
        startTime: '15:00',
        endTime: '14:00',
      }),
    ).rejects.toThrow(BadRequestException);

    // 成员创建按年级邀请的工作室共享日程并广播
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
    expect(broadcasts[0]?.type).toBe('studio_calendar.created');

    // 受邀成员可 RSVP 更新参会状态
    const rsvped = await service.rsvp(captain, created.id, 'accepted');
    expect(rsvped.attendeeResponses.u_captain).toBe('accepted');

    // 其他普通成员无权修改或删除
    await expect(service.update(bob, created.id, { title: '私自篡改' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.softDelete(bob, created.id)).rejects.toThrow(ForbiddenException);

    // 队长可以修改并广播
    const updated = await service.update(captain, created.id, {
      location: '思学楼C201',
    });
    expect(updated.location).toBe('思学楼C201');

    // 发起人可以软删除并广播，删除后不再出现在列表
    await service.softDelete(alice, created.id);
    const afterDelete = await service.list();
    expect(afterDelete.length).toBe(0);
  });

  it('支持公开课表规则与个人日程快照同步，按年级与单独挑人聚合多人忙闲时间轴', async () => {
    const hub = { broadcast: async () => {} } as unknown as RealtimeHub;
    const service = new StudioCalendarService(
      createMockEventRepo(),
      createMockBusyRepo(),
      rosterService,
      hub,
    );

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
          title: '牙科复诊',
          location: '校医院',
          allDay: false,
          startDate: '2026-09-14',
          endDate: '2026-09-14',
          startTime: '14:00',
          endTime: '15:00',
          color: '#2563EB',
          calendarName: '个人日程',
        },
      ],
    });

    const studioEv = await service.create(captain, {
      title: '工作室新生迎新会',
      startDate: '2026-09-14',
      startTime: '16:00',
      endTime: '17:30',
      attendeeGrades: [2024],
      attendeeUserIds: ['u_captain'],
    });

    // 验证纯函数课表展开
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
      '牙科复诊',
      '工作室新生迎新会',
    ]);
    // 张三尚未回复，应标为 tentative（前端虚线框）
    expect(aliceTimeline.blocks[2]?.status).toBe('tentative');

    // 编辑该工作室日程时排除自身 excludeEventId
    const fbExcluding = await service.queryFreeBusy({
      date: '2026-09-14',
      userIds: ['u_alice'],
      excludeEventId: studioEv.id,
    });
    expect(fbExcluding.members[0]?.blocks.map((b) => b.title)).toEqual(['操作系统', '牙科复诊']);
  });
});
