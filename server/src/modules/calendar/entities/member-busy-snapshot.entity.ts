import { Column, Entity, PrimaryColumn } from 'typeorm';

export interface BusyCourseSlotSnapshot {
  section: number;
  startTime: string;
  endTime: string;
}

export interface BusyCourseMeetingSnapshot {
  id: string;
  dayOfWeek: number;
  startSection: number;
  endSection: number;
  weeks: number[];
  location: string;
  teacher: string;
}

export interface BusyCourseSnapshot {
  id: string;
  name: string;
  color: string;
  meetings: BusyCourseMeetingSnapshot[];
}

export interface BusyScheduleSnapshot {
  scheduleName: string;
  startDate: string;
  totalWeeks: number;
  weekStartDay: number;
  slots: BusyCourseSlotSnapshot[];
  courses: BusyCourseSnapshot[];
}

export interface BusyPersonalEventSnapshot {
  id: string;
  title: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  color: string;
  calendarName: string;
}

/** 工作室成员课表与个人日程公开忙闲快照（用于创建多人日程时在右侧实时对比大家的时间）。 */
@Entity({ name: 'member_busy_snapshots' })
export class MemberBusySnapshotEntity {
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'schedule_json', type: 'jsonb', nullable: true })
  scheduleJson: BusyScheduleSnapshot | null;

  @Column({ name: 'personal_events_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  personalEventsJson: BusyPersonalEventSnapshot[];

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
