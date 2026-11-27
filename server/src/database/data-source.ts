import { DataSource, type DataSourceOptions } from 'typeorm';
import type { AppConfig } from '../config/env.config.js';
import { OrbitMemberEntity } from '../modules/roster/entities/orbit-member.entity.js';
import { AnnouncementEntity } from '../modules/announcements/entities/announcement.entity.js';
import { AnnouncementReceiptEntity } from '../modules/announcements/entities/announcement-receipt.entity.js';
import { NotificationEntity } from '../modules/notifications/entities/notification.entity.js';
import { NotificationReadEntity } from '../modules/notifications/entities/notification-read.entity.js';
import { MiniAppEntity } from '../modules/miniapps/entities/mini-app.entity.js';
import { MiniAppVersionEntity } from '../modules/miniapps/entities/mini-app-version.entity.js';
import { MiniAppKvEntity } from '../modules/miniapps/entities/mini-app-kv.entity.js';
import { MiniAppPlayRecordEntity } from '../modules/miniapps/entities/mini-app-play-record.entity.js';
import { MiniAppPlayDailyEntity } from '../modules/miniapps/entities/mini-app-play-daily.entity.js';
import { MiniAppRatingEntity } from '../modules/miniapps/entities/mini-app-rating.entity.js';
import { EconomyAccountEntity } from '../modules/economy/entities/economy-account.entity.js';
import { EconomyHoldEntity } from '../modules/economy/entities/economy-hold.entity.js';
import { EconomyLedgerEntryEntity } from '../modules/economy/entities/economy-ledger-entry.entity.js';
import { MiniAppCredentialEntity } from '../modules/economy/entities/mini-app-credential.entity.js';
import { EconomyOrderEntity } from '../modules/economy/entities/economy-order.entity.js';
import { EconomyOrderParticipantEntity } from '../modules/economy/entities/economy-order-participant.entity.js';
import {
  PunchMemberEligibilityEntity,
  PunchNetworkPolicyEntity,
  PunchTeamEntity,
  PunchUserEntity,
} from '../modules/punch/entities/punch-core.entities.js';
import {
  PunchAdjustmentBucketEntity,
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
  PunchPointLedgerEntity,
} from '../modules/punch/entities/punch-attendance.entities.js';
import {
  PunchCardActionArchiveEntity,
  PunchCardGameEntity,
  PunchCardWeekArchiveEntity,
} from '../modules/punch/entities/punch-cards.entities.js';
import {
  PunchAssessmentMembershipEntity,
  PunchAssessmentWeekEntity,
} from '../modules/punch/entities/punch-assessment.entities.js';
import {
  PunchGitHubSourceEntity,
  PunchNotificationEntity,
  PunchNotificationReceiptEntity,
  PunchReportEntity,
  PunchSkinUnlockEntity,
  PunchTeamEventEntity,
  PunchTeamLedgerEntryEntity,
  PunchWeeklyReportRefEntity,
} from '../modules/punch/entities/punch-collab.entities.js';
import {
  MiniAppFunctionBundleEntity,
  MiniAppGlobalKvEntity,
  MiniAppSecretEntity,
} from '../modules/functions/entities/functions.entities.js';
import { InitialSchema1764000000000 } from './migrations/1764000000000-InitialSchema.js';
import { AddPunchTables1764100000000 } from './migrations/1764100000000-AddPunchTables.js';
import { AddMiniAppVersionIconUrl1764200000000 } from './migrations/1764200000000-AddMiniAppVersionIconUrl.js';
import { AddMiniAppFunctions1764300000000 } from './migrations/1764300000000-AddMiniAppFunctions.js';
import { AddOrbitMemberProfileFields1764400000000 } from './migrations/1764400000000-AddOrbitMemberProfileFields.js';
import { AddMiniAppEngagementTables1764500000000 } from './migrations/1764500000000-AddMiniAppEngagementTables.js';
import { AddMiniAppPlayDaily1764600000000 } from './migrations/1764600000000-AddMiniAppPlayDaily.js';

import { AddDutySchedule1764800000000 } from './migrations/1764800000000-AddDutySchedule.js';

export const ALL_ENTITIES = [
  OrbitMemberEntity,
  AnnouncementEntity,
  AnnouncementReceiptEntity,
  NotificationEntity,
  NotificationReadEntity,
  MiniAppEntity,
  MiniAppVersionEntity,
  MiniAppKvEntity,
  MiniAppPlayRecordEntity,
  MiniAppPlayDailyEntity,
  MiniAppRatingEntity,
  EconomyAccountEntity,
  EconomyHoldEntity,
  EconomyLedgerEntryEntity,
  MiniAppCredentialEntity,
  EconomyOrderEntity,
  EconomyOrderParticipantEntity,
  // LecPunch 21 张融合业务表
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
  // Orbit 托管云函数 FaaS 3 张核心表
  MiniAppFunctionBundleEntity,
  MiniAppGlobalKvEntity,
  MiniAppSecretEntity,
];

export const ALL_MIGRATIONS = [
  InitialSchema1764000000000,
  AddPunchTables1764100000000,
  AddMiniAppVersionIconUrl1764200000000,
  AddMiniAppFunctions1764300000000,
  AddOrbitMemberProfileFields1764400000000,
  AddMiniAppEngagementTables1764500000000,
  AddMiniAppPlayDaily1764600000000,
  AddDutySchedule1764800000000,
];

export function buildTypeOrmOptions(cfg: AppConfig): DataSourceOptions {
  if (!cfg.databaseUrl) {
    throw new Error('必须配置 DATABASE_URL（PostgreSQL 连接串）');
  }
  return {
    type: 'postgres',
    url: cfg.databaseUrl,
    entities: ALL_ENTITIES,
    migrations: ALL_MIGRATIONS,
    migrationsRun: cfg.dbRunMigrations,
    synchronize: cfg.dbSynchronize,
    logging: cfg.nodeEnv === 'development' ? ['error', 'warn'] : ['error'],
    extra: {
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    },
  };
}

/** 供 TypeORM CLI 与独立迁移脚本使用的 DataSource 实例。 */
export function createStandaloneDataSource(cfg: AppConfig): DataSource {
  return new DataSource(buildTypeOrmOptions(cfg));
}
