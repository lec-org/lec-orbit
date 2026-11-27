import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EconomyModule } from '../economy/economy.module.js';
import { MemberBusySnapshotEntity } from '../calendar/entities/member-busy-snapshot.entity.js';
import { OrbitMemberEntity } from '../roster/entities/orbit-member.entity.js';
import { StorageModule } from '../storage/storage.module.js';
import { OrbitReleaseContributorEntity } from './entities/orbit-release-contributor.entity.js';
import { GitHubContributorSyncService } from './github-contributor-sync.service.js';
import {
  PunchMemberEligibilityEntity,
  PunchNetworkPolicyEntity,
  PunchTeamEntity,
  PunchUserEntity,
} from './entities/punch-core.entities.js';
import {
  PunchAdjustmentBucketEntity,
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
  PunchPointLedgerEntity,
} from './entities/punch-attendance.entities.js';
import {
  PunchCardActionArchiveEntity,
  PunchCardGameEntity,
  PunchCardWeekArchiveEntity,
} from './entities/punch-cards.entities.js';
import {
  PunchAssessmentMembershipEntity,
  PunchAssessmentWeekEntity,
} from './entities/punch-assessment.entities.js';
import {
  PunchGitHubSourceEntity,
  PunchNotificationEntity,
  PunchNotificationReceiptEntity,
  PunchReportEntity,
  PunchSkinUnlockEntity,
  PunchTeamEventEntity,
  PunchTeamLedgerEntryEntity,
  PunchWeeklyReportRefEntity,
} from './entities/punch-collab.entities.js';
import { PunchAuthGuard } from './punch-auth.guard.js';
import { PunchUsersService } from './punch-users.service.js';
import { PunchUsersController } from './punch-users.controller.js';
import { PunchNetworkPolicyService } from './punch-network-policy.service.js';
import { PunchNetworkPolicyController } from './punch-network-policy.controller.js';
import { PunchEligibilityController } from './punch-eligibility.controller.js';
import { PunchPointsController, PunchPointsService } from './punch-points.service.js';
import { PunchAttendanceService } from './punch-attendance.service.js';
import { PunchAttendanceController } from './punch-attendance.controller.js';
import { PunchRecordsController } from './punch-records.controller.js';
import {
  PunchStatsAssessmentController,
  PunchStatsAssessmentService,
} from './punch-stats-assessment.service.js';
import { PunchCardsController, PunchCardsService } from './punch-cards.service.js';
import { PunchTitlesController, PunchTitlesService } from './punch-titles.service.js';
import { PunchWeeklyReportsController } from './punch-weekly-reports.controller.js';
import { PunchTeamOpsController } from './punch-team-ops.controller.js';
import { PunchShopController } from './punch-shop.controller.js';

@Module({
  imports: [
    EconomyModule,
    StorageModule,
    TypeOrmModule.forFeature([
      PunchTeamEntity,
      PunchUserEntity,
      PunchNetworkPolicyEntity,
      PunchMemberEligibilityEntity,
      PunchAttendanceSessionEntity,
      PunchDurationAdjustmentEntity,
      PunchAdjustmentBucketEntity,
      PunchPointLedgerEntity,
      PunchCardGameEntity,
      PunchCardActionArchiveEntity,
      PunchCardWeekArchiveEntity,
      PunchAssessmentWeekEntity,
      PunchAssessmentMembershipEntity,
      PunchNotificationEntity,
      PunchNotificationReceiptEntity,
      PunchReportEntity,
      PunchGitHubSourceEntity,
      PunchWeeklyReportRefEntity,
      PunchTeamEventEntity,
      PunchTeamLedgerEntryEntity,
      PunchSkinUnlockEntity,
      OrbitReleaseContributorEntity,
      MemberBusySnapshotEntity,
      OrbitMemberEntity,
    ]),
  ],
  controllers: [
    PunchUsersController,
    PunchNetworkPolicyController,
    PunchEligibilityController,
    PunchPointsController,
    PunchAttendanceController,
    PunchRecordsController,
    PunchStatsAssessmentController,
    PunchCardsController,
    PunchTitlesController,
    PunchWeeklyReportsController,
    PunchTeamOpsController,
    PunchShopController,
  ],
  providers: [
    PunchAuthGuard,
    PunchUsersService,
    PunchNetworkPolicyService,
    PunchPointsService,
    PunchAttendanceService,
    PunchStatsAssessmentService,
    PunchCardsService,
    GitHubContributorSyncService,
    PunchTitlesService,
  ],
  exports: [
    PunchUsersService,
    PunchPointsService,
    PunchAttendanceService,
    PunchStatsAssessmentService,
  ],
})
export class PunchModule {}
