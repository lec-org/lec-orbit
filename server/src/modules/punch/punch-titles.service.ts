/**
 * 工作室称号系统服务（PostgreSQL TypeORM 版，完整实现 22 项自动判定称号、
 * 课表快照与兜底接入、GitHub Release PR 贡献者统计、长期称号持久化、显隐开关、30 秒团队快照缓存与全员亮牌徽章映射）。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { z } from 'zod';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import {
  MemberBusySnapshotEntity,
  type BusyScheduleSnapshot,
} from '../calendar/entities/member-busy-snapshot.entity.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { OrbitMemberEntity } from '../roster/entities/orbit-member.entity.js';
import {
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
} from './entities/punch-attendance.entities.js';
import {
  PunchCardActionArchiveEntity,
  PunchCardGameEntity,
  PunchCardWeekArchiveEntity,
} from './entities/punch-cards.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { GitHubContributorSyncService } from './github-contributor-sync.service.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import { CARD_CATALOG } from './punch-card-engine.js';
import { assessmentEnrollYears } from './punch-shared.util.js';
import {
  TITLE_BY_ID,
  TITLE_CATALOG,
  toMemberTitleBadge,
  type MemberTitleBadge,
  type TitleDefinition,
  type TitleEvaluationItem,
} from './punch-title-catalog.js';
import {
  addShanghaiDays,
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  extractGambleEventFromReceipt,
  getTitleLookbackStartDate,
  hasSsrPityInReceipt,
  shanghaiDayStartMs,
  type MemberTitleEvaluation,
  type TitleEngineCardInteraction,
  type TitleEngineGambleEvent,
  type TitleEngineSession,
} from './punch-title-engine.js';
import { PunchUsersService } from './punch-users.service.js';

export {
  TITLE_BY_ID,
  TITLE_CATALOG,
  toMemberTitleBadge,
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  extractGambleEventFromReceipt,
  hasSsrPityInReceipt,
  type MemberTitleBadge,
  type TitleDefinition,
  type TitleEvaluationItem,
};

const TEAM_CACHE_TTL_MS = 30_000;

interface CachedTeamTitles {
  computedAt: number;
  weekKey: string;
  byUserId: Map<string, MemberTitleEvaluation>;
}

const EquipTitleSchema = z.object({
  titleId: z.string().trim().nullable().optional(),
});

const ToggleTitleVisibilitySchema = z.object({
  titleId: z.string().trim().min(1),
  hidden: z.boolean(),
});

interface CardTitleDataBundle {
  currentWeekCardInteractions: TitleEngineCardInteraction[];
  gambleEventsByUser: Map<string, TitleEngineGambleEvent[]>;
  ssrPityUsers: Set<string>;
  discoveredCardCountByUser: Map<string, number>;
  entertainmentByUserWeek: Map<string, number>;
}

@Injectable()
export class PunchTitlesService {
  private readonly logger = new Logger(PunchTitlesService.name);
  private readonly teamCache = new Map<string, CachedTeamTitles>();

  constructor(
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchCardGameEntity)
    private readonly cardGameRepo: Repository<PunchCardGameEntity>,
    @InjectRepository(PunchCardWeekArchiveEntity)
    private readonly cardWeekArchiveRepo: Repository<PunchCardWeekArchiveEntity>,
    @InjectRepository(PunchCardActionArchiveEntity)
    private readonly cardActionArchiveRepo: Repository<PunchCardActionArchiveEntity>,
    @InjectRepository(MemberBusySnapshotEntity)
    private readonly busySnapshotRepo: Repository<MemberBusySnapshotEntity>,
    @InjectRepository(OrbitMemberEntity)
    private readonly orbitMemberRepo: Repository<OrbitMemberEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
    private readonly githubContributorSync: GitHubContributorSyncService,
  ) {}

  /** 考勤签退/调时/佩戴称号变更后主动失效团队快照缓存。 */
  invalidateTeamCache(teamId: string): void {
    this.teamCache.delete(teamId);
  }

  /** 获取当前登录成员的完整称号面板（非近三级成员仍可浏览全量 22 项称号图鉴，但不参与解锁与佩戴）。 */
  async getMyTitles(teamId: string, userId: string) {
    const snapshot = await this.computeTeamSnapshot(teamId, true);
    const mine = snapshot.byUserId.get(userId);
    if (!mine) {
      return {
        weekKey: snapshot.weekKey,
        eligible: false,
        equippedTitleId: null,
        hiddenTitleIds: [],
        displayTitles: [],
        catalog: TITLE_CATALOG.map((def) => ({
          ...toMemberTitleBadge(def),
          unlocked: false,
          equipped: false,
          ...(def.hideable ? { hidden: false } : {}),
          progressText: '仅大一至大三可解锁',
        })),
      };
    }
    return {
      weekKey: snapshot.weekKey,
      eligible: true,
      equippedTitleId: mine.equippedTitleId,
      hiddenTitleIds: mine.hiddenTitleIds,
      displayTitles: mine.displayTitles,
      catalog: mine.catalog,
    };
  }

  /** 手动佩戴或恢复自动佩戴称号，返回最新完整称号面板。 */
  async equipTitle(teamId: string, userId: string, rawTitleId?: string | null) {
    const trimmed = typeof rawTitleId === 'string' ? rawTitleId.trim() : '';
    const titleId = trimmed.length > 0 ? trimmed : null;

    if (titleId !== null) {
      const def = TITLE_BY_ID.get(titleId);
      if (!def) {
        throw new BadRequestException('指定的称号不存在');
      }
      if (def.forced) {
        throw new BadRequestException('状态类称号由系统自动亮牌，无需手动佩戴');
      }
      const current = await this.computeTeamSnapshot(teamId, true);
      const mine = current.byUserId.get(userId);
      const item = mine?.catalog.find((entry) => entry.id === titleId);
      if (!item?.unlocked) {
        throw new BadRequestException(`尚未解锁「${def.name}」称号`);
      }
    }

    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) {
      throw new BadRequestException('用户不存在');
    }
    member.equippedTitleId = titleId;
    // 若佩戴的称号此前被成员关闭展示，佩戴时自动重新开启
    if (titleId && Array.isArray(member.hiddenTitleIds) && member.hiddenTitleIds.includes(titleId)) {
      member.hiddenTitleIds = member.hiddenTitleIds.filter((id) => id !== titleId);
    }
    member.updatedAt = new Date();
    await this.userRepo.save(member);

    this.invalidateTeamCache(teamId);
    return this.getMyTitles(teamId, userId);
  }

  /** 开启或关闭某个可隐藏称号的展示状态（默认打开，关闭后不再出现在亮牌与自动佩戴中）。 */
  async setTitleVisibility(
    teamId: string,
    userId: string,
    titleId: string,
    hidden: boolean,
  ) {
    const def = TITLE_BY_ID.get(titleId);
    if (!def) {
      throw new BadRequestException('指定的称号不存在');
    }
    if (!def.hideable) {
      throw new BadRequestException(`「${def.name}」不支持手动关闭展示`);
    }

    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) {
      throw new BadRequestException('用户不存在');
    }

    const currentHidden = new Set(Array.isArray(member.hiddenTitleIds) ? member.hiddenTitleIds : []);
    if (hidden) {
      currentHidden.add(titleId);
      if (member.equippedTitleId === titleId) {
        member.equippedTitleId = null;
      }
    } else {
      currentHidden.delete(titleId);
    }

    member.hiddenTitleIds = [...currentHidden];
    member.updatedAt = new Date();
    await this.userRepo.save(member);

    this.invalidateTeamCache(teamId);
    return this.getMyTitles(teamId, userId);
  }

  /** 按内部 userId 返回团队所有成员的展示亮牌数组（供在线打卡榜、周榜挂载）。 */
  async getTeamDisplayTitlesByUserId(teamId: string): Promise<Map<string, MemberTitleBadge[]>> {
    const snapshot = await this.computeTeamSnapshot(teamId, false);
    const result = new Map<string, MemberTitleBadge[]>();
    for (const [userId, evalResult] of snapshot.byUserId.entries()) {
      result.set(userId, evalResult.displayTitles);
    }
    return result;
  }

  /** 按签名 memberKey 返回团队所有成员的展示亮牌映射（供 GET /titles/team 返回）。 */
  async getTeamDisplayTitlesByMemberKey(
    teamId: string,
  ): Promise<Record<string, MemberTitleBadge[]>> {
    const snapshot = await this.computeTeamSnapshot(teamId, false);
    const result: Record<string, MemberTitleBadge[]> = {};
    for (const [userId, evalResult] of snapshot.byUserId.entries()) {
      result[this.usersService.getMemberKey(userId)] = evalResult.displayTitles;
    }
    return result;
  }

  /** 一次性聚合卡牌娱乐时长、交易时长、图鉴收集数、本周跨人交互、全历史赌狗卡与 SSR 保底记录。 */
  private async loadCardTitleDataBundle(
    teamId: string,
    members: PunchUserEntity[],
    weekKeys: string[],
    currentWeekStartMs: number,
  ): Promise<CardTitleDataBundle> {
    const [game, archivedWeeks, archivedReceipts, ...tradeSummaries] = await Promise.all([
      this.cardGameRepo.findOne({ where: { teamId } }),
      this.cardWeekArchiveRepo.find({
        where: { teamId, weekKey: In(weekKeys) },
      }),
      this.cardActionArchiveRepo.find({
        where: { teamId },
        select: {
          receiptKey: true,
          actorId: true,
          at: true,
          result: true,
          gift: true,
        },
      }),
      ...weekKeys.map((wk) => this.economyLedger.getWeeklyTradeMinutesSummary(wk)),
    ]);

    // 1. 娱乐时长 + 交易时长
    const cardByUserWeek = new Map<string, number>();
    for (const row of archivedWeeks) {
      const secs = Number(
        (row.week as { entertainmentSeconds?: number } | null)?.entertainmentSeconds ?? 0,
      );
      if (Number.isFinite(secs)) {
        cardByUserWeek.set(`${row.userId}:${row.weekKey}`, secs);
      }
    }

    const discoveredCardCountByUser = new Map<string, number>();
    const stateMembers = (game?.state?.members ?? {}) as Record<
      string,
      {
        discovered?: string[];
        weeks?: Record<string, { entertainmentSeconds?: number }>;
      }
    >;
    for (const [uid, mState] of Object.entries(stateMembers)) {
      if (Array.isArray(mState?.discovered)) {
        discoveredCardCountByUser.set(uid, new Set(mState.discovered).size);
      }
      for (const wk of weekKeys) {
        const weekEntry = mState?.weeks?.[wk];
        if (weekEntry && typeof weekEntry.entertainmentSeconds === 'number') {
          cardByUserWeek.set(`${uid}:${wk}`, weekEntry.entertainmentSeconds);
        }
      }
    }

    const entertainmentByUserWeek = new Map<string, number>();
    weekKeys.forEach((wk, idx) => {
      const summary = tradeSummaries[idx];
      const tradeMap = new Map(
        (summary?.items ?? []).map((item) => [item.userId, item.tradeMinutes]),
      );
      for (const member of members) {
        const cardSec = cardByUserWeek.get(`${member.id}:${wk}`) ?? 0;
        const tradeMin = tradeMap.get(member.logtoUserId || member.id) ?? 0;
        const totalEnt = cardSec + (summary?.affectsAssessment ? tradeMin * 60 : 0);
        if (totalEnt !== 0) {
          entertainmentByUserWeek.set(`${member.id}:${wk}`, totalEnt);
        }
      }
    });

    // 2. 合并归档回执与实时 receipts：提取本周交互、全历史赌狗卡胜负、全历史 SSR 大保底
    const currentWeekCardInteractions: TitleEngineCardInteraction[] = [];
    const gambleEventsByUser = new Map<string, TitleEngineGambleEvent[]>();
    const ssrPityUsers = new Set<string>();
    const seenReceiptKeys = new Set<string>();

    const processReceipt = (receipt: {
      actorId?: string;
      at?: string;
      result?: Record<string, unknown> | null;
      gift?: Record<string, unknown> | null;
    }) => {
      const atMs = receipt.at ? Date.parse(receipt.at) : Number.NaN;
      if (!Number.isNaN(atMs) && atMs >= currentWeekStartMs) {
        currentWeekCardInteractions.push(...extractCardInteractionsFromReceipt(receipt));
      }

      const gamble = extractGambleEventFromReceipt(receipt);
      if (gamble) {
        const list = gambleEventsByUser.get(gamble.actorId) ?? [];
        list.push(gamble.event);
        gambleEventsByUser.set(gamble.actorId, list);
      }

      if (receipt.actorId && hasSsrPityInReceipt(receipt)) {
        ssrPityUsers.add(receipt.actorId);
      }
    };

    for (const row of archivedReceipts) {
      if (row.receiptKey) seenReceiptKeys.add(row.receiptKey);
      processReceipt({
        actorId: row.actorId,
        at: row.at,
        result: row.result,
        gift: row.gift,
      });
    }

    const receipts = game?.receipts as
      | Record<
          string,
          {
            actorId?: string;
            at?: string;
            result?: Record<string, unknown>;
            gift?: Record<string, unknown>;
          }
        >
      | undefined;
    if (receipts && typeof receipts === 'object') {
      for (const [key, receipt] of Object.entries(receipts)) {
        if (seenReceiptKeys.has(key) || !receipt) continue;
        processReceipt(receipt);
      }
    }

    return {
      currentWeekCardInteractions,
      gambleEventsByUser,
      ssrPityUsers,
      discoveredCardCountByUser,
      entertainmentByUserWeek,
    };
  }

  /** 计算（或命中 30 秒缓存）全团队成员的 22 项称号评估快照，并自动持久化新解锁的长期称号。 */
  private async computeTeamSnapshot(teamId: string, bypassCache: boolean): Promise<CachedTeamTitles> {
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const cached = this.teamCache.get(teamId);
    if (
      !bypassCache &&
      cached &&
      cached.weekKey === weekKey &&
      Date.now() - cached.computedAt < TEAM_CACHE_TTL_MS
    ) {
      return cached;
    }

    const allActive = await this.userRepo.find({ where: { teamId, status: 'active' } });
    const ssoActive = allActive.filter((m) => Boolean(m.logtoUserId));
    // 称号体系仅针对大一至大三（最近 3 级），其他往届成员不纳入计算
    const eligibleGrades = new Set(assessmentEnrollYears(ssoActive.map((m) => m.enrollYear)));
    const members = ssoActive.filter((m) => eligibleGrades.has(m.enrollYear));
    if (members.length === 0) {
      const empty: CachedTeamTitles = { computedAt: Date.now(), weekKey, byUserId: new Map() };
      this.teamCache.set(teamId, empty);
      return empty;
    }

    const lookbackStart = getTitleLookbackStartDate(now);
    const prevWeek1Key = addShanghaiDays(weekKey, -7);
    const prevWeek2Key = addShanghaiDays(weekKey, -14);
    const targetWeeks = [weekKey, prevWeek1Key, prevWeek2Key];
    const currentWeekStartMs = shanghaiDayStartMs(weekKey, 0);
    const ssoIds = members
      .map((m) => m.logtoUserId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const [rawSessions, adjRows, cardBundle, busySnapshots, orbitMembers, releaseContributors] =
      await Promise.all([
        this.sessionRepo.find({
          where: {
            teamId,
            status: Not('invalidated'),
            checkInAt: MoreThanOrEqual(lookbackStart),
          },
          select: {
            userId: true,
            checkInAt: true,
            checkOutAt: true,
            durationSeconds: true,
            status: true,
            weekKey: true,
          },
        }),
        this.adjRepo.query(
          `SELECT user_id AS "userId",
                  week_key AS "weekKey",
                  COALESCE(SUM(signed_duration_seconds), 0)::int AS "manualSeconds"
           FROM punch_attendance_duration_adjustments
           WHERE team_id = $1 AND week_key = ANY($2::text[])
           GROUP BY user_id, week_key`,
          [teamId, targetWeeks],
        ) as Promise<Array<{ userId: string; weekKey: string; manualSeconds: number }>>,
        this.loadCardTitleDataBundle(teamId, members, targetWeeks, currentWeekStartMs),
        ssoIds.length > 0
          ? this.busySnapshotRepo.find({ where: { userId: In(ssoIds) } })
          : Promise.resolve([] as MemberBusySnapshotEntity[]),
        ssoIds.length > 0
          ? this.orbitMemberRepo.find({ where: { userId: In(ssoIds) } })
          : Promise.resolve([] as OrbitMemberEntity[]),
        this.githubContributorSync.listReleaseContributors(),
      ]);

    const manualAdjustmentsByUserWeek = new Map<string, number>();
    for (const row of adjRows) {
      manualAdjustmentsByUserWeek.set(`${row.userId}:${row.weekKey}`, Number(row.manualSeconds ?? 0));
    }

    const scheduleBySsoId = new Map<string, BusyScheduleSnapshot | null>();
    for (const snap of busySnapshots) {
      scheduleBySsoId.set(snap.userId, snap.scheduleJson ?? null);
    }

    const githubBySsoId = new Map<string, string | null>();
    for (const om of orbitMembers) {
      const ghUser = om.socialJson?.github?.username ?? null;
      githubBySsoId.set(om.userId, ghUser);
    }

    const sessions: TitleEngineSession[] = rawSessions.map((s) => ({
      userId: s.userId,
      checkInAt: s.checkInAt instanceof Date ? s.checkInAt : new Date(s.checkInAt),
      checkOutAt: s.checkOutAt
        ? s.checkOutAt instanceof Date
          ? s.checkOutAt
          : new Date(s.checkOutAt)
        : undefined,
      durationSeconds: typeof s.durationSeconds === 'number' ? s.durationSeconds : undefined,
      status: s.status as TitleEngineSession['status'],
      weekKey: s.weekKey,
    }));

    const byUserId = evaluateTeamTitles({
      now,
      members: members.map((m) => ({
        id: m.id,
        enrollYear: m.enrollYear,
        createdAt: m.createdAt,
        equippedTitleId: m.equippedTitleId ?? null,
        persistentTitleIds: Array.isArray(m.persistentTitleIds) ? m.persistentTitleIds : [],
        hiddenTitleIds: Array.isArray(m.hiddenTitleIds) ? m.hiddenTitleIds : [],
        githubUsername: m.logtoUserId ? githubBySsoId.get(m.logtoUserId) ?? null : null,
        discoveredCardCount: cardBundle.discoveredCardCountByUser.get(m.id) ?? 0,
        scheduleSnapshot: m.logtoUserId ? scheduleBySsoId.get(m.logtoUserId) ?? null : null,
      })),
      sessions,
      manualAdjustmentsByUserWeek,
      entertainmentByUserWeek: cardBundle.entertainmentByUserWeek,
      currentWeekCardInteractions: cardBundle.currentWeekCardInteractions,
      gambleEventsByUser: cardBundle.gambleEventsByUser,
      ssrPityUsers: cardBundle.ssrPityUsers,
      releaseContributors,
      totalCatalogCards: CARD_CATALOG.length,
    });

    // 自动持久化本次新解锁的长期称号（异步落库，不影响接口响应延迟）
    const toPersist: PunchUserEntity[] = [];
    for (const member of members) {
      const evalRes = byUserId.get(member.id);
      if (!evalRes || evalRes.newlyUnlockedPersistentTitleIds.length === 0) continue;
      const merged = new Set<string>([
        ...(Array.isArray(member.persistentTitleIds) ? member.persistentTitleIds : []),
        ...evalRes.newlyUnlockedPersistentTitleIds,
      ]);
      member.persistentTitleIds = [...merged];
      member.updatedAt = now;
      toPersist.push(member);
    }
    if (toPersist.length > 0) {
      void this.userRepo.save(toPersist).catch((err: unknown) => {
        this.logger.warn(
          `持久化长期称号解锁记录失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    const snapshot: CachedTeamTitles = {
      computedAt: Date.now(),
      weekKey,
      byUserId,
    };
    this.teamCache.set(teamId, snapshot);
    return snapshot;
  }
}

@Controller('titles')
@UseGuards(PunchAuthGuard)
export class PunchTitlesController {
  constructor(private readonly service: PunchTitlesService) {}

  @Get('me')
  getMine(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getMyTitles(user.teamId, user.userId);
  }

  @Patch('me/equip')
  equip(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { titleId } = EquipTitleSchema.parse(rawBody ?? {});
    return this.service.equipTitle(user.teamId, user.userId, titleId ?? null);
  }

  @Patch('me/visibility')
  setVisibility(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { titleId, hidden } = ToggleTitleVisibilitySchema.parse(rawBody ?? {});
    return this.service.setTitleVisibility(user.teamId, user.userId, titleId, hidden);
  }

  @Get('team')
  async getTeam(@PunchCurrentUser() user: PunchAuthUser) {
    const items = await this.service.getTeamDisplayTitlesByMemberKey(user.teamId);
    return { items };
  }
}
