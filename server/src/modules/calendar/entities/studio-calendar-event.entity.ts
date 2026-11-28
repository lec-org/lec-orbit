import { Column, DeleteDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export type AttendeeResponseStatus = 'accepted' | 'tentative' | 'declined';

/** 工作室全员/多人共享日程（支持软删除、全天/跨天、按年级或指定成员邀请与回复状态）。 */
@Entity({ name: 'studio_calendar_events' })
@Index('idx_studio_calendar_events_date', ['startDate', 'endDate'], { where: '"deleted_at" IS NULL' })
export class StudioCalendarEventEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id: string;

  @Column({ name: 'title', type: 'text' })
  title: string;

  @Column({ name: 'description', type: 'text', default: '' })
  description: string;

  @Column({ name: 'location', type: 'text', default: '' })
  location: string;

  @Column({ name: 'all_day', type: 'boolean', default: false })
  allDay: boolean;

  @Column({ name: 'start_date', type: 'text' })
  startDate: string;

  @Column({ name: 'end_date', type: 'text' })
  endDate: string;

  @Column({ name: 'start_time', type: 'text', default: '09:00' })
  startTime: string;

  @Column({ name: 'end_time', type: 'text', default: '10:00' })
  endTime: string;

  @Column({ name: 'reminder_minutes', type: 'int', nullable: true, default: 15 })
  reminderMinutes: number | null;

  /** 指定受邀成员 userId 列表；若与 attendeeGrades 均为空则表示全员日程。 */
  @Column({ name: 'attendee_user_ids', type: 'jsonb', default: () => "'[]'::jsonb" })
  attendeeUserIds: string[];

  /** 按年级批量邀请的入学年份列表（例如 [2023, 2024]），用于回显年级胶囊与成员动态归属。 */
  @Column({ name: 'attendee_grades', type: 'jsonb', default: () => "'[]'::jsonb" })
  attendeeGrades: number[];

  /** 成员回复状态映射（userId -> accepted / tentative / declined）。 */
  @Column({ name: 'attendee_responses', type: 'jsonb', default: () => "'{}'::jsonb" })
  attendeeResponses: Record<string, AttendeeResponseStatus>;

  @Column({ name: 'creator_id', type: 'text' })
  creatorId: string;

  @Column({ name: 'creator_name', type: 'text', default: '' })
  creatorName: string;

  @Column({ name: 'creator_avatar', type: 'text', default: '' })
  creatorAvatar: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Index('idx_studio_calendar_events_deleted_at')
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
