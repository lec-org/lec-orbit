import { describe, expect, it } from 'bun:test';
import type { Repository } from 'typeorm';
import type { AuthUser } from '../src/modules/auth/auth.types.js';
import type { MemberBusySnapshotEntity } from '../src/modules/calendar/entities/member-busy-snapshot.entity.js';
import type { StudioCalendarEventEntity } from '../src/modules/calendar/entities/studio-calendar-event.entity.js';
import {
  sliceEventForDate,
  StudioCalendarService,
} from '../src/modules/calendar/studio-calendar.service.js';
import type { RealtimeHub } from '../src/modules/realtime/realtime.hub.js';
import type { RosterService } from '../src/modules/roster/roster.service.js';

describe('StudioCalendarService 评审修复回归测试', () => {
  it('sliceEventForDate 对跨天非全天事件按首日/中间日/末日精准切分', () => {
    const ev = {
      allDay: false,
      startDate: '2026-11-27',
      endDate: '2026-11-29',
      startTime: '20:00',
      endTime: '09:00',
    };
    expect(sliceEventForDate(ev, '2026-11-27')).toEqual({
      allDay: false,
      startTime: '20:00',
      endTime: '23:59',
    });
    expect(sliceEventForDate(ev, '2026-11-28')).toEqual({
      allDay: true,
      startTime: '00:00',
      endTime: '23:59',
    });
    expect(sliceEventForDate(ev, '2026-11-29')).toEqual({
      allDay: false,
      startTime: '00:00',
      endTime: '09:00',
    });
  });

  it('rsvp() 拒绝非受邀成员对定向日程提交回复，且 queryFreeBusy() 拒绝空筛选', async () => {
    const targetedEvent: StudioCalendarEventEntity = {
      id: '11111111-1111-4111-8111-111111111111',
      title: '2024 级复盘会',
      description: '',
      location: '工作室',
      allDay: false,
      startDate: '2026-11-28',
      endDate: '2026-11-28',
      startTime: '14:00',
      endTime: '15:00',
      reminderMinutes: 15,
      attendeeUserIds: ['u_invited'],
      attendeeGrades: [2024],
      attendeeResponses: { u_creator: 'accepted' },
      creatorId: 'u_creator',
      creatorName: '发起人',
      creatorAvatar: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const repo = {
      findOne: async () => targetedEvent,
    } as unknown as Repository<StudioCalendarEventEntity>;
    const busyRepo = {} as unknown as Repository<MemberBusySnapshotEntity>;
    const rosterService = {
      listActive: async () => [
        {
          userId: 'u_outsider',
          username: 'outsider',
          displayName: '未受邀成员',
          avatar: '',
          enrollYear: 2026,
          isCaptain: false,
        },
      ],
    } as unknown as RosterService;
    const hub = {
      broadcast: async () => undefined,
      pushToUser: async () => undefined,
    } as unknown as RealtimeHub;

    const service = new StudioCalendarService(repo, busyRepo, rosterService, hub);
    const outsider: AuthUser = {
      userId: 'u_outsider',
      username: 'outsider',
      displayName: '未受邀成员',
      avatar: '',
      isStudio: true,
      isCaptain: false,
      organizations: ['lec-studio'],
      roles: ['member'],
    };

    await expect(service.rsvp(outsider, targetedEvent.id, 'accepted')).rejects.toThrow(
      '不在该定向日程的受邀范围内',
    );
    await expect(service.queryFreeBusy({ date: '2026-11-28' })).rejects.toThrow(
      '请至少选择一名成员或一个年级',
    );
  });
});
