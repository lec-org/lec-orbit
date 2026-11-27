import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { StudioCalendarService } from './studio-calendar.service.js';

const UuidSchema = z.string().uuid('无效的日程 ID');
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期须为 YYYY-MM-DD');
const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/, '时间须为 HH:mm');
const GradeSchema = z.number().int().min(2015).max(2099);

const ListQuerySchema = z.object({
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
});

const CreateStudioEventSchema = z
  .object({
    title: z.string().trim().min(1, '请输入日程标题').max(120),
    description: z.string().max(1000).optional(),
    location: z.string().max(120).optional(),
    allDay: z.boolean().optional(),
    startDate: DateOnlySchema,
    endDate: DateOnlySchema.optional(),
    startTime: TimeSchema.optional(),
    endTime: TimeSchema.optional(),
    reminderMinutes: z.number().int().min(0).max(1440).nullable().optional(),
    attendeeUserIds: z.array(z.string().min(1)).max(200).optional(),
    attendeeGrades: z.array(GradeSchema).max(20).optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, '结束日期不能早于开始日期');

const UpdateStudioEventSchema = z.object({
  title: z.string().trim().min(1, '日程标题不能为空').max(120).optional(),
  description: z.string().max(1000).optional(),
  location: z.string().max(120).optional(),
  allDay: z.boolean().optional(),
  startDate: DateOnlySchema.optional(),
  endDate: DateOnlySchema.optional(),
  startTime: TimeSchema.optional(),
  endTime: TimeSchema.optional(),
  reminderMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  attendeeUserIds: z.array(z.string().min(1)).max(200).optional(),
  attendeeGrades: z.array(GradeSchema).max(20).optional(),
});

const RsvpSchema = z.object({
  status: z.enum(['accepted', 'tentative', 'declined']),
});

const BusyScheduleSnapshotSchema = z.object({
  scheduleName: z.string().max(100),
  startDate: DateOnlySchema,
  totalWeeks: z.number().int().min(1).max(30),
  weekStartDay: z.number().int().min(1).max(7),
  slots: z
    .array(
      z.object({
        section: z.number().int().min(1).max(24),
        startTime: TimeSchema,
        endTime: TimeSchema,
      }),
    )
    .max(30),
  courses: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(120),
        color: z.string().max(32).default('#6366F1'),
        meetings: z
          .array(
            z.object({
              id: z.string().min(1).max(100),
              dayOfWeek: z.number().int().min(1).max(7),
              startSection: z.number().int().min(1).max(24),
              endSection: z.number().int().min(1).max(24),
              weeks: z.array(z.number().int().min(1).max(30)).max(30),
              location: z.string().max(120).default(''),
              teacher: z.string().max(80).default(''),
            }),
          )
          .max(30),
      }),
    )
    .max(120),
});

const BusyPersonalEventSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  location: z.string().max(120).default(''),
  allDay: z.boolean().default(false),
  startDate: DateOnlySchema,
  endDate: DateOnlySchema,
  startTime: TimeSchema.default('09:00'),
  endTime: TimeSchema.default('10:00'),
  color: z.string().max(32).default('#2563EB'),
  calendarName: z.string().max(60).default('个人日程'),
});

const UpsertFreeBusySnapshotSchema = z.object({
  schedule: BusyScheduleSnapshotSchema.nullable().default(null),
  personalEvents: z.array(BusyPersonalEventSchema).max(500).default([]),
});

const QueryFreeBusySchema = z.object({
  date: DateOnlySchema,
  userIds: z.array(z.string().min(1)).max(200).optional(),
  grades: z.array(GradeSchema).max(20).optional(),
  excludeEventId: z.string().uuid().optional(),
});

/** 工作室共享日历与成员公开忙闲接口（全员可读可发起，仅发起人或队长可修改/删除）。 */
@Controller('api/v1/studio-calendar')
@UseGuards(SsoAuthGuard)
export class StudioCalendarController {
  constructor(private readonly service: StudioCalendarService) {}

  @Get('events')
  async list(@Query() rawQuery: Record<string, unknown>) {
    const query = ListQuerySchema.parse(rawQuery);
    const items = await this.service.list(query);
    return { items };
  }

  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const input = CreateStudioEventSchema.parse(rawBody);
    return this.service.create(user, input);
  }

  @Patch('events/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() rawBody: unknown,
  ) {
    const input = UpdateStudioEventSchema.parse(rawBody);
    return this.service.update(user, UuidSchema.parse(id), input);
  }

  @Post('events/:id/rsvp')
  @HttpCode(HttpStatus.OK)
  rsvp(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() rawBody: unknown,
  ) {
    const { status } = RsvpSchema.parse(rawBody);
    return this.service.rsvp(user, UuidSchema.parse(id), status);
  }

  @Delete('events/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.softDelete(user, UuidSchema.parse(id));
  }

  @Put('freebusy/snapshot')
  @HttpCode(HttpStatus.OK)
  upsertFreeBusySnapshot(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const input = UpsertFreeBusySnapshotSchema.parse(rawBody);
    return this.service.upsertFreeBusySnapshot(user, input);
  }

  @Post('freebusy/query')
  @HttpCode(HttpStatus.OK)
  queryFreeBusy(@Body() rawBody: unknown) {
    const input = QueryFreeBusySchema.parse(rawBody);
    return this.service.queryFreeBusy(input);
  }
}
