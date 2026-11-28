/**
 * 工作室称号系统服务（PostgreSQL TypeORM 版，完整实现 26 项自动判定称号、
 * 课表快照与兜底接入、GitHub Release PR 贡献者统计、长期称号原子持久化、显隐开关、30 秒团队快照 single-flight 缓存与全员亮牌徽章映射）。
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
import { PunchTitleAchievementEntity } from './entities/punch-title-achievement.entity.js';
import { GitHubContributorSyncService } from './github-contributor-sync.service.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import { CARD_CATALOG } from './punch-card-engine.js';
import { assessmentEnrollYears } from './punch-shared.util.js';
import {
  TITLE_BY_ID,
  TITLE_CATALOG,
  TITLE_TIER_BASE,
  computeTitleAchievementTier,
  formatTitleTierText,
  toMemberTitleBadge,
  type MemberTitleBadge,
  type TitleAchievementTier,
  type TitleDefinition,
  type TitleEvaluationItem,
} from './punch-title-catalog.js';
import {
  addShanghaiDays,
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  extractGambleEventFromReceipt,
  extractNonOverlappingStreakKeys,
  getTitleLookbackStartDate,
  hasSsrPityInReceipt,
  projectMemberTitleDisplay,
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
  TITLE_TIER_BASE,
  computeTitleAchievementTier,
  formatTitleTierText,
  toMemberTitleBadge,
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  extractGambleEventFromReceipt,
  extractNonOverlappingStreakKeys,
  hasSsrPityInReceipt,
  type MemberTitleBadge,
  type TitleAchievementTier,
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
  ssrPityReceiptKeysByUser: Map<string, string[]>;
  discoveredCardCountByUser: Map<string, number>;
  entertainmentByUserWeek: Map<string, number>;
}

@Injectable()
export class PunchTitlesService {
  private readonly logger = new Logger(PunchTitlesService.name);
  private readonly teamCache = new Map<string, CachedTeamTitles>();
  /** 同一团队并发重算去重表（single-flight），避免缓存失效瞬间引发雪崩查询。 */
  private readonly inFlightSnapshots = new Map<string, Promise<CachedTeamTitles>>();
  /** 团队快照代数：每次写操作失效缓存时递增，防止写前启动的旧快照回填污染缓存。 */
  private readonly snapshotGen = new Map<string, number>();

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
    @InjectRepository(PunchTitleAchievementEntity)
    private readonly achievementRepo: Repository<PunchTitleAchievementEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
    private readonly githubContributorSync: GitHubContributorSyncService,
  ) {}

  /** 考勤签退/调时/佩戴称号变更后主动失效团队快照缓存与在途快照。 */
  invalidateTeamCache(teamId: string): void {
    this.teamCache.delete(teamId);
    this.inFlightSnapshots.delete(teamId);
    this.snapshotGen.set(teamId, (this.snapshotGen.get(teamId) ?? 0) + 1);
  }

  private buildIneligibleResponse(weekKey: string) {
    return {
      weekKey,
      eligible: false,
      equippedTitleId: null,
      hiddenTitleIds: [] as string[],
      displayTitles: [] as MemberTitleBadge[],
      catalog: TITLE_CATALOG.map((def) => ({
        ...toMemberTitleBadge(def, 0),
        unlocked: false,
        equipped: false,
        ...(def.hideable ? { hidden: false } : {}),
        stackRuleText: def.stackRuleText,
        progressText: '仅大一至大三可解锁',
      })),
    };
  }

  private buildProjectedResponse(
    weekKey: string,
    mine: MemberTitleEvaluation,
    equippedTitleId: string | null,
    hiddenTitleIds: string[],
  ) {
    const statusById: Record<
      string,
      { unlocked: boolean; unlockCount?: number; progressText?: string }
    > = {};
    for (const entry of mine.catalog) {
      statusById[entry.id] = {
        unlocked: entry.unlocked,
        unlockCount: entry.unlockCount,
        progressText: entry.progressText,
      };
    }
    const projected = projectMemberTitleDisplay(statusById, equippedTitleId, hiddenTitleIds);
    return {
      weekKey,
      eligible: true,
      ...projected,
    };
  }

  /** 获取当前登录成员的完整称号面板（非近三级成员仍可浏览全量 26 项称号图鉴，但不参与解锁与佩戴）。 */
  async getMyTitles(teamId: string, userId: string) {
    const snapshot = await this.computeTeamSnapshot(teamId, true);
    const mine = snapshot.byUserId.get(userId);
    if (!mine) {
      return this.buildIneligibleResponse(snapshot.weekKey);
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

  /** 手动佩戴或恢复自动佩戴称号（单语句原子更新，不覆写其他列且避免连续两次全量快照计算）。 */
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
    }

    const snapshot = await this.computeTeamSnapshot(teamId, true);
    const mine = snapshot.byUserId.get(userId);
    if (titleId !== null) {
      const def = TITLE_BY_ID.get(titleId)!;
      if (!mine) {
        throw new BadRequestException('仅大一至大三成员可佩戴称号');
      }
      const item = mine.catalog.find((entry) => entry.id === titleId);
      if (!item?.unlocked) {
        throw new BadRequestException(`尚未解锁「${def.name}」称号`);
      }
    }

    const rows = (
      titleId !== null
        ? await this.userRepo.query(
            `UPDATE punch_users
             SET equipped_title_id = $1,
                 hidden_title_ids = COALESCE(
                   (SELECT jsonb_agg(val)
                    FROM jsonb_array_elements_text(COALESCE(hidden_title_ids, '[]'::jsonb)) AS val
                    WHERE val <> $1),
                   '[]'::jsonb
                 ),
                 updated_at = NOW()
             WHERE team_id = $2 AND id = $3
             RETURNING equipped_title_id AS "equippedTitleId", hidden_title_ids AS "hiddenTitleIds"`,
            [titleId, teamId, userId],
          )
        : await this.userRepo.query(
            `UPDATE punch_users
             SET equipped_title_id = NULL,
                 updated_at = NOW()
             WHERE team_id = $1 AND id = $2
             RETURNING equipped_title_id AS "equippedTitleId", hidden_title_ids AS "hiddenTitleIds"`,
            [teamId, userId],
          )
    ) as Array<{ equippedTitleId: string | null; hiddenTitleIds: string[] }>;

    if (!rows || rows.length === 0) {
      throw new BadRequestException('用户不存在');
    }

    this.invalidateTeamCache(teamId);
    if (!mine) {
      return this.buildIneligibleResponse(snapshot.weekKey);
    }
    const updated = rows[0]!;
    return this.buildProjectedResponse(
      snapshot.weekKey,
      mine,
      updated.equippedTitleId ?? null,
      Array.isArray(updated.hiddenTitleIds) ? updated.hiddenTitleIds : [],
    );
  }

  /** 开启或关闭某个可隐藏称号的展示状态（校验资格与解锁状态，并采用单语句原子 JSONB 更新）。 */
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

    const snapshot = await this.computeTeamSnapshot(teamId, true);
    const mine = snapshot.byUserId.get(userId);
    if (!mine) {
      throw new BadRequestException('仅大一至大三成员可设置称号展示状态');
    }
    if (hidden) {
      const item = mine.catalog.find((entry) => entry.id === titleId);
      if (!item?.unlocked) {
        throw new BadRequestException(`尚未解锁「${def.name}」称号`);
      }
    }

    const rows = (
      hidden
        ? await this.userRepo.query(
            `UPDATE punch_users
             SET hidden_title_ids = (
                   SELECT COALESCE(jsonb_agg(DISTINCT val ORDER BY val), '[]'::jsonb)
                   FROM jsonb_array_elements_text(
                     COALESCE(hidden_title_ids, '[]'::jsonb) || to_jsonb($1::text)
                   ) AS val
                 ),
                 equipped_title_id = CASE WHEN equipped_title_id = $1 THEN NULL ELSE equipped_title_id END,
                 updated_at = NOW()
             WHERE team_id = $2 AND id = $3
             RETURNING equipped_title_id AS "equippedTitleId", hidden_title_ids AS "hiddenTitleIds"`,
            [titleId, teamId, userId],
          )
        : await this.userRepo.query(
            `UPDATE punch_users
             SET hidden_title_ids = COALESCE(
                   (SELECT jsonb_agg(val)
                    FROM jsonb_array_elements_text(COALESCE(hidden_title_ids, '[]'::jsonb)) AS val
                    WHERE val <> $1),
                   '[]'::jsonb
                 ),
                 updated_at = NOW()
             WHERE team_id = $2 AND id = $3
             RETURNING equipped_title_id AS "equippedTitleId", hidden_title_ids AS "hiddenTitleIds"`,
            [titleId, teamId, userId],
          )
    ) as Array<{ equippedTitleId: string | null; hiddenTitleIds: string[] }>;

    if (!rows || rows.length === 0) {
      throw new BadRequestException('用户不存在');
    }

    this.invalidateTeamCache(teamId);
    const updated = rows[0]!;
    return this.buildProjectedResponse(
      snapshot.weekKey,
      mine,
      updated.equippedTitleId ?? null,
      Array.isArray(updated.hiddenTitleIds) ? updated.hiddenTitleIds : [],
    );
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

  /** 按需下推条件至 PostgreSQL 聚合卡牌娱乐时长、交易时长、图鉴收集数、本周跨人交互、赌狗卡与 SSR 保底记录。 */
  private async loadCardTitleDataBundle(
    teamId: string,
    members: PunchUserEntity[],
    weekKeys: string[],
    currentWeekStartMs: number,
  ): Promise<CardTitleDataBundle> {
    const currentWeekStartIso = new Date(currentWeekStartMs).toISOString();
    // 赌狗卡与 SSR 大保底均支持按次/按轮次累计升阶，覆盖全部活跃应考成员（SQL 均已严格下推过滤，极轻量）
    const activeMemberIds = members.map((m) => m.id);
    const needSsrPityUserIds = activeMemberIds;
    const needGambleUserIds = activeMemberIds;

    const [
      game,
      archivedWeeks,
      weekArchivedReceipts,
      gambleArchivedReceipts,
      ssrPityRows,
      ...tradeSummaries
    ] = await Promise.all([
      this.cardGameRepo.findOne({ where: { teamId } }),
      this.cardWeekArchiveRepo.find({
        where: { teamId, weekKey: In(weekKeys) },
      }),
      // 1. 仅拉取本周归档回执（用于「吕洞宾」「龙王」跨人交互）
      this.cardActionArchiveRepo.query(
        `SELECT receipt_key AS "receiptKey",
                actor_id AS "actorId",
                at,
                result,
                gift
         FROM punch_card_action_receipts
         WHERE team_id = $1 AND at >= $2`,
        [teamId, currentWeekStartIso],
      ) as Promise<
        Array<{
          receiptKey: string;
          actorId: string;
          at: string;
          result: Record<string, unknown> | null;
          gift: Record<string, unknown> | null;
        }>
      >,
      // 2. 仅拉取未双双持久化赌狗称号成员的历史赌狗卡回执
      needGambleUserIds.length > 0
        ? (this.cardActionArchiveRepo.query(
            `SELECT receipt_key AS "receiptKey",
                    actor_id AS "actorId",
                    at,
                    result
             FROM punch_card_action_receipts
             WHERE team_id = $1
               AND actor_id = ANY($2::text[])
               AND result->>'action' = 'use'
               AND (
                 result->'actionCard'->>'id' IN ('n-gamble', 'card-03')
                 OR result->'actionCard'->>'name' = '我赌你的枪里没有子弹'
               )`,
            [teamId, needGambleUserIds],
          ) as Promise<
            Array<{
              receiptKey: string;
              actorId: string;
              at: string;
              result: Record<string, unknown> | null;
            }>
          >)
        : Promise.resolve([]),
      // 3. 仅查询触发过 SSR 大保底的 (actor_id, receipt_key) 轻量键对，不拉取 JSONB 正文，用于按次累计升阶
      needSsrPityUserIds.length > 0
        ? (this.cardActionArchiveRepo.query(
            `SELECT actor_id AS "actorId",
                    receipt_key AS "receiptKey"
             FROM punch_card_action_receipts
             WHERE team_id = $1
               AND actor_id = ANY($2::text[])
               AND result->>'action' = 'draw'
               AND COALESCE((result->>'ssrPity')::boolean, false) = true`,
            [teamId, needSsrPityUserIds],
          ) as Promise<Array<{ actorId: string; receiptKey: string }>>)
        : Promise.resolve([]),
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

    // 2. 合并按需下推的归档结果与实时 game.receipts（按 receiptKey 分别去重）
    const currentWeekCardInteractions: TitleEngineCardInteraction[] = [];
    const gambleEventsByUser = new Map<string, TitleEngineGambleEvent[]>();
    const ssrPityUsers = new Set<string>();
    const ssrPityKeySetByUser = new Map<string, Set<string>>();
    const addSsrPityKey = (uid: string, rk: string) => {
      ssrPityUsers.add(uid);
      let set = ssrPityKeySetByUser.get(uid);
      if (!set) {
        set = new Set<string>();
        ssrPityKeySetByUser.set(uid, set);
      }
      set.add(rk);
    };
    for (const row of ssrPityRows) {
      if (row.actorId) {
        addSsrPityKey(row.actorId, row.receiptKey || `archive:${row.actorId}`);
      }
    }
    const seenWeekReceiptKeys = new Set<string>();
    const seenGambleReceiptKeys = new Set<string>();

    for (const row of weekArchivedReceipts) {
      if (row.receiptKey) seenWeekReceiptKeys.add(row.receiptKey);
      const atMs = row.at ? Date.parse(row.at) : Number.NaN;
      if (!Number.isNaN(atMs) && atMs >= currentWeekStartMs) {
        currentWeekCardInteractions.push(
          ...extractCardInteractionsFromReceipt({
            actorId: row.actorId,
            at: row.at,
            result: row.result,
            gift: row.gift,
          }),
        );
      }
    }

    for (const row of gambleArchivedReceipts) {
      if (row.receiptKey) seenGambleReceiptKeys.add(row.receiptKey);
      const gamble = extractGambleEventFromReceipt({
        actorId: row.actorId,
        at: row.at,
        result: row.result,
      });
      if (gamble) {
        const list = gambleEventsByUser.get(gamble.actorId) ?? [];
        list.push(gamble.event);
        gambleEventsByUser.set(gamble.actorId, list);
      }
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
        if (!receipt) continue;
        if (!seenWeekReceiptKeys.has(key)) {
          const atMs = receipt.at ? Date.parse(receipt.at) : Number.NaN;
          if (!Number.isNaN(atMs) && atMs >= currentWeekStartMs) {
            currentWeekCardInteractions.push(...extractCardInteractionsFromReceipt(receipt));
          }
        }
        if (!seenGambleReceiptKeys.has(key)) {
          const gamble = extractGambleEventFromReceipt(receipt);
          if (gamble) {
            const list = gambleEventsByUser.get(gamble.actorId) ?? [];
            list.push(gamble.event);
            gambleEventsByUser.set(gamble.actorId, list);
          }
        }
        if (receipt.actorId && hasSsrPityInReceipt(receipt)) {
          addSsrPityKey(receipt.actorId, key);
        }
      }
    }

    const ssrPityReceiptKeysByUser = new Map<string, string[]>();
    for (const [uid, keySet] of ssrPityKeySetByUser.entries()) {
      ssrPityReceiptKeysByUser.set(uid, [...keySet]);
    }

    return {
      currentWeekCardInteractions,
      gambleEventsByUser,
      ssrPityUsers,
      ssrPityReceiptKeysByUser,
      discoveredCardCountByUser,
      entertainmentByUserWeek,
    };
  }

  /** 单列原子 JSONB 并集持久化新解锁长期称号（按 userId 升序防死锁，绝不覆写 equipped/hidden/avatar 等列）。 */
  private async persistNewlyUnlockedTitles(
    teamId: string,
    updates: ReadonlyArray<{ userId: string; newIds: string[] }>,
  ): Promise<void> {
    const sorted = [...updates].sort((a, b) => a.userId.localeCompare(b.userId));
    for (const item of sorted) {
      await this.userRepo.query(
        `UPDATE punch_users
         SET persistent_title_ids = (
           SELECT COALESCE(jsonb_agg(DISTINCT val ORDER BY val), '[]'::jsonb)
           FROM jsonb_array_elements_text(
             COALESCE(persistent_title_ids, '[]'::jsonb) || $1::jsonb
           ) AS val
         ),
         updated_at = NOW()
         WHERE team_id = $2 AND id = $3`,
        [JSON.stringify(item.newIds), teamId, item.userId],
      );
    }
  }

  /** 批量幂等写入新达成的称号成就记录（ON CONFLICT DO NOTHING，绝不产生跨列竞态与重复计数）。 */
  private async persistNewAchievementRecords(
    teamId: string,
    records: ReadonlyArray<{ userId: string; titleId: string; occurrenceKey: string }>,
    achievedAt: Date,
  ): Promise<void> {
    if (records.length === 0) return;
    const sorted = [...records].sort(
      (a, b) =>
        a.userId.localeCompare(b.userId) ||
        a.titleId.localeCompare(b.titleId) ||
        a.occurrenceKey.localeCompare(b.occurrenceKey),
    );
    const CHUNK_SIZE = 100;
    for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
      const chunk = sorted.slice(i, i + CHUNK_SIZE);
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((rec, idx) => {
        const base = idx * 5;
        valuesSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        params.push(teamId, rec.userId, rec.titleId, rec.occurrenceKey, achievedAt);
      });
      await this.achievementRepo.query(
        `INSERT INTO punch_title_achievements (team_id, user_id, title_id, occurrence_key, achieved_at)
         VALUES ${valuesSql.join(', ')}
         ON CONFLICT (team_id, user_id, title_id, occurrence_key) DO NOTHING`,
        params,
      );
    }
  }

  /** 计算（或命中 30 秒缓存 / single-flight 去重）全团队成员的 26 项称号评估快照，并原子持久化新解锁的长期称号。 */
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

    if (!bypassCache) {
      const existingInFlight = this.inFlightSnapshots.get(teamId);
      if (existingInFlight) {
        return existingInFlight;
      }
    }

    const gen = (this.snapshotGen.get(teamId) ?? 0) + (bypassCache ? 1 : 0);
    if (bypassCache) {
      this.snapshotGen.set(teamId, gen);
    }

    const task = this.computeTeamSnapshotCore(teamId, now, weekKey, gen).finally(() => {
      if (this.inFlightSnapshots.get(teamId) === task) {
        this.inFlightSnapshots.delete(teamId);
      }
    });
    this.inFlightSnapshots.set(teamId, task);
    return task;
  }

  private async computeTeamSnapshotCore(
    teamId: string,
    now: Date,
    weekKey: string,
    gen: number,
  ): Promise<CachedTeamTitles> {
    const allActive = await this.userRepo.find({ where: { teamId, status: 'active' } });
    const ssoActive = allActive.filter((m) => Boolean(m.logtoUserId));
    // 称号体系仅针对大一至大三（最近 3 级），其他往届成员不纳入计算
    const eligibleGrades = new Set(assessmentEnrollYears(ssoActive.map((m) => m.enrollYear)));
    const members = ssoActive.filter((m) => eligibleGrades.has(m.enrollYear));
    if (members.length === 0) {
      const empty: CachedTeamTitles = { computedAt: Date.now(), weekKey, byUserId: new Map() };
      if ((this.snapshotGen.get(teamId) ?? 0) === gen) {
        this.teamCache.set(teamId, empty);
      }
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

    const [
      rawSessions,
      adjRows,
      cardBundle,
      busySnapshots,
      orbitMembers,
      releaseContributors,
      achievementRows,
    ] = await Promise.all([
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
      this.achievementRepo.find({
        where: { teamId, userId: In(members.map((m) => m.id)) },
        select: { userId: true, titleId: true, occurrenceKey: true },
      }),
    ]);

    const existingAchievementKeysByUser = new Map<string, Map<string, Set<string>>>();
    for (const row of achievementRows) {
      let byTitle = existingAchievementKeysByUser.get(row.userId);
      if (!byTitle) {
        byTitle = new Map();
        existingAchievementKeysByUser.set(row.userId, byTitle);
      }
      let keys = byTitle.get(row.titleId);
      if (!keys) {
        keys = new Set();
        byTitle.set(row.titleId, keys);
      }
      keys.add(row.occurrenceKey);
    }

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
      ssrPityReceiptKeysByUser: cardBundle.ssrPityReceiptKeysByUser,
      releaseContributors,
      totalCatalogCards: CARD_CATALOG.length,
      existingAchievementKeysByUser,
    });

    // 单列原子 JSONB 并集持久化新解锁的长期称号，严禁全列 userRepo.save 引发跨列覆盖竞态
    const toPersist = members
      .map((member) => ({
        userId: member.id,
        newIds: byUserId.get(member.id)?.newlyUnlockedPersistentTitleIds ?? [],
      }))
      .filter((item) => item.newIds.length > 0);
    const newAchievements = members.flatMap((member) =>
      (byUserId.get(member.id)?.newAchievementRecords ?? []).map((rec) => ({
        userId: member.id,
        titleId: rec.titleId,
        occurrenceKey: rec.occurrenceKey,
      })),
    );
    if (toPersist.length > 0 || newAchievements.length > 0) {
      await Promise.all([
        toPersist.length > 0
          ? this.persistNewlyUnlockedTitles(teamId, toPersist).catch((err) => {
              this.logger.warn(
                `持久化长期称号解锁记录失败: ${err instanceof Error ? err.message : String(err)}`,
              );
            })
          : Promise.resolve(),
        newAchievements.length > 0
          ? this.persistNewAchievementRecords(teamId, newAchievements, now).catch((err) => {
              this.logger.warn(
                `持久化称号成就累计记录失败: ${err instanceof Error ? err.message : String(err)}`,
              );
            })
          : Promise.resolve(),
      ]);
    }

    const snapshot: CachedTeamTitles = {
      computedAt: Date.now(),
      weekKey,
      byUserId,
    };
    if ((this.snapshotGen.get(teamId) ?? 0) === gen) {
      this.teamCache.set(teamId, snapshot);
    }
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
