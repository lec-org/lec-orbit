import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrbitMemberEntity } from './entities/orbit-member.entity.js';
import { RosterService } from './roster.service.js';
import { RosterController } from './roster.controller.js';
import { DutyController } from './duty.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OrbitMemberEntity])],
  controllers: [RosterController, DutyController],
  providers: [RosterService],
  exports: [RosterService],
})
export class RosterModule {}
