/**
 * 考勤打卡核心服务（PostgreSQL TypeORM 版）：
 * - 上卡/签退严格受网络白名单与工作室 Wi-Fi 指纹保护；
 * - 依赖 PostgreSQL 部分唯一索引 (user_id) WHERE status = 'active' 杜绝并发双开；
 * - 单次打卡达到 5 小时自动判为 invalidated（overtime_5h）；
 * - 签退实时触发狂热 +10% 乐币铸币，并支持管理员手动调时（带幂等 requestKey）。
 */
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import {
  PunchAdjustmentBucketEntity,
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
} from './entities/punch-attendance.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import type { PunchAuthUser } from './punch-auth.guard.js';
import {
  PunchNetworkPolicyService,
  type WifiScanSample,
} from './punch-network-policy.service.js';
import { PunchPointsService } from './punch-points.service.js';
import {
  ATTENDANCE_MAX_SECONDS,
  FEVER_ACTIVE_THRESHOLD,
  mondayKeyToIsoWeek,
  newObjectIdHex,
  parseIsoWeekToMondayKey,
  PUNCH_ERROR_CODES,
  weeklyGoalSeconds,
} from './punch-shared.util.js';
import { PunchTitlesService } from './punch-titles.service.js';
import { PunchUsersService } from './punch-users.service.js';

@Injectable()
export class PunchAttendanceService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchAdjustmentBucketEntity)
    private readonly bucketRepo: Repository<PunchAdjustmentBucketEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    private readonly networkPolicy: PunchNetworkPolicyService,
    private readonly pointsService: PunchPointsService,
    private readonly usersService: PunchUsersService,
    private readonly titlesService: PunchTitlesService,
  ) {}

  private getElapsedSeconds(session: PunchAttendanceSessionEntity, now: Date): number {
    return Math.max(0, Math.floor((now.getTime() - session.checkInAt.getTime()) / 1000));
  }

  private async invalidateIfOvertime(
    session: PunchAttendanceSessionEntity,
    now: Date,
    checkOutIp?: string,
  ): Promise<boolean> {
    const elapsed = this.getElapsedSeconds(session, now);
    if (elapsed < ATTENDANCE_MAX_SECONDS) return false;
    session.status = 'invalidated';
    session.invalidReason = 'overtime_5h';
    session.durationSeconds = 0;
    session.checkOutAt = new Date(session.checkInAt.getTime() + ATTENDANCE_MAX_SECONDS * 1000);
    if (checkOutIp) session.sourceIpAtCheckOut = checkOutIp;
    session.updatedAt = now;
    await this.sessionRepo.save(session);
    return true;
  }

  async getCurrentSession(userId: string) {
    const session = await this.sessionRepo.findOne({ where: { userId, status: 'active' } });
    if (!session) return null;
    const now = new Date();
    if (await this.invalidateIfOvertime(session, now)) return null;
    return {
      ...session,
      isPaused: false,
      elapsedSeconds: this.getElapsedSeconds(session, now),
    };
  }

  async getTeamActive(teamId: string) {
    const now = new Date();
    const activeSessions = await this.sessionRepo.find({
      where: { teamId, status: 'active' },
      order: { checkInAt: 'ASC' },
    });

    const live: PunchAttendanceSessionEntity[] = [];
    for (const s of activeSessions) {
      if (!(await this.invalidateIfOvertime(s, now))) {
        live.push(s);
      }
    }

    const [members, titlesByUserId] = await Promise.all([
      this.userRepo.find({ where: { teamId } }),
      this.titlesService.getTeamDisplayTitlesByUserId(teamId).catch(() => undefined),
    ]);
    const byId = new Map(members.map((m) => [m.id, m]));

    const items = live.map((s) => {
      const m = byId.get(s.userId);
      return {
        sessionId: s.id,
        memberKey: this.usersService.getMemberKey(s.userId),
        userId: s.userId,
        username: m?.username ?? '',
        displayName: m?.displayName ?? '成员',
        realName: m?.realName ?? undefined,
        avatarUrl: m?.avatarUrl ?? undefined,
        avatarBase64: m?.avatarBase64 ?? undefined,
        avatarColor: m?.avatarColor ?? undefined,
        avatarEmoji: m?.avatarEmoji ?? undefined,
        enrollYear: m?.enrollYear ?? 0,
        equippedTitleId: m?.equippedTitleId ?? undefined,
        titles: titlesByUserId?.get(s.userId) ?? [],
        weekKey: s.weekKey,
        checkInAt: s.checkInAt.toISOString(),
        elapsedSeconds: this.getElapsedSeconds(s, now),
      };
    });

    return {
      items,
      activeCount: items.length,
      feverThreshold: FEVER_ACTIVE_THRESHOLD,
      isFever: items.length >= FEVER_ACTIVE_THRESHOLD,
      serverTime: now.toISOString(),
    };
  }

  async checkIn(user: PunchAuthUser, clientIp: string, wifiScan?: WifiScanSample[]) {
    await this.networkPolicy.assertAllowed(user.teamId, clientIp, wifiScan);

    const existing = await this.sessionRepo.findOne({
      where: { userId: user.userId, status: 'active' },
    });
    const now = new Date();
    if (existing && !(await this.invalidateIfOvertime(existing, now))) {
      throw new BadRequestException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_ALREADY_CHECKED_IN,
        message: '当前已有进行中的打卡',
      });
    }

    const session = this.sessionRepo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      userId: user.userId,
      checkInAt: now,
      checkOutAt: null,
      lastKeepaliveAt: now,
      lastCreditedAt: now,
      creditedSeconds: 0,
      pausedAt: null,
      pauseReason: null,
      segmentsCount: 1,
      durationSeconds: null,
      status: 'active',
      invalidReason: null,
      sourceIpAtCheckIn: clientIp,
      sourceIpAtCheckOut: null,
      weekKey: getShanghaiWeekKey(now),
      weeklyGoalSecondsSnapshot: weeklyGoalSeconds(user.enrollYear),
      isMarked: false,
      createdAt: now,
      updatedAt: now,
    });

    try {
      await this.sessionRepo.save(session);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        throw new BadRequestException({
          code: PUNCH_ERROR_CODES.ATTENDANCE_ALREADY_CHECKED_IN,
          message: '当前已有进行中的打卡',
        });
      }
      throw err;
    }

    this.titlesService.invalidateTeamCache(user.teamId);
    return session;
  }

  async checkOut(user: PunchAuthUser, clientIp: string, wifiScan?: WifiScanSample[]) {
    const session = await this.sessionRepo.findOne({
      where: { userId: user.userId, status: 'active' },
    });
    if (!session) {
      throw new BadRequestException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_NO_ACTIVE_SESSION,
        message: '当前没有进行中的打卡',
      });
    }

    const now = new Date();
    if (await this.invalidateIfOvertime(session, now, clientIp)) {
      return session;
    }

    // 签退不再因离开工作室环境而 403 拒绝（避免卡死无法退卡与心跳循环骚扰）：
    // - 在工作室内：按当前时间正常结算；
    // - 已离开工作室：允许立即远程签退，但将结算截止时间截断至最后一次确认在工作室内时间（lastCreditedAt），防止离场继续挂机刷时长。
    const environment = await this.networkPolicy.evaluateAccess(user.teamId, clientIp, wifiScan);
    const remoteCheckOut = !environment.isAllowed;
    const rawCredited = session.lastCreditedAt ?? session.checkInAt;
    const effectiveEnd = remoteCheckOut
      ? new Date(
          Math.max(
            session.checkInAt.getTime(),
            Math.min(now.getTime(), rawCredited.getTime()),
          ),
        )
      : now;

    const durationSeconds = this.getElapsedSeconds(session, effectiveEnd);
    session.status = 'completed';
    session.durationSeconds = durationSeconds;
    session.checkOutAt = effectiveEnd;
    session.sourceIpAtCheckOut = clientIp;
    session.updatedAt = now;
    await this.sessionRepo.save(session);

    const reward = await this.pointsService.syncAttendancePointsAndMintCoins({
      teamId: session.teamId,
      userId: session.userId,
      ssoSub: user.ssoSub,
      attendanceSessionId: session.id,
      weekKey: session.weekKey,
      durationSeconds,
      isValid: true,
      window: { start: session.checkInAt, end: effectiveEnd },
    });

    this.titlesService.invalidateTeamCache(session.teamId);

    return {
      ...session,
      earnedCoins: reward.mintedCoins,
      isFeverBonus: reward.isFever,
      remoteCheckOut,
      settledAt: effectiveEnd.toISOString(),
      checkOutNotice: remoteCheckOut
        ? '已远程签退，本次专注时长已按最后一次确认在工作室内的时间结算。'
        : undefined,
    };
  }

  async keepAlive(user: PunchAuthUser, clientIp?: string, wifiScan?: WifiScanSample[]) {
    const session = await this.sessionRepo.findOne({
      where: { userId: user.userId, status: 'active' },
    });
    if (!session) {
      throw new BadRequestException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_NO_ACTIVE_SESSION,
        message: '当前没有进行中的打卡',
      });
    }
    const now = new Date();
    if (await this.invalidateIfOvertime(session, now, clientIp)) {
      throw new BadRequestException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_SESSION_INVALIDATED,
        message: '本次打卡超过 5 小时上限已自动失效',
      });
    }

    const environment =
      clientIp !== undefined
        ? await this.networkPolicy.evaluateAccess(user.teamId, clientIp, wifiScan)
        : undefined;

    session.lastKeepaliveAt = now;
    // 仅在确认仍处于工作室环境内时推进 lastCreditedAt，供离场后远程签退时精准截断有效时长
    if (!environment || environment.isAllowed) {
      session.lastCreditedAt = now;
    }
    session.updatedAt = now;
    await this.sessionRepo.save(session);

    return {
      ...session,
      elapsedSeconds: this.getElapsedSeconds(session, now),
      ...(environment ? { environment } : {}),
    };
  }

  async getMyWeeklySummary(user: PunchAuthUser, requestedWeek?: string) {
    const mondayKey = parseIsoWeekToMondayKey(requestedWeek);
    if (!mondayKey) {
      throw new BadRequestException('无效的周标识');
    }

    const dayRows = (await this.sessionRepo.query(
      `SELECT TO_CHAR(check_in_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date,
              COALESCE(SUM(duration_seconds), 0)::int AS "focusedSeconds",
              COUNT(*)::int AS sessions
       FROM punch_attendance_sessions
       WHERE team_id = $1 AND user_id = $2 AND week_key = $3 AND status <> 'active'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [user.teamId, user.userId, mondayKey],
    )) as Array<{ date: string; focusedSeconds: number; sessions: number }>;

    const adjustments = await this.adjRepo.find({
      where: { teamId: user.teamId, userId: user.userId, weekKey: mondayKey },
      order: { createdAt: 'DESC' },
    });

    const recordedFocusedSeconds = dayRows.reduce((s, r) => s + Number(r.focusedSeconds), 0);
    const manualAdjustmentSeconds = adjustments.reduce((s, a) => s + a.signedDurationSeconds, 0);
    const totalFocusedSeconds = Math.max(0, recordedFocusedSeconds + manualAdjustmentSeconds);
    const isoWeek = mondayKeyToIsoWeek(mondayKey);
    const days = dayRows.map((r) => ({
      date: r.date,
      focusedMinutes: Math.floor(Number(r.focusedSeconds) / 60),
      sessions: Number(r.sessions),
      points: Math.floor(Number(r.focusedSeconds) / 60),
    }));

    return {
      week: isoWeek,
      weekKey: mondayKey,
      totalFocusedMinutes: Math.floor(totalFocusedSeconds / 60),
      rawFocusedMinutes: Math.floor(recordedFocusedSeconds / 60),
      adjustedMinutes: Math.trunc(manualAdjustmentSeconds / 60),
      adjustmentsCount: adjustments.length,
      checkedInDays: days.length,
      days,
      recordedFocusedSeconds,
      manualAdjustmentSeconds,
      totalFocusedSeconds,
      totalPoints: Math.floor(recordedFocusedSeconds / 60),
      adjustments: adjustments.map((a) => ({
        adjustmentId: a.id,
        operation: a.operation,
        durationSeconds: a.durationSeconds,
        signedDurationSeconds: a.signedDurationSeconds,
        reason: a.reason,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  /** 管理员打开调时弹窗前查询单人本周实时考勤时长与调时上下文。 */
  async getAdjustmentContext(admin: PunchAuthUser, targetUserId: string) {
    const target = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('请选择有效成员');
    if (target.teamId !== admin.teamId) {
      throw new ForbiddenException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_CROSS_TEAM_FORBIDDEN,
        message: '不可调整其他团队成员',
      });
    }
    if (target.status !== 'active') {
      throw new BadRequestException('不可调整已停用成员');
    }

    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const [[recRow], [adjRow]] = await Promise.all([
      this.sessionRepo.query(
        `SELECT COALESCE(SUM(duration_seconds), 0)::int AS secs
         FROM punch_attendance_sessions
         WHERE team_id = $1 AND user_id = $2 AND week_key = $3 AND status <> 'active'`,
        [admin.teamId, target.id, weekKey],
      ) as Promise<[{ secs: number }]>,
      this.adjRepo.query(
        `SELECT COALESCE(SUM(signed_duration_seconds), 0)::int AS secs
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND user_id = $2 AND week_key = $3`,
        [admin.teamId, target.id, weekKey],
      ) as Promise<[{ secs: number }]>,
    ]);

    const recordedDurationSeconds = Number(recRow?.secs ?? 0);
    const manualAdjustmentSeconds = Number(adjRow?.secs ?? 0);
    return {
      userId: target.id,
      weekKey,
      isoWeek: mondayKeyToIsoWeek(weekKey),
      recordedDurationSeconds,
      manualAdjustmentSeconds,
      totalDurationSeconds: recordedDurationSeconds + manualAdjustmentSeconds,
    };
  }

  /** 管理员调整成员本周打卡时长（支持 requestKey 幂等与 PostgreSQL 事务原子更新）。 */
  async adjustCurrentWeekDuration(
    admin: PunchAuthUser,
    input: {
      userId: string;
      operation: 'add' | 'subtract';
      durationSeconds: number;
      reason?: string;
      requestKey?: string;
    },
  ) {
    const target = await this.userRepo.findOne({ where: { id: input.userId } });
    if (!target) throw new NotFoundException('目标成员不存在');
    if (target.teamId !== admin.teamId) {
      throw new ForbiddenException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_CROSS_TEAM_FORBIDDEN,
        message: '禁止跨团队调整时长',
      });
    }

    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const signedSeconds =
      input.operation === 'add' ? input.durationSeconds : -input.durationSeconds;
    const reqKey = (input.requestKey ?? '').trim() || newObjectIdHex();
    const reqHash = createHash('sha256')
      .update(JSON.stringify({ u: input.userId, op: input.operation, s: input.durationSeconds }))
      .digest('hex');

    return this.dataSource.transaction(async (manager) => {
      let bucket = await manager
        .createQueryBuilder(PunchAdjustmentBucketEntity, 'b')
        .setLock('pessimistic_write')
        .where('b.team_id = :teamId AND b.user_id = :userId AND b.week_key = :weekKey', {
          teamId: admin.teamId,
          userId: target.id,
          weekKey,
        })
        .getOne();

      if (bucket) {
        const dup = bucket.entries.find((e) => e.requestKey === reqKey);
        if (dup) {
          if (dup.requestHash !== reqHash) {
            throw new ConflictException('重复的 requestKey 但调整参数不一致');
          }
          return dup;
        }
      }

      const [recRow] = (await manager.query(
        `SELECT COALESCE(SUM(duration_seconds), 0)::int AS secs
         FROM punch_attendance_sessions
         WHERE team_id = $1 AND user_id = $2 AND week_key = $3 AND status = 'completed'`,
        [admin.teamId, target.id, weekKey],
      )) as [{ secs: number }];
      const [adjRow] = (await manager.query(
        `SELECT COALESCE(SUM(signed_duration_seconds), 0)::int AS secs
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND user_id = $2 AND week_key = $3`,
        [admin.teamId, target.id, weekKey],
      )) as [{ secs: number }];

      const previousDurationSeconds = Number(recRow?.secs ?? 0) + Number(adjRow?.secs ?? 0);
      if (previousDurationSeconds < 0 && input.operation !== 'add') {
        throw new ConflictException('余额异常，只能增加时长补正至非负');
      }
      if (previousDurationSeconds + signedSeconds < 0) {
        throw new BadRequestException({
          code: 'ATTENDANCE_DURATION_CANNOT_BE_NEGATIVE',
          message: '扣减后的当前周打卡时长不能低于 0',
        });
      }
      const resultingDurationSeconds = previousDurationSeconds + signedSeconds;
      const id = newObjectIdHex();

      const adj = manager.create(PunchDurationAdjustmentEntity, {
        id,
        teamId: admin.teamId,
        userId: target.id,
        username: target.username,
        weekKey,
        operation: input.operation,
        durationSeconds: input.durationSeconds,
        signedDurationSeconds: signedSeconds,
        previousDurationSeconds,
        resultingDurationSeconds,
        createdBy: admin.userId,
        reason: input.reason?.trim() || null,
        createdAt: now,
        updatedAt: now,
      });
      await manager.save(PunchDurationAdjustmentEntity, adj);

      const entry = {
        id,
        requestKey: reqKey,
        requestHash: reqHash,
        username: target.username,
        operation: input.operation,
        durationSeconds: input.durationSeconds,
        signedDurationSeconds: signedSeconds,
        previousDurationSeconds,
        resultingDurationSeconds,
        reason: input.reason?.trim() || undefined,
        createdBy: admin.userId,
        createdAt: now.toISOString(),
      };

      if (!bucket) {
        bucket = manager.create(PunchAdjustmentBucketEntity, {
          id: newObjectIdHex(),
          teamId: admin.teamId,
          userId: target.id,
          weekKey,
          version: 1,
          entries: [entry],
        });
      } else {
        bucket.version += 1;
        bucket.entries = [...bucket.entries, entry];
      }
      await manager.save(PunchAdjustmentBucketEntity, bucket);

      this.titlesService.invalidateTeamCache(admin.teamId);
      return entry;
    });
  }

  async listWeeklyAdjustments(teamId: string, weekKey?: string) {
    const key = parseIsoWeekToMondayKey(weekKey) ?? getShanghaiWeekKey(new Date());
    const rows = await this.adjRepo.find({
      where: { teamId, weekKey: key },
      order: { createdAt: 'DESC' },
    });
    return { weekKey: key, items: rows };
  }
}
