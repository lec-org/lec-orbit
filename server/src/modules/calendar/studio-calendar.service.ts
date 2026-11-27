import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { RosterService, type MemberDTO } from '../roster/roster.service.js';
import {
  MemberBusySnapshotEntity,
  type BusyPersonalEventSnapshot,
  type BusyScheduleSnapshot,
} from './entities/member-busy-snapshot.entity.js';
import {
  StudioCalendarEventEntity,
  type AttendeeResponseStatus,
} from './entities/studio-calendar-event.entity.js';

export interface StudioCalendarEventDTO {
  id: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  reminderMinutes: number | null;
  attendeeUserIds: string[];
  attendeeGrades: number[];
  attendeeResponses: Record<string, AttendeeResponseStatus>;
  creatorId: string;
  creatorName: string;
  creatorAvatar: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStudioCalendarEventInput {
  title: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  reminderMinutes?: number | null;
  attendeeUserIds?: string[];
  attendeeGrades?: number[];
}

export interface UpdateStudioCalendarEventInput {
  title?: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  reminderMinutes?: number | null;
  attendeeUserIds?: string[];
  attendeeGrades?: number[];
}

export interface FreeBusyBlockDTO {
  id: string;
  kind: 'course' | 'personal' | 'studio';
  title: string;
  location: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  color: string;
  status: AttendeeResponseStatus;
  meta?: string;
}

export interface MemberFreeBusyTimelineDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  isCaptain: boolean;
  hasScheduleSynced: boolean;
  snapshotUpdatedAt: string | null;
  blocks: FreeBusyBlockDTO[];
}

export interface QueryFreeBusyInput {
  date: string;
  userIds?: string[];
  grades?: number[];
  excludeEventId?: string;
}

export interface UpsertFreeBusySnapshotInput {
  schedule: BusyScheduleSnapshot | null;
  personalEvents: BusyPersonalEventSnapshot[];
}

function dedupeStrings(list?: readonly string[]): string[] {
  if (!list || list.length === 0) return [];
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}

function dedupeGrades(list?: readonly number[]): number[] {
  if (!list || list.length === 0) return [];
  return Array.from(
    new Set(list.filter((n) => Number.isInteger(n) && n >= 2015 && n <= 2099)),
  ).sort((a, b) => a - b);
}

function toDto(row: StudioCalendarEventEntity): StudioCalendarEventDTO {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    location: row.location ?? '',
    allDay: Boolean(row.allDay),
    startDate: row.startDate,
    endDate: row.endDate,
    startTime: row.startTime || '09:00',
    endTime: row.endTime || '10:00',
    reminderMinutes: row.reminderMinutes ?? null,
    attendeeUserIds: Array.isArray(row.attendeeUserIds) ? row.attendeeUserIds : [],
    attendeeGrades: Array.isArray(row.attendeeGrades) ? row.attendeeGrades : [],
    attendeeResponses:
      row.attendeeResponses && typeof row.attendeeResponses === 'object'
        ? row.attendeeResponses
        : {},
    creatorId: row.creatorId,
    creatorName: row.creatorName ?? '',
    creatorAvatar: row.creatorAvatar ?? '',
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** 按本地日期串计算 ISO 星期（1=周一 ... 7=周日）和所属教学周，与客户端 schedule.ts 保持一致。 */
function parseDateOnlyUtc(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function computeWeekForDate(
  startDateStr: string,
  targetDateStr: string,
  weekStartDay: number,
): number {
  const start = parseDateOnlyUtc(startDateStr);
  const target = parseDateOnlyUtc(targetDateStr);
  if (!start || !target) return -1;
  const startIso = start.getUTCDay() === 0 ? 7 : start.getUTCDay();
  const offsetToWeekStart =
    weekStartDay === 7 ? (startIso === 7 ? 0 : startIso) : startIso - 1;
  const alignedStartMs = start.getTime() - offsetToWeekStart * 86_400_000;
  const diffDays = Math.floor((target.getTime() - alignedStartMs) / 86_400_000);
  return Math.floor(diffDays / 7) + 1;
}

function getIsoDayOfWeek(dateStr: string): number {
  const d = parseDateOnlyUtc(dateStr);
  if (!d) return 1;
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

/** 将某成员的课表快照按指定日期展开为当日课程忙闲块（工作室内公开展示完整课名与地点）。 */
export function expandScheduleSnapshotForDate(
  schedule: BusyScheduleSnapshot | null | undefined,
  dateStr: string,
): FreeBusyBlockDTO[] {
  if (!schedule || !Array.isArray(schedule.courses) || schedule.courses.length === 0) {
    return [];
  }
  const week = computeWeekForDate(
    schedule.startDate,
    dateStr,
    schedule.weekStartDay === 7 ? 7 : 1,
  );
  if (week < 1 || week > (schedule.totalWeeks || 24)) {
    return [];
  }
  const isoDay = getIsoDayOfWeek(dateStr);
  const slotBySection = new Map<number, { startTime: string; endTime: string }>();
  for (const s of schedule.slots ?? []) {
    slotBySection.set(s.section, { startTime: s.startTime, endTime: s.endTime });
  }

  const blocks: FreeBusyBlockDTO[] = [];
  for (const course of schedule.courses) {
    for (const meeting of course.meetings ?? []) {
      if (meeting.dayOfWeek !== isoDay) continue;
      if (!Array.isArray(meeting.weeks) || !meeting.weeks.includes(week)) continue;
      const startSlot = slotBySection.get(meeting.startSection);
      const endSlot = slotBySection.get(meeting.endSection);
      const startTime = startSlot?.startTime ?? '08:00';
      const endTime = endSlot?.endTime ?? '09:40';
      blocks.push({
        id: `crs:${course.id}:${meeting.id}`,
        kind: 'course',
        title: course.name,
        location: meeting.location || '',
        allDay: false,
        startTime,
        endTime,
        color: course.color || '#6366F1',
        status: 'accepted',
        meta: meeting.teacher
          ? `第${meeting.startSection}-${meeting.endSection}节 · ${meeting.teacher}`
          : `第${meeting.startSection}-${meeting.endSection}节`,
      });
    }
  }
  return blocks;
}

/** 单次忙闲查询允许返回的成员上限，防止无节制全员明文拉取。 */
const MAX_FREEBUSY_MEMBERS = 60;

/**
 * 将跨天或单日日程精确切分到指定日期的忙碌时段：
 * - 全天事件直接返回 allDay: true；
 * - 跨天非全天事件按首日 [startTime, 23:59]、中间整日 allDay: true、末日 [00:00, endTime] 拆分，
 *   避免如 20:00~次日 09:00 的活动把两天都误判为全天冲突。
 */
export function sliceEventForDate(
  ev: {
    allDay: boolean;
    startDate: string;
    endDate: string;
    startTime?: string;
    endTime?: string;
  },
  dateStr: string,
): { allDay: boolean; startTime: string; endTime: string } {
  if (ev.allDay) {
    return { allDay: true, startTime: '00:00', endTime: '23:59' };
  }
  const startTime = ev.startTime || '09:00';
  const endTime = ev.endTime || '10:00';
  if (ev.startDate >= ev.endDate) {
    return { allDay: false, startTime, endTime };
  }
  if (dateStr === ev.startDate) {
    return { allDay: false, startTime, endTime: '23:59' };
  }
  if (dateStr === ev.endDate) {
    return { allDay: false, startTime: '00:00', endTime };
  }
  return { allDay: true, startTime: '00:00', endTime: '23:59' };
}

/** 判断某条工作室共享日程是否为面向特定成员/年级的定向日程。 */
function isTargetedStudioEvent(event: {
  attendeeUserIds?: readonly string[];
  attendeeGrades?: readonly number[];
}): boolean {
  const userIds = Array.isArray(event.attendeeUserIds) ? event.attendeeUserIds : [];
  const grades = Array.isArray(event.attendeeGrades) ? event.attendeeGrades : [];
  return userIds.length > 0 || grades.length > 0;
}

/** 判断某条工作室共享日程是否关联到指定成员。 */
export function isMemberInStudioEvent(
  event: Pick<StudioCalendarEventEntity, 'attendeeUserIds' | 'attendeeGrades' | 'creatorId'>,
  member: Pick<MemberDTO, 'userId' | 'enrollYear'>,
): boolean {
  const userIds = Array.isArray(event.attendeeUserIds) ? event.attendeeUserIds : [];
  const grades = Array.isArray(event.attendeeGrades) ? event.attendeeGrades : [];
  // 未指定任何参与人与年级时默认面向全体工作室成员
  if (userIds.length === 0 && grades.length === 0) {
    return true;
  }
  if (event.creatorId === member.userId) return true;
  if (userIds.includes(member.userId)) return true;
  if (member.enrollYear !== null && grades.includes(member.enrollYear)) return true;
  return false;
}

@Injectable()
export class StudioCalendarService {
  constructor(
    @InjectRepository(StudioCalendarEventEntity)
    private readonly repo: Repository<StudioCalendarEventEntity>,
    @InjectRepository(MemberBusySnapshotEntity)
    private readonly busyRepo: Repository<MemberBusySnapshotEntity>,
    private readonly rosterService: RosterService,
    private readonly hub: RealtimeHub,
  ) {}

  /** 按日程受邀范围分发实时事件：全员日程广播，定向日程仅推送给相关成员避免全员打扰。 */
  private async emitCalendarRealtime(
    type: 'studio_calendar.created' | 'studio_calendar.updated' | 'studio_calendar.deleted',
    payload: unknown,
    scopes: ReadonlyArray<
      Pick<StudioCalendarEventEntity, 'attendeeUserIds' | 'attendeeGrades' | 'creatorId'>
    >,
  ): Promise<void> {
    if (scopes.some((s) => !isTargetedStudioEvent(s))) {
      await this.hub.broadcast({ type, payload });
      return;
    }
    const members = await this.rosterService.listActive();
    const targetIds = new Set<string>();
    for (const scope of scopes) {
      if (scope.creatorId) targetIds.add(scope.creatorId);
      for (const uid of scope.attendeeUserIds ?? []) {
        targetIds.add(uid);
      }
      for (const member of members) {
        if (isMemberInStudioEvent(scope, member)) {
          targetIds.add(member.userId);
        }
      }
    }
    await Promise.all(
      Array.from(targetIds).map((uid) => this.hub.pushToUser(uid, { type, payload })),
    );
  }

  async list(range?: { from?: string; to?: string }): Promise<StudioCalendarEventDTO[]> {
    const hasRange = Boolean(range?.from || range?.to);
    const qb = this.repo.createQueryBuilder('e').where('e.deleted_at IS NULL');

    if (range?.from) {
      qb.andWhere('e.end_date >= :from', { from: range.from });
    }
    if (range?.to) {
      qb.andWhere('e.start_date <= :to', { to: range.to });
    }

    if (hasRange) {
      qb.orderBy('e.start_date', 'ASC')
        .addOrderBy('e.all_day', 'DESC')
        .addOrderBy('e.start_time', 'ASC')
        .limit(1000);
      const rows = await qb.getMany();
      return rows.map(toDto);
    }

    // 未传时间窗时按最新日程优先截取，反序后保持同一天内全天事件排在非全天之前（与有范围分支一致）
    qb.orderBy('e.start_date', 'DESC')
      .addOrderBy('e.all_day', 'ASC')
      .addOrderBy('e.start_time', 'DESC')
      .limit(1000);
    const rows = await qb.getMany();
    rows.reverse();
    return rows.map(toDto);
  }

  async create(
    user: AuthUser,
    input: CreateStudioCalendarEventInput,
  ): Promise<StudioCalendarEventDTO> {
    const allDay = Boolean(input.allDay);
    const startDate = input.startDate;
    const endDate = input.endDate ?? startDate;
    if (endDate < startDate) {
      throw new BadRequestException('结束日期不能早于开始日期');
    }
    const startTime = input.startTime ?? '09:00';
    const endTime = input.endTime ?? '10:00';

    if (!allDay && endDate === startDate && endTime <= startTime) {
      throw new BadRequestException('同一天的结束时间必须晚于开始时间');
    }

    const attendeeUserIds = dedupeStrings(input.attendeeUserIds);
    const attendeeGrades = dedupeGrades(input.attendeeGrades);
    const attendeeResponses: Record<string, AttendeeResponseStatus> = {
      [user.userId]: 'accepted',
    };

    const now = new Date();
    const entity = this.repo.create({
      id: randomUUID(),
      title: input.title.trim(),
      description: (input.description ?? '').trim(),
      location: (input.location ?? '').trim(),
      allDay,
      startDate,
      endDate,
      startTime,
      endTime,
      reminderMinutes: input.reminderMinutes === undefined ? 15 : input.reminderMinutes,
      attendeeUserIds,
      attendeeGrades,
      attendeeResponses,
      creatorId: user.userId,
      creatorName: user.displayName || user.username,
      creatorAvatar: user.avatar || '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    await this.repo.save(entity);
    const dto = toDto(entity);
    await this.emitCalendarRealtime('studio_calendar.created', dto, [entity]);
    return dto;
  }

  async update(
    user: AuthUser,
    id: string,
    input: UpdateStudioCalendarEventInput,
  ): Promise<StudioCalendarEventDTO> {
    const existing = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!existing) {
      throw new NotFoundException('工作室日程不存在或已被删除');
    }
    if (existing.creatorId !== user.userId && !user.isCaptain) {
      throw new ForbiddenException('仅日程发起人或工作室队长可以修改该团队日程');
    }

    const prevScope = {
      creatorId: existing.creatorId,
      attendeeUserIds: [...(existing.attendeeUserIds ?? [])],
      attendeeGrades: [...(existing.attendeeGrades ?? [])],
    };

    const nextAllDay = input.allDay ?? existing.allDay;
    const nextStartDate = input.startDate ?? existing.startDate;
    const nextEndDate = input.endDate ?? existing.endDate;
    if (nextEndDate < nextStartDate) {
      throw new BadRequestException('结束日期不能早于开始日期');
    }
    const nextStartTime = input.startTime ?? existing.startTime;
    const nextEndTime = input.endTime ?? existing.endTime;

    if (!nextAllDay && nextEndDate === nextStartDate && nextEndTime <= nextStartTime) {
      throw new BadRequestException('同一天的结束时间必须晚于开始时间');
    }

    existing.title = input.title !== undefined ? input.title.trim() : existing.title;
    existing.description =
      input.description !== undefined ? input.description.trim() : existing.description;
    existing.location = input.location !== undefined ? input.location.trim() : existing.location;
    existing.allDay = nextAllDay;
    existing.startDate = nextStartDate;
    existing.endDate = nextEndDate;
    existing.startTime = nextStartTime;
    existing.endTime = nextEndTime;
    if (input.reminderMinutes !== undefined) {
      existing.reminderMinutes = input.reminderMinutes;
    }

    const attendeesChanged =
      input.attendeeUserIds !== undefined || input.attendeeGrades !== undefined;
    if (input.attendeeUserIds !== undefined) {
      existing.attendeeUserIds = dedupeStrings(input.attendeeUserIds);
    }
    if (input.attendeeGrades !== undefined) {
      existing.attendeeGrades = dedupeGrades(input.attendeeGrades);
    }

    // 变更受邀人/年级后，清理已移出受邀名单成员的残留 RSVP 记录
    if (attendeesChanged && isTargetedStudioEvent(existing) && existing.attendeeResponses) {
      const members = await this.rosterService.listActive();
      const memberById = new Map(members.map((m) => [m.userId, m]));
      const pruned: Record<string, AttendeeResponseStatus> = {};
      for (const [uid, status] of Object.entries(existing.attendeeResponses)) {
        const m = memberById.get(uid) ?? { userId: uid, enrollYear: null };
        if (isMemberInStudioEvent(existing, m)) {
          pruned[uid] = status;
        }
      }
      existing.attendeeResponses = pruned;
    }

    existing.updatedAt = new Date();

    await this.repo.save(existing);
    const dto = toDto(existing);
    await this.emitCalendarRealtime('studio_calendar.updated', dto, [prevScope, existing]);
    return dto;
  }

  /** 成员对某条工作室日程表态（接受 / 待定 / 拒绝），使用 jsonb_set 原子写入并校验受邀权限。 */
  async rsvp(
    user: AuthUser,
    id: string,
    status: AttendeeResponseStatus,
  ): Promise<StudioCalendarEventDTO> {
    const existing = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!existing) {
      throw new NotFoundException('工作室日程不存在或已被删除');
    }

    if (isTargetedStudioEvent(existing)) {
      const members = await this.rosterService.listActive();
      const currentMember = members.find((m) => m.userId === user.userId) ?? {
        userId: user.userId,
        enrollYear: null,
      };
      if (!isMemberInStudioEvent(existing, currentMember)) {
        throw new ForbiddenException('您不在该定向日程的受邀范围内，无法提交回复');
      }
    }

    const now = new Date();
    // 使用 PostgreSQL jsonb_set 单键原子更新，避免多人并发 RSVP 互相覆盖（Lost Update）
    await this.repo
      .createQueryBuilder()
      .update(StudioCalendarEventEntity)
      .set({
        attendeeResponses: () =>
          `jsonb_set(COALESCE(attendee_responses, '{}'::jsonb), ARRAY[:rsvpUserId]::text[], to_jsonb(:rsvpStatus::text), true)`,
        updatedAt: now,
      })
      .where('id = :id AND deleted_at IS NULL', {
        id,
        rsvpUserId: user.userId,
        rsvpStatus: status,
      })
      .execute();

    const fresh = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!fresh) {
      throw new NotFoundException('工作室日程不存在或已被删除');
    }
    const dto = toDto(fresh);
    await this.emitCalendarRealtime('studio_calendar.updated', dto, [fresh]);
    return dto;
  }

  async softDelete(user: AuthUser, id: string): Promise<{ ok: true; id: string }> {
    const existing = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!existing) {
      throw new NotFoundException('工作室日程不存在或已被删除');
    }
    if (existing.creatorId !== user.userId && !user.isCaptain) {
      throw new ForbiddenException('仅日程发起人或工作室队长可以删除该团队日程');
    }

    existing.deletedAt = new Date();
    existing.updatedAt = new Date();
    await this.repo.save(existing);
    await this.emitCalendarRealtime('studio_calendar.deleted', { id }, [existing]);
    return { ok: true, id };
  }

  /** 上报当前成员的课表规则与个人日程公开快照（ON CONFLICT 原子 upsert 防并发主键冲突）。 */
  async upsertFreeBusySnapshot(
    user: AuthUser,
    input: UpsertFreeBusySnapshotInput,
  ): Promise<{ ok: true; updatedAt: string }> {
    const now = new Date();
    await this.busyRepo.upsert(
      {
        userId: user.userId,
        scheduleJson: input.schedule ?? null,
        personalEventsJson: Array.isArray(input.personalEvents) ? input.personalEvents : [],
        updatedAt: now,
      },
      ['userId'],
    );
    return { ok: true, updatedAt: now.toISOString() };
  }

  /** 聚合查询指定日期下所选成员（至少指定成员或年级，并限制单次最多返回 60 人）的忙闲时间轴。 */
  async queryFreeBusy(input: QueryFreeBusyInput): Promise<{
    date: string;
    members: MemberFreeBusyTimelineDTO[];
  }> {
    const targetUserIds = new Set(dedupeStrings(input.userIds));
    const targetGrades = new Set(dedupeGrades(input.grades));
    if (targetUserIds.size === 0 && targetGrades.size === 0) {
      throw new BadRequestException('请至少选择一名成员或一个年级进行忙闲查询');
    }

    const allMembers = await this.rosterService.listActive();
    const matchedMembers = allMembers.filter(
      (m) =>
        targetUserIds.has(m.userId) ||
        (m.enrollYear !== null && targetGrades.has(m.enrollYear)),
    );

    if (matchedMembers.length === 0) {
      return { date: input.date, members: [] };
    }

    // 按请求顺序优先排列明确指定的 userIds，其余按花名册顺序排列并执行上限裁剪
    const orderMap = new Map<string, number>();
    (input.userIds ?? []).forEach((id, idx) => {
      if (!orderMap.has(id)) orderMap.set(id, idx);
    });
    const orderedMembers = [...matchedMembers]
      .sort((a, b) => {
        const oa = orderMap.get(a.userId) ?? Number.MAX_SAFE_INTEGER;
        const ob = orderMap.get(b.userId) ?? Number.MAX_SAFE_INTEGER;
        return oa - ob;
      })
      .slice(0, MAX_FREEBUSY_MEMBERS);

    const memberIds = orderedMembers.map((m) => m.userId);
    const [snapshots, studioEvents] = await Promise.all([
      this.busyRepo.find({ where: { userId: In(memberIds) } }),
      this.repo
        .createQueryBuilder('e')
        .where('e.deleted_at IS NULL')
        .andWhere('e.start_date <= :date', { date: input.date })
        .andWhere('e.end_date >= :date', { date: input.date })
        .getMany(),
    ]);

    const snapshotMap = new Map<string, MemberBusySnapshotEntity>();
    for (const snap of snapshots) {
      snapshotMap.set(snap.userId, snap);
    }

    const filteredStudioEvents = input.excludeEventId
      ? studioEvents.filter((e) => e.id !== input.excludeEventId)
      : studioEvents;

    const members: MemberFreeBusyTimelineDTO[] = orderedMembers.map((member) => {
      const snap = snapshotMap.get(member.userId);
      const blocks: FreeBusyBlockDTO[] = [];

      // 1. 成员课表当日课程
      blocks.push(...expandScheduleSnapshotForDate(snap?.scheduleJson, input.date));

      // 2. 成员个人日程（按当日精确切分跨天非全天时段）
      for (const ev of snap?.personalEventsJson ?? []) {
        if (ev.startDate <= input.date && ev.endDate >= input.date) {
          const sliced = sliceEventForDate(ev, input.date);
          blocks.push({
            id: `per:${ev.id}`,
            kind: 'personal',
            title: ev.title,
            location: ev.location || '',
            allDay: sliced.allDay,
            startTime: sliced.startTime,
            endTime: sliced.endTime,
            color: ev.color || '#2563EB',
            status: 'accepted',
            meta: ev.calendarName || '个人日程',
          });
        }
      }

      // 3. 工作室共享 / 受邀日程（按当日精确切分跨天非全天时段）
      for (const ev of filteredStudioEvents) {
        if (!isMemberInStudioEvent(ev, member)) continue;
        const sliced = sliceEventForDate(ev, input.date);
        const resp =
          ev.attendeeResponses?.[member.userId] ??
          (ev.creatorId === member.userId ? 'accepted' : 'tentative');
        blocks.push({
          id: `std:${ev.id}`,
          kind: 'studio',
          title: ev.title,
          location: ev.location || '',
          allDay: sliced.allDay,
          startTime: sliced.startTime,
          endTime: sliced.endTime,
          color: '#7C3AED',
          status: resp,
          meta: resp === 'tentative' ? '未回复' : resp === 'declined' ? '已谢绝' : '工作室',
        });
      }

      blocks.sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) || a.startTime.localeCompare(b.startTime),
      );

      return {
        userId: member.userId,
        username: member.username,
        displayName: member.displayName || member.username,
        avatar: member.avatar,
        enrollYear: member.enrollYear,
        isCaptain: member.isCaptain,
        hasScheduleSynced: Boolean(snap?.scheduleJson?.courses?.length),
        snapshotUpdatedAt: snap ? new Date(snap.updatedAt).toISOString() : null,
        blocks,
      };
    });

    return { date: input.date, members };
  }
}
