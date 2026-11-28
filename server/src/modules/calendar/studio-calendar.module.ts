import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RosterModule } from '../roster/roster.module.js';
import { MemberBusySnapshotEntity } from './entities/member-busy-snapshot.entity.js';
import { StudioCalendarEventEntity } from './entities/studio-calendar-event.entity.js';
import { StudioCalendarController } from './studio-calendar.controller.js';
import { StudioCalendarService } from './studio-calendar.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([StudioCalendarEventEntity, MemberBusySnapshotEntity]),
    RosterModule,
  ],
  controllers: [StudioCalendarController],
  providers: [StudioCalendarService],
  exports: [StudioCalendarService],
})
export class StudioCalendarModule {}
