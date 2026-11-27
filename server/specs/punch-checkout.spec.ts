import { describe, expect, it } from 'bun:test';
import type { DataSource, Repository } from 'typeorm';
import type {
  PunchAdjustmentBucketEntity,
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
} from '../src/modules/punch/entities/punch-attendance.entities.js';
import type { PunchUserEntity } from '../src/modules/punch/entities/punch-core.entities.js';
import { PunchAttendanceService } from '../src/modules/punch/punch-attendance.service.js';
import type { PunchAuthUser } from '../src/modules/punch/punch-auth.guard.js';
import type { PunchNetworkPolicyService } from '../src/modules/punch/punch-network-policy.service.js';
import type { PunchPointsService } from '../src/modules/punch/punch-points.service.js';
import type { PunchTitlesService } from '../src/modules/punch/punch-titles.service.js';
import type { PunchUsersService } from '../src/modules/punch/punch-users.service.js';

describe('PunchAttendanceService 异地安全签退与心跳计费截断', () => {
  const user: PunchAuthUser = {
    userId: 'u_zeng',
    ssoSub: 'sub_zeng',
    username: 'zengquanjun',
    displayName: '曾权军',
    teamId: 'team_lec',
    enrollYear: 2024,
    role: 'member',
  };

  function createFixture(initialSession: PunchAttendanceSessionEntity, allowedRef: { value: boolean }) {
    let stored: PunchAttendanceSessionEntity | null = { ...initialSession };
    let lastMintDuration = -1;

    const dataSource = {} as unknown as DataSource;
    const sessionRepo = {
      findOne: async () => (stored && stored.status === 'active' ? { ...stored } : null),
      save: async (next: PunchAttendanceSessionEntity) => {
        stored = { ...next };
        return stored;
      },
    } as unknown as Repository<PunchAttendanceSessionEntity>;

    const adjRepo = {} as unknown as Repository<PunchDurationAdjustmentEntity>;
    const bucketRepo = {} as unknown as Repository<PunchAdjustmentBucketEntity>;
    const userRepo = {} as unknown as Repository<PunchUserEntity>;
    const usersService = {} as unknown as PunchUsersService;

    const networkPolicy = {
      evaluateAccess: async () => ({
        isAllowed: allowedRef.value,
        reason: allowedRef.value ? 'ok' : '未检测到足够的工作室周边 Wi-Fi 信号（匹配 0/2）',
        clientIp: '10.0.0.1',
        ipAllowed: allowedRef.value,
        wifiFingerprintEnabled: true,
        wifiAllowed: allowedRef.value,
        matchedCount: allowedRef.value ? 3 : 0,
        requiredMatchCount: 2,
        configuredAnchorCount: 4,
      }),
    } as unknown as PunchNetworkPolicyService;

    const pointsService = {
      syncAttendancePointsAndMintCoins: async (input: { durationSeconds: number }) => {
        lastMintDuration = input.durationSeconds;
        return { mintedCoins: 10, isFever: false };
      },
    } as unknown as PunchPointsService;

    const titlesService = {
      invalidateTeamCache: () => undefined,
    } as unknown as PunchTitlesService;

    const service = new PunchAttendanceService(
      dataSource,
      sessionRepo,
      adjRepo,
      bucketRepo,
      userRepo,
      networkPolicy,
      pointsService,
      usersService,
      titlesService,
    );

    return {
      service,
      getStored: () => stored,
      getLastMintDuration: () => lastMintDuration,
    };
  }

  it('离开工作室后心跳不再推进 lastCreditedAt，且远程签退允许完成并按最后在岗时间截断结算', async () => {
    const now = Date.now();
    const checkInAt = new Date(now - 2 * 3600_000); // 2 小时前签到
    const lastInStudio = new Date(now - 30 * 60_000); // 30 分钟前离开工作室
    const allowedRef = { value: false };

    const { service, getStored, getLastMintDuration } = createFixture(
      {
        id: 'sess_1',
        teamId: 'team_lec',
        userId: 'u_zeng',
        checkInAt,
        checkOutAt: null,
        lastKeepaliveAt: lastInStudio,
        lastCreditedAt: lastInStudio,
        creditedSeconds: 0,
        pausedAt: null,
        pauseReason: null,
        segmentsCount: 0,
        durationSeconds: null,
        status: 'active',
        invalidReason: null,
        sourceIpAtCheckIn: '10.0.0.1',
        sourceIpAtCheckOut: null,
        weekKey: '2026-11-23',
        weeklyGoalSecondsSnapshot: 18 * 3600,
        isMarked: false,
        createdAt: checkInAt,
        updatedAt: lastInStudio,
      },
      allowedRef,
    );

    // 1. 离开工作室后的心跳不推进 lastCreditedAt
    await service.keepAlive(user, '223.104.1.1', []);
    expect(getStored()?.lastCreditedAt?.getTime()).toBe(lastInStudio.getTime());

    // 2. 离开工作室后直接点签退：不再 403 拒绝，且时长截断为 1.5 小时（5400s），不计入离开后的 30 分钟
    const res = (await service.checkOut(user, '223.104.1.1', [])) as {
      status: string;
      durationSeconds: number;
      remoteCheckOut?: boolean;
      checkOutNotice?: string;
    };
    expect(res.status).toBe('completed');
    expect(res.remoteCheckOut).toBe(true);
    expect(res.durationSeconds).toBe(90 * 60);
    expect(getLastMintDuration()).toBe(90 * 60);
    expect(res.checkOutNotice).toContain('远程签退');
  });

  it('在工作室内正常心跳推进 lastCreditedAt 并按当前时间全额签退', async () => {
    const now = Date.now();
    const checkInAt = new Date(now - 60 * 60_000);
    const oldCredited = new Date(now - 10 * 60_000);
    const allowedRef = { value: true };

    const { service, getStored } = createFixture(
      {
        id: 'sess_2',
        teamId: 'team_lec',
        userId: 'u_zeng',
        checkInAt,
        checkOutAt: null,
        lastKeepaliveAt: oldCredited,
        lastCreditedAt: oldCredited,
        creditedSeconds: 0,
        pausedAt: null,
        pauseReason: null,
        segmentsCount: 0,
        durationSeconds: null,
        status: 'active',
        invalidReason: null,
        sourceIpAtCheckIn: '10.0.0.1',
        sourceIpAtCheckOut: null,
        weekKey: '2026-11-23',
        weeklyGoalSecondsSnapshot: 18 * 3600,
        isMarked: false,
        createdAt: checkInAt,
        updatedAt: oldCredited,
      },
      allowedRef,
    );

    await service.keepAlive(user, '10.0.0.1', []);
    expect((getStored()?.lastCreditedAt?.getTime() ?? 0) > oldCredited.getTime()).toBe(true);

    const res = (await service.checkOut(user, '10.0.0.1', [])) as {
      status: string;
      durationSeconds: number;
      remoteCheckOut?: boolean;
    };
    expect(res.status).toBe('completed');
    expect(res.remoteCheckOut).toBe(false);
    expect(res.durationSeconds).toBeGreaterThanOrEqual(59 * 60);
  });
});
