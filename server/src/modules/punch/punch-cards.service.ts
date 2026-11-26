/**
 * 卡牌工坊服务（PostgreSQL TypeORM 版 + 完整 21 张卡牌引擎 + 统一 coin 乐币原子账本）：
 * - 100% 对齐 LecPunch 21 张卡效果引擎、加速卡签退自动结算、跨周归档、防御/赠卡/互动回执与已读确认；
 * - 付费抽卡对接新版统一 coin 乐币（6 乐币/抽，每周免费 2 抽 + 赠礼抽优先，每周最多付费 20 抽），
 *   与游戏状态更新在同一 PostgreSQL 事务内原子提交；
 * - GET /cards/me 返回前端兼容的 points 对象（balance = 统一乐币余额，earned/spent = 本周乐币流水）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { S3StorageService } from '../storage/s3-storage.service.js';
import { PunchAssessmentWeekEntity } from './entities/punch-assessment.entities.js';
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
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import {
  advanceGameState,
  applyGameAction,
  ASSESSMENT_TARGET_CARDS,
  CARD_CATALOG,
  CARD_PITY_LIMITS,
  COIN_COST_PER_DRAW,
  createGameState,
  getCardTargetMode,
  getPlayerWeek,
  normalizeGameState,
  resolveInternalCardId,
  seededCardRandom,
  toPublicCardId,
  WEEKLY_FREE_DRAWS,
  WEEKLY_MAX_PAID_DRAWS,
  type CardDefinition,
  type CardRarity,
  type GameContext,
  type GameState,
  type PlayerWeek,
} from './punch-card-engine.js';
import {
  assessmentEnrollYears,
  comprehensiveDurationSeconds,
  isValidEnrollmentYear,
  newObjectIdHex,
} from './punch-shared.util.js';
import { addShanghaiDays, shanghaiDayStartMs } from './punch-title-engine.js';
import { PunchTitlesService } from './punch-titles.service.js';
import { PunchUsersService } from './punch-users.service.js';

export { CARD_CATALOG, type CardDefinition, type CardRarity };

const CardActionSchema = z.object({
  action: z.enum(['draw', 'gift', 'use']),
  count: z.union([z.literal(1), z.literal(10)]).optional(),
  cardId: z.string().optional(),
  targetId: z.string().optional(),
  secondTargetId: z.string().optional(),
  targetMemberKey: z.string().optional(),
  requestKey: z.string().trim().min(1).max(128).optional(),
});

const AckIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

interface CardNoticePerson {
  id: string;
  username: string;
  displayName: string;
}

interface CardNoticeCard {
  id: string;
  name: string;
  rarity: CardRarity;
}

interface CardReceiptGift {
  recipientId: string;
  notice: {
    at: string;
    sender: CardNoticePerson;
    card: CardNoticeCard;
  };
}

interface CardReceiptDefense {
  recipientId: string;
  notice: {
    at: string;
    events: Array<{
      attacker: CardNoticePerson;
      attackCard: CardNoticeCard;
      defenseCard: CardNoticeCard;
      outcome: 'blocked' | 'reflected';
    }>;
    randomlySelected?: boolean;
    effects?: unknown[];
  };
}

interface CardReceiptInteraction {
  recipientId: string;
  notice: {
    at: string;
    sender: CardNoticePerson;
    card: CardNoticeCard;
    randomlySelected?: boolean;
    effects: Array<{
      target: CardNoticePerson;
      actualTarget?: CardNoticePerson;
      kind: string;
      outcome: string;
      deltaSeconds?: number;
      detail?: string;
    }>;
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableDigest(value: unknown): string {
  return sha256Hex(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item as Record<string, unknown>)
              .sort()
              .map((k) => [k, (item as Record<string, unknown>)[k]]),
          )
        : item,
    ),
  );
}

function cardActionHash(input: {
  action: string;
  cardId?: string;
  targetId?: string;
  secondTargetId?: string;
  count?: number;
}): string {
  return sha256Hex(
    JSON.stringify({
      action: input.action,
      cardId: input.cardId ?? null,
      targetId: input.targetId ?? null,
      secondTargetId: input.secondTargetId ?? null,
      ...(input.count !== undefined && input.count !== 1 ? { count: input.count } : {}),
    }),
  );
}

function futureIso(timestamp: number | undefined, now: number): string | null {
  return timestamp && timestamp > now ? new Date(timestamp).toISOString() : null;
}

@Injectable()
export class PunchCardsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PunchCardGameEntity)
    private readonly gameRepo: Repository<PunchCardGameEntity>,
    @InjectRepository(PunchCardActionArchiveEntity)
    private readonly receiptRepo: Repository<PunchCardActionArchiveEntity>,
    @InjectRepository(PunchCardWeekArchiveEntity)
    private readonly weekArchiveRepo: Repository<PunchCardWeekArchiveEntity>,
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchAssessmentWeekEntity)
    private readonly assessWeekRepo: Repository<PunchAssessmentWeekEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
    private readonly titlesService: PunchTitlesService,
    private readonly s3Storage: S3StorageService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** 计算指定周团队内所有成员的基础秒数（有效打卡秒数 + 管理员手动调时秒数）。 */
  private async getTeamWeekBaseSeconds(teamId: string, weekKey: string): Promise<Record<string, number>> {
    const [recRows, adjRows] = await Promise.all([
      this.sessionRepo.query(
        `SELECT user_id AS "userId", COALESCE(SUM(duration_seconds), 0)::int AS secs
         FROM punch_attendance_sessions
         WHERE team_id = $1 AND week_key = $2 AND status = 'completed' AND duration_seconds > 0 AND duration_seconds < 18000
         GROUP BY user_id`,
        [teamId, weekKey],
      ) as Promise<Array<{ userId: string; secs: number }>>,
      this.adjRepo.query(
        `SELECT user_id AS "userId", COALESCE(SUM(signed_duration_seconds), 0)::int AS secs
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND week_key = $2
         GROUP BY user_id`,
        [teamId, weekKey],
      ) as Promise<Array<{ userId: string; secs: number }>>,
    ]);

    const result: Record<string, number> = {};
    for (const row of recRows) {
      result[row.userId] = (result[row.userId] ?? 0) + Number(row.secs ?? 0);
    }
    for (const row of adjRows) {
      result[row.userId] = (result[row.userId] ?? 0) + Number(row.secs ?? 0);
    }
    return result;
  }

  /** 读取团队当前应考年级（合并历史已持久化的高水位年级，防止成员移除导致回退）。 */
  private async resolveAssessmentYears(
    teamId: string,
    allMembers: Array<{ enrollYear: number }>,
    weekKey: string,
  ): Promise<number[]> {
    const refYear = Number(weekKey.slice(0, 4));
    const persisted = await this.assessWeekRepo.find({ where: { teamId } });
    const prevYears: number[] = [];
    for (const w of persisted) {
      if (w.weekKey > weekKey) continue;
      const req = (w.state as { requiredEnrollYears?: unknown[] } | null)?.requiredEnrollYears;
      if (Array.isArray(req)) {
        for (const y of req) {
          if (isValidEnrollmentYear(y, refYear)) prevYears.push(y);
        }
      }
    }
    return assessmentEnrollYears(
      allMembers.map((m) => m.enrollYear),
      prevYears,
      refYear,
    );
  }

  /** 构建卡牌引擎执行所需的实时上下文。 */
  private async buildContext(
    teamId: string,
    state: GameState,
    random: () => number = () => {
      throw new Error('Randomness requires an action');
    },
    actorCoinBalance?: number,
  ): Promise<GameContext> {
    const now = Date.now();
    const week = getShanghaiWeekKey(new Date(now));
    const sessionWeeks = new Set([week]);
    for (const member of Object.values(state.members)) {
      for (const [key, value] of Object.entries(member.weeks ?? {})) {
        if (key <= week && value.accelerationAt !== undefined) sessionWeeks.add(key);
      }
    }

    const [activeMembers, allMembers, baseSeconds, rawSessions] = await Promise.all([
      this.userRepo.find({ where: { teamId, status: 'active' } }),
      this.userRepo.find({ where: { teamId }, select: { id: true, enrollYear: true } }),
      this.getTeamWeekBaseSeconds(teamId, week),
      this.sessionRepo.find({
        where: {
          teamId,
          weekKey: In([...sessionWeeks]),
          status: 'completed',
        },
        select: {
          id: true,
          userId: true,
          weekKey: true,
          checkOutAt: true,
          durationSeconds: true,
        },
      }),
    ]);

    const assessmentYears = await this.resolveAssessmentYears(teamId, allMembers, week);

    return {
      now,
      week,
      random,
      actorCoinBalance,
      assessmentYears,
      players: activeMembers.map((m) => ({
        id: m.id,
        username: m.username,
        name: m.displayName,
        enrollYear: m.enrollYear,
      })),
      baseSeconds,
      sessions: rawSessions
        .filter(
          (s) =>
            s.checkOutAt &&
            typeof s.durationSeconds === 'number' &&
            s.durationSeconds > 0 &&
            s.durationSeconds < 18_000,
        )
        .map((s) => ({
          id: s.id,
          userId: s.userId,
          weekKey: s.weekKey,
          checkOutAt: s.checkOutAt!.getTime(),
          durationSeconds: s.durationSeconds!,
        })),
    };
  }

  /** 将已结束超过 5 小时且无待生效加速的周数据归档至 punch_card_week_archives。 */
  private extractArchivableWeeks(
    state: GameState,
    now: number,
  ): Array<{ userId: string; weekKey: string; week: PlayerWeek }> {
    const archived: Array<{ userId: string; weekKey: string; week: PlayerWeek }> = [];
    for (const [userId, member] of Object.entries(state.members)) {
      for (const [weekKey, week] of Object.entries(member.weeks ?? {})) {
        const endMs = shanghaiDayStartMs(addShanghaiDays(weekKey, 7), 0);
        if (
          archived.length < 100 &&
          Number.isFinite(endMs) &&
          now >= endMs + 5 * 3_600_000 &&
          week.accelerationAt === undefined
        ) {
          archived.push({ userId, weekKey, week });
          delete member.weeks[weekKey];
        }
      }
    }
    return archived;
  }

  private async persistArchivedWeeksTx(
    manager: EntityManager,
    teamId: string,
    weeks: Array<{ userId: string; weekKey: string; week: PlayerWeek }>,
  ): Promise<void> {
    for (const item of weeks) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(PunchCardWeekArchiveEntity)
        .values({
          id: newObjectIdHex(),
          teamId,
          userId: item.userId,
          weekKey: item.weekKey,
          contentHash: stableDigest(item.week),
          week: item.week as unknown as never,
        })
        .orIgnore()
        .execute();
    }
  }

  /** 刷新团队卡牌状态（触发加速卡签退结算、延续跨周结界并归档已结束历史周）。 */
  private async refreshTeamState(teamId: string): Promise<{ game: PunchCardGameEntity; state: GameState; ctx: GameContext }> {
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);

    let existing = await this.gameRepo.findOne({ where: { teamId } });
    if (!existing) {
      existing = await this.gameRepo.save(
        this.gameRepo.create({
          id: newObjectIdHex(),
          teamId,
          revision: 0,
          startWeek: weekKey,
          state: createGameState() as unknown as Record<string, unknown>,
          receipts: {},
          pendingWrite: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    const initialState = normalizeGameState(existing.state);
    const ctx = await this.buildContext(teamId, initialState);
    const nextState = structuredClone(initialState);
    advanceGameState(nextState, ctx);
    const archivable = this.extractArchivableWeeks(nextState, ctx.now);

    if (archivable.length === 0 && JSON.stringify(nextState) === JSON.stringify(initialState)) {
      return { game: existing, state: initialState, ctx };
    }

    const updated = await this.dataSource.transaction(async (manager) => {
      const locked = await manager
        .createQueryBuilder(PunchCardGameEntity, 'g')
        .setLock('pessimistic_write')
        .where('g.team_id = :teamId', { teamId })
        .getOne();
      if (!locked) return existing;
      const lockedState = normalizeGameState(locked.state);
      advanceGameState(lockedState, ctx);
      const toArchive = this.extractArchivableWeeks(lockedState, ctx.now);
      if (toArchive.length > 0) {
        await this.persistArchivedWeeksTx(manager, teamId, toArchive);
      }
      locked.state = lockedState as unknown as Record<string, unknown>;
      locked.revision += 1;
      locked.updatedAt = new Date();
      return manager.save(PunchCardGameEntity, locked);
    });

    return { game: updated, state: normalizeGameState(updated.state), ctx };
  }

  /** 加载当前成员最近 20 条卡牌动态（合并已归档回执与 legacy receipts）。 */
  private async loadEvents(game: PunchCardGameEntity, actorId: string) {
    const rows = await this.receiptRepo
      .createQueryBuilder('r')
      .where('r.team_id = :teamId', { teamId: game.teamId })
      .andWhere(
        `(r.actor_id = :uid
          OR r.gift->>'recipientId' = :uid
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.defenses) = 'array' THEN r.defenses ELSE '[]'::jsonb END) d WHERE d->>'recipientId' = :uid)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.interactions) = 'array' THEN r.interactions ELSE '[]'::jsonb END) i WHERE i->>'recipientId' = :uid))`,
        { uid: actorId },
      )
      .orderBy('r.at', 'DESC')
      .addOrderBy('r.receipt_key', 'ASC')
      .take(40)
      .getMany();

    const combined = new Map<
      string,
      {
        receiptKey: string;
        actorId: string;
        at: string;
        result: { message?: string };
        gift?: CardReceiptGift | null;
        defenses?: CardReceiptDefense[] | null;
        interactions?: CardReceiptInteraction[] | null;
      }
    >();

    for (const r of rows) {
      combined.set(r.receiptKey, {
        receiptKey: r.receiptKey,
        actorId: r.actorId,
        at: r.at,
        result: (r.result ?? {}) as { message?: string },
        gift: (r.gift ?? null) as CardReceiptGift | null,
        defenses: (r.defenses ?? null) as CardReceiptDefense[] | null,
        interactions: (r.interactions ?? null) as CardReceiptInteraction[] | null,
      });
    }

    const legacyReceipts = (game.receipts ?? {}) as Record<
      string,
      {
        actorId?: string;
        at?: string;
        result?: { message?: string };
        gift?: CardReceiptGift;
        defenses?: CardReceiptDefense[];
        interactions?: CardReceiptInteraction[];
      }
    >;
    for (const [key, r] of Object.entries(legacyReceipts)) {
      if (!r?.at) continue;
      const related =
        r.actorId === actorId ||
        r.gift?.recipientId === actorId ||
        r.defenses?.some((d) => d.recipientId === actorId) ||
        r.interactions?.some((i) => i.recipientId === actorId);
      if (related && !combined.has(key)) {
        combined.set(key, {
          receiptKey: key,
          actorId: r.actorId ?? '',
          at: r.at,
          result: r.result ?? {},
          gift: r.gift ?? null,
          defenses: r.defenses ?? null,
          interactions: r.interactions ?? null,
        });
      }
    }

    return [...combined.values()]
      .sort((a, b) => b.at.localeCompare(a.at) || a.receiptKey.localeCompare(b.receiptKey))
      .slice(0, 20)
      .map((row) => {
        const defenseMsg = row.defenses
          ?.find((item) => item.recipientId === actorId)
          ?.notice.events.map(
            (event) =>
              `${event.attacker.displayName}（${event.attacker.username}）使用「${event.attackCard.name}」；已自动消耗「${event.defenseCard.name}」${event.outcome === 'reflected' ? '反弹攻击' : '成功防御'}`,
          )
          .join('；');

        const interactionMsg = row.interactions
          ?.filter((item) => item.recipientId === actorId)
          .map(
            ({ notice }) =>
              `${notice.sender.displayName}（${notice.sender.username}）对你使用「${notice.card.name}」；${notice.effects
                .map((effect) =>
                  effect.outcome === 'blocked'
                    ? '防御或免疫抵消，未生效'
                    : effect.kind === 'time' && effect.outcome !== 'no-effect'
                      ? `${(effect.actualTarget ?? effect.target).displayName}${(effect.deltaSeconds ?? 0) < 0 ? '扣除' : '增加'} ${Math.abs(effect.deltaSeconds ?? 0) / 60} 分钟`
                      : effect.detail ?? '未产生时长变化',
                )
                .join('；')}`,
          )
          .join('；');

        const giftMsg =
          row.gift?.recipientId === actorId
            ? `收到 ${row.gift.notice.sender.displayName}（${row.gift.notice.sender.username}）赠送的「${row.gift.notice.card.name}」`
            : undefined;

        return {
          id: row.receiptKey,
          at: row.at,
          message: defenseMsg || interactionMsg || giftMsg || row.result.message || '卡牌操作完成',
        };
      });
  }

  private async loadIncomingGifts(teamId: string, recipientId: string) {
    const rows = await this.receiptRepo
      .createQueryBuilder('r')
      .where('r.team_id = :teamId', { teamId })
      .andWhere("r.gift->>'recipientId' = :uid", { uid: recipientId })
      .andWhere('r.gift_read_at IS NULL')
      .orderBy('r.at', 'ASC')
      .addOrderBy('r.receipt_key', 'ASC')
      .take(20)
      .getMany();

    return rows
      .filter((r) => r.gift)
      .map((r) => ({ id: r.receiptKey, ...(r.gift as unknown as CardReceiptGift).notice }));
  }

  private async loadIncomingDefenses(teamId: string, recipientId: string) {
    const rows = await this.receiptRepo
      .createQueryBuilder('r')
      .where('r.team_id = :teamId', { teamId })
      .andWhere(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.defenses) = 'array' THEN r.defenses ELSE '[]'::jsonb END) d WHERE d->>'recipientId' = :uid)`,
        { uid: recipientId },
      )
      .andWhere(
        `NOT ((CASE WHEN jsonb_typeof(r.defense_read_by) = 'array' THEN r.defense_read_by ELSE '[]'::jsonb END) @> :uidJson::jsonb)`,
        {
          uidJson: JSON.stringify([recipientId]),
        },
      )
      .orderBy('r.at', 'ASC')
      .addOrderBy('r.receipt_key', 'ASC')
      .take(20)
      .getMany();

    return rows.flatMap((r) => {
      const delivery = ((r.defenses ?? []) as CardReceiptDefense[]).find(
        (d) => d.recipientId === recipientId,
      );
      return delivery ? [{ id: r.receiptKey, ...delivery.notice }] : [];
    });
  }

  private async loadIncomingInteractions(teamId: string, recipientId: string) {
    const rows = await this.receiptRepo
      .createQueryBuilder('r')
      .where('r.team_id = :teamId', { teamId })
      .andWhere(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.interactions) = 'array' THEN r.interactions ELSE '[]'::jsonb END) i WHERE i->>'recipientId' = :uid)`,
        { uid: recipientId },
      )
      .andWhere(
        `NOT ((CASE WHEN jsonb_typeof(r.interaction_read_by) = 'array' THEN r.interaction_read_by ELSE '[]'::jsonb END) @> :uidJson::jsonb)`,
        {
          uidJson: JSON.stringify([recipientId]),
        },
      )
      .orderBy('r.at', 'ASC')
      .addOrderBy('r.receipt_key', 'ASC')
      .take(20)
      .getMany();

    return rows.flatMap((r) => {
      const delivery = ((r.interactions ?? []) as CardReceiptInteraction[]).find(
        (i) => i.recipientId === recipientId,
      );
      return delivery ? [{ id: r.receiptKey, ...delivery.notice }] : [];
    });
  }

  /** 构建完整 CardGameView（对接新版统一 coin 账本与完整互动回执）。 */
  private async buildView(
    game: PunchCardGameEntity,
    state: GameState,
    user: PunchAuthUser,
    ctx: GameContext,
  ) {
    const week = getPlayerWeek(state, user.userId, ctx.week);
    const player = state.members[user.userId];
    const economyUserId = user.ssoSub || user.userId;

    const [wallet, weeklyCoinFlow, events, incomingGifts, incomingDefenses, incomingInteractions] =
      await Promise.all([
        this.economyLedger.getWalletSummary(economyUserId),
        this.economyLedger.getWeeklyCoinFlow(economyUserId, ctx.week),
        this.loadEvents(game, user.userId),
        this.loadIncomingGifts(user.teamId, user.userId),
        this.loadIncomingDefenses(user.teamId, user.userId),
        this.loadIncomingInteractions(user.teamId, user.userId),
      ]);

    const discoveredSet = new Set(player.discovered ?? []);
    const freeRemaining = Math.max(0, WEEKLY_FREE_DRAWS - (week.freeUsed ?? 0));
    const giftDraws = week.bonusDraws ?? 0;
    const baseSec = ctx.baseSeconds[user.userId] ?? 0;
    const comprehensiveSeconds = comprehensiveDurationSeconds(
      0,
      baseSec,
      week.entertainmentSeconds ?? 0,
    );

    const collection = CARD_CATALOG.map((card) => {
      const unlocked = discoveredSet.has(card.id);
      return {
        id: toPublicCardId(card.id),
        rarity: card.rarity,
        unlocked,
        quantity: player.inventory?.[card.id] ?? 0,
        ...(unlocked
          ? {
              name: card.name,
              type: card.type,
              stat: card.stat,
              summary: card.summary,
              effect: card.effect,
              detail: card.detail,
              targetMode: getCardTargetMode(card.id),
              targetScope: (ASSESSMENT_TARGET_CARDS as readonly string[]).includes(card.id)
                ? ('assessment' as const)
                : ('same-grade' as const),
              usable: !['n-shield', 'r-blade', 'sr-reflect'].includes(card.id),
            }
          : {}),
      };
    });

    return {
      capacityLimited: false,
      week: ctx.week,
      entertainmentSeconds: week.entertainmentSeconds ?? 0,
      // 完整兼容旧前端 game.points.{balance,earned,spent,bonus,comprehensiveSeconds}，数值源为新版统一 coin 账本
      points: {
        rule: 'unified-coin-v2' as const,
        comprehensiveSeconds,
        earned: weeklyCoinFlow.earnedCoins,
        bonus: 0,
        spent: weeklyCoinFlow.spentCoins,
        balance: wallet.coinBalance,
      },
      freeRemaining,
      giftDraws,
      freeDrawsRemaining: freeRemaining,
      bonusDrawsRemaining: giftDraws,
      weeklyPaidDrawsUsed: week.paidDrawsUsed ?? 0,
      weeklyPaidDrawsLimit: WEEKLY_MAX_PAID_DRAWS,
      coinCostPerDraw: COIN_COST_PER_DRAW,
      pity: {
        sinceSR: player.pitySR,
        sinceSSR: player.pitySSR,
        srRemaining: Math.max(1, CARD_PITY_LIMITS.sr - player.pitySR),
        ssrRemaining: Math.max(1, CARD_PITY_LIMITS.ssr - player.pitySSR),
        limits: { sr: CARD_PITY_LIMITS.sr, ssr: CARD_PITY_LIMITS.ssr },
      },
      collection,
      players: ctx.players.map((member) => ({
        id: member.id,
        username: member.username,
        displayName: member.name,
        enrollYear: member.enrollYear,
      })),
      requiredEnrollYears: ctx.assessmentYears ?? [],
      statuses: {
        acceleration: week.accelerationAt !== undefined,
        immuneUntil: futureIso(week.immuneUntil, ctx.now),
        lockedUntil: futureIso(week.lockedUntil, ctx.now),
        starvedUntil: futureIso(week.starvedUntil, ctx.now),
      },
      events,
      incomingGifts,
      incomingDefenses,
      incomingInteractions,
    };
  }

  async getMe(user: PunchAuthUser) {
    const { game, state, ctx } = await this.refreshTeamState(user.teamId);
    if (!ctx.players.some((p) => p.id === user.userId)) {
      throw new ForbiddenException('当前账号不可参与卡牌活动');
    }
    return this.buildView(game, state, user, ctx);
  }

  async getMemberCards(teamId: string, targetUserId: string) {
    const game = await this.gameRepo.findOne({ where: { teamId } });
    const state = normalizeGameState(game?.state);
    const m = state.members[targetUserId];
    const items = CARD_CATALOG.filter((c) => (m?.inventory?.[c.id] ?? 0) > 0).map((c) => ({
      id: toPublicCardId(c.id),
      name: c.name,
      rarity: c.rarity,
      quantity: m!.inventory[c.id],
      type: c.type,
      effect: c.effect,
      detail: c.detail,
    }));
    const total = items.reduce((sum, item) => sum + item.quantity, 0);
    return {
      total,
      items,
      discoveredCount: m?.discovered?.length ?? 0,
      totalCount: CARD_CATALOG.length,
      inventory: items,
    };
  }

  /** 供统计/周考核/称号读取指定周团队全员卡牌娱乐秒数（含自动结算待触发加速 + 合并历史归档）。 */
  async getTeamWeekEntertainment(teamId: string, weekKey: string): Promise<Record<string, number>> {
    let game = await this.gameRepo.findOne({ where: { teamId } });
    if (!game) return {};
    const state = normalizeGameState(game.state);
    const currentWeek = getShanghaiWeekKey(new Date());
    if (
      weekKey === currentWeek ||
      Object.values(state.members).some((m) => m.weeks?.[weekKey]?.accelerationAt !== undefined)
    ) {
      game = (await this.refreshTeamState(teamId)).game;
    }

    const archived = await this.weekArchiveRepo.find({ where: { teamId, weekKey } });
    const values: Record<string, number> = {};
    for (const row of archived) {
      const secs = Number((row.week as { entertainmentSeconds?: number } | null)?.entertainmentSeconds ?? 0);
      if (Number.isFinite(secs)) values[row.userId] = secs;
    }

    const latestState = normalizeGameState(game.state);
    for (const [uid, member] of Object.entries(latestState.members)) {
      if (member.weeks?.[weekKey]) {
        values[uid] = Number(member.weeks[weekKey].entertainmentSeconds ?? 0);
      } else {
        values[uid] ??= 0;
      }
    }
    return values;
  }

  /** 供个人历史周统计读取成员全部历史周卡牌娱乐秒数（合并归档表 + 实时 state）。 */
  async getMemberEntertainmentHistory(
    teamId: string,
    userId: string,
  ): Promise<Record<string, number>> {
    const existing = await this.gameRepo.findOne({ where: { teamId } });
    if (!existing) return {};
    const { state } = await this.refreshTeamState(teamId);
    const archived = await this.weekArchiveRepo.find({ where: { teamId, userId } });
    const result: Record<string, number> = {};
    for (const row of archived) {
      const secs = Number((row.week as { entertainmentSeconds?: number } | null)?.entertainmentSeconds ?? 0);
      if (Number.isFinite(secs)) result[row.weekKey] = secs;
    }
    const member = state.members[userId];
    for (const [wk, w] of Object.entries(member?.weeks ?? {})) {
      result[wk] = Number(w.entertainmentSeconds ?? 0);
    }
    return result;
  }

  /** 执行抽卡 / 赠卡 / 使用卡牌（完整 21 张卡效果 + 事务内扣减统一 coin + 写入互动回执）。 */
  async performActionWithView(user: PunchAuthUser, input: z.infer<typeof CardActionSchema>) {
    const reqKey = input.requestKey?.trim() || randomUUID();
    const receiptKey = sha256Hex(`${user.userId}:${reqKey}`);
    const internalCardId = input.cardId ? resolveInternalCardId(input.cardId) : undefined;
    if (input.cardId && !internalCardId) {
      throw new BadRequestException('卡片不存在');
    }
    if (input.action === 'draw' && (input.cardId || input.targetId || input.secondTargetId)) {
      throw new BadRequestException('抽卡不能指定卡片或目标');
    }

    const rawTarget = input.targetId?.trim() || input.targetMemberKey?.trim();
    const resolvedTargetId = rawTarget
      ? (this.usersService.resolveMemberKey(rawTarget) ?? rawTarget)
      : undefined;
    const resolvedSecondTargetId = input.secondTargetId?.trim()
      ? (this.usersService.resolveMemberKey(input.secondTargetId.trim()) ?? input.secondTargetId.trim())
      : undefined;

    const reqHash = cardActionHash({
      action: input.action,
      cardId: input.cardId,
      targetId: resolvedTargetId,
      secondTargetId: resolvedSecondTargetId,
      count: input.count,
    });

    const existingReceipt = await this.receiptRepo.findOne({
      where: { teamId: user.teamId, receiptKey },
    });
    if (existingReceipt) {
      if (existingReceipt.hash !== reqHash) {
        throw new ConflictException('同一操作编号不能用于不同请求');
      }
      return { result: existingReceipt.result, state: await this.getMe(user) };
    }

    const economyUserId = user.ssoSub || user.userId;
    const walletBefore = await this.economyLedger.getWalletSummary(economyUserId);
    const seed = `${user.teamId}:${receiptKey}:${reqHash}`;
    const random = seededCardRandom(
      this.cfg.internalServiceToken || 'lec-orbit-cards-seed',
      seed,
    );

    const { resultView, savedGame, savedState, ctx } = await this.dataSource.transaction(
      async (manager) => {
        const now = new Date();
        const weekKey = getShanghaiWeekKey(now);

        let game = await manager
          .createQueryBuilder(PunchCardGameEntity, 'g')
          .setLock('pessimistic_write')
          .where('g.team_id = :teamId', { teamId: user.teamId })
          .getOne();

        if (!game) {
          game = manager.create(PunchCardGameEntity, {
            id: newObjectIdHex(),
            teamId: user.teamId,
            revision: 0,
            startWeek: weekKey,
            state: createGameState() as unknown as Record<string, unknown>,
            receipts: {},
            pendingWrite: null,
            createdAt: now,
            updatedAt: now,
          });
        }

        const state = normalizeGameState(game.state);
        const context = await this.buildContext(
          user.teamId,
          state,
          random,
          walletBefore.coinBalance,
        );
        if (!context.players.some((p) => p.id === user.userId)) {
          throw new ForbiddenException('当前账号不可参与卡牌活动');
        }

        let engineRes;
        try {
          engineRes = applyGameAction(
            state,
            user.userId,
            {
              action: input.action,
              count: input.count,
              cardId: internalCardId,
              targetId: resolvedTargetId,
              secondTargetId: resolvedSecondTargetId,
            },
            context,
          );
        } catch (err) {
          throw new BadRequestException(err instanceof Error ? err.message : '卡牌操作失败');
        }

        // 若存在付费抽卡，在同一 PG 事务内原子扣减统一 coin 乐币
        if (input.action === 'draw' && (engineRes.spentCoins ?? 0) > 0) {
          const count = input.count ?? 1;
          await this.economyLedger.spendCoinsTx(
            manager,
            {
              userId: economyUserId,
              amount: engineRes.spentCoins!,
              reason: 'card_draw',
              title: `卡牌工坊${count === 10 ? '十连抽' : '单抽'}（付费 ${engineRes.paidDraws} 抽）`,
              idempotencyKey: `punch:card-draw:${user.teamId}:${receiptKey}`,
              appId: 'lec-punch-cards',
            },
            now,
          );
        }

        const person = (id: string): CardNoticePerson => {
          const member = context.players.find((p) => p.id === id);
          if (!member) throw new BadRequestException('结算对象不在当前团队');
          return { id, username: member.username, displayName: member.name || member.username };
        };

        const historicalSourceIds = [
          ...new Set(
            (engineRes.effects ?? []).flatMap((e) =>
              e.sourceId && !context.players.some((p) => p.id === e.sourceId) ? [e.sourceId] : [],
            ),
          ),
        ];
        const historicalSources =
          historicalSourceIds.length > 0
            ? await this.userRepo.find({
                where: { teamId: user.teamId, id: In(historicalSourceIds) },
              })
            : [];

        const sourcePerson = (id: string): CardNoticePerson => {
          if (context.players.some((p) => p.id === id)) return person(id);
          const m = historicalSources.find((item) => item.id === id);
          return {
            id,
            username: m?.username ?? `历史成员 ID: ${id}`,
            displayName: m?.displayName || m?.username || '原连环施卡者',
          };
        };

        const noticeCard = (id: string): CardNoticeCard => {
          const entry = CARD_CATALOG.find((item) => item.id === id)!;
          return { id: toPublicCardId(id), name: entry.name, rarity: entry.rarity };
        };

        const effects = engineRes.effects?.map(
          ({ targetId, actualTargetId, sourceId, sourceCardId, ...rest }) => {
            const sourceCard = sourceCardId
              ? CARD_CATALOG.find((item) => item.id === sourceCardId)
              : undefined;
            return {
              ...rest,
              target: person(targetId),
              ...(actualTargetId ? { actualTarget: sourcePerson(actualTargetId) } : {}),
              ...(sourceId && sourceCard
                ? {
                    source: {
                      user: sourcePerson(sourceId),
                      card: {
                        id: toPublicCardId(sourceCard.id),
                        name: sourceCard.name,
                        rarity: sourceCard.rarity,
                      },
                    },
                  }
                : {}),
            };
          },
        );

        const card = internalCardId
          ? CARD_CATALOG.find((item) => item.id === internalCardId)
          : undefined;
        const actionCard = card
          ? { id: toPublicCardId(card.id), name: card.name, rarity: card.rarity }
          : undefined;

        const descriptions = effects?.map((effect) => {
          const name = `${effect.target.displayName}（${effect.target.username}）`;
          if (effect.outcome === 'blocked') return `${name}：被防御或免疫抵消`;
          if (effect.outcome === 'no-effect') return `${name}：${effect.detail ?? '未产生时长变化'}`;
          const outcome =
            effect.kind === 'time'
              ? `${(effect.deltaSeconds ?? 0) < 0 ? '扣除' : '增加'} ${Math.abs(effect.deltaSeconds ?? 0) / 60} 分钟`
              : effect.detail;
          return `${name}：${effect.outcome === 'reflected' ? `反弹至 ${effect.actualTarget!.displayName}（${effect.actualTarget!.username}），` : ''}${outcome}`;
        });

        const result = {
          action: input.action,
          message: actionCard
            ? `${input.action === 'gift' ? '已赠送' : '已使用'}「${actionCard.name}」。${descriptions?.join('；') ?? ''}`
            : engineRes.message,
          ...(actionCard ? { actionCard } : {}),
          ...(effects ? { effects } : {}),
          ...(engineRes.gainedCardId ? { gainedCardId: toPublicCardId(engineRes.gainedCardId) } : {}),
          ...(engineRes.gainedCardIds
            ? { gainedCardIds: engineRes.gainedCardIds.map(toPublicCardId) }
            : {}),
          ...(engineRes.drawAnimation ? { drawAnimation: engineRes.drawAnimation } : {}),
          ...(engineRes.ssrPity !== undefined ? { ssrPity: engineRes.ssrPity } : {}),
          ...(engineRes.drawCount
            ? { drawCount: engineRes.drawCount, radianceCount: engineRes.radianceCount }
            : {}),
          ...(engineRes.paidDraws !== undefined
            ? { paidDraws: engineRes.paidDraws, spentCoins: engineRes.spentCoins }
            : {}),
        };

        const at = new Date(context.now).toISOString();
        const defenseByRecipient = new Map<string, CardReceiptDefense>();
        for (const defense of engineRes.defenses ?? []) {
          const delivery = defenseByRecipient.get(defense.userId) ?? {
            recipientId: defense.userId,
            notice: { at, events: [] },
          };
          delivery.notice.events.push({
            attacker: sourcePerson(defense.attackerId),
            attackCard: noticeCard(defense.attackCardId),
            defenseCard: noticeCard(defense.defenseCardId),
            outcome: defense.outcome,
          });
          defenseByRecipient.set(defense.userId, delivery);
        }

        const interactions: CardReceiptInteraction[] = [];
        if (input.action === 'use' && actionCard) {
          const recipients = new Set(
            (effects ?? [])
              .flatMap((e) => [e.target.id, e.actualTarget?.id])
              .filter((id): id is string => Boolean(id && id !== user.userId)),
          );
          for (const recipientId of new Set([...recipients, ...defenseByRecipient.keys()])) {
            const ownEffects =
              effects?.filter(
                (e) => e.target.id === recipientId || e.actualTarget?.id === recipientId,
              ) ?? [];
            const selection = ownEffects.some(
              (e) => e.target.id === recipientId && e.randomTarget,
            )
              ? { randomlySelected: true }
              : {};
            const defended = defenseByRecipient.get(recipientId);
            if (defended) {
              Object.assign(defended.notice, selection, { effects: ownEffects });
            } else {
              const source = ownEffects[0]?.source;
              const sameSource =
                source &&
                ownEffects.every(
                  (e) =>
                    e.source?.user.id === source.user.id && e.source.card.id === source.card.id,
                );
              interactions.push({
                recipientId,
                notice: {
                  at,
                  sender: sameSource ? source.user : person(user.userId),
                  card: sameSource ? source.card : actionCard,
                  ...selection,
                  effects: ownEffects,
                },
              });
            }
          }
        }

        const giftPayload: CardReceiptGift | null =
          input.action === 'gift' && actionCard && resolvedTargetId
            ? {
                recipientId: resolvedTargetId,
                notice: { at, sender: person(user.userId), card: actionCard },
              }
            : null;
        const defensesPayload = defenseByRecipient.size > 0 ? [...defenseByRecipient.values()] : null;
        const interactionsPayload = interactions.length > 0 ? interactions : null;

        const archivable = this.extractArchivableWeeks(state, context.now);
        if (archivable.length > 0) {
          await this.persistArchivedWeeksTx(manager, user.teamId, archivable);
        }

        game.state = state as unknown as Record<string, unknown>;
        game.revision += 1;
        game.updatedAt = now;
        const persistedGame = await manager.save(PunchCardGameEntity, game);

        const archive = manager.create(PunchCardActionArchiveEntity, {
          id: newObjectIdHex(),
          teamId: user.teamId,
          receiptKey,
          contentHash: stableDigest({
            actorId: user.userId,
            requestKey: reqKey,
            hash: reqHash,
            at,
            result,
            ...(giftPayload ? { gift: giftPayload } : {}),
            ...(defensesPayload ? { defenses: defensesPayload } : {}),
            ...(interactionsPayload ? { interactions: interactionsPayload } : {}),
          }),
          actorId: user.userId,
          requestKey: reqKey,
          hash: reqHash,
          at,
          result: result as Record<string, unknown>,
          gift: giftPayload as unknown as Record<string, unknown> | null,
          giftReadAt: null,
          defenses: defensesPayload as unknown[] | null,
          defenseReadBy: null,
          interactions: interactionsPayload as unknown[] | null,
          interactionReadBy: null,
        });
        await manager.save(PunchCardActionArchiveEntity, archive);

        return { resultView: result, savedGame: persistedGame, savedState: state, ctx: context };
      },
    );

    // 失效称号缓存（实时更新吕洞宾、相思了等称号）
    this.titlesService.invalidateTeamCache(user.teamId);

    return {
      result: resultView,
      state: await this.buildView(savedGame, savedState, user, ctx),
    };
  }

  async getActionStatus(user: PunchAuthUser, requestKey: string) {
    const receiptKey = sha256Hex(`${user.userId}:${requestKey}`);
    const rec = await this.receiptRepo.findOne({
      where: { teamId: user.teamId, receiptKey },
    });
    if (!rec) throw new NotFoundException('该操作尚未确认，请使用原操作编号重试');
    return { result: rec.result, state: await this.getMe(user) };
  }

  async acknowledgeGifts(user: PunchAuthUser, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const res = await this.receiptRepo
      .createQueryBuilder()
      .update(PunchCardActionArchiveEntity)
      .set({ giftReadAt: new Date() })
      .where('team_id = :teamId', { teamId: user.teamId })
      .andWhere("gift->>'recipientId' = :uid", { uid: user.userId })
      .andWhere('receipt_key IN (:...ids)', { ids: uniqueIds })
      .andWhere('gift_read_at IS NULL')
      .execute();
    return { acknowledged: res.affected ?? 0 };
  }

  async acknowledgeDefenses(user: PunchAuthUser, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const rows = await this.receiptRepo.find({
      where: { teamId: user.teamId, receiptKey: In(uniqueIds) },
    });
    let acknowledged = 0;
    for (const row of rows) {
      const defenses = (row.defenses ?? []) as CardReceiptDefense[];
      if (!defenses.some((d) => d.recipientId === user.userId)) continue;
      const readBy = Array.isArray(row.defenseReadBy) ? [...row.defenseReadBy] : [];
      if (readBy.includes(user.userId)) continue;
      readBy.push(user.userId);
      row.defenseReadBy = readBy;
      await this.receiptRepo.save(row);
      acknowledged += 1;
    }
    return { acknowledged };
  }

  async acknowledgeInteractions(user: PunchAuthUser, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const rows = await this.receiptRepo.find({
      where: { teamId: user.teamId, receiptKey: In(uniqueIds) },
    });
    let acknowledged = 0;
    for (const row of rows) {
      const interactions = (row.interactions ?? []) as CardReceiptInteraction[];
      if (!interactions.some((i) => i.recipientId === user.userId)) continue;
      const readBy = Array.isArray(row.interactionReadBy) ? [...row.interactionReadBy] : [];
      if (readBy.includes(user.userId)) continue;
      readBy.push(user.userId);
      row.interactionReadBy = readBy;
      await this.receiptRepo.save(row);
      acknowledged += 1;
    }
    return { acknowledged };
  }

  /** 代理读取 LecPunch 私有桶中的卡牌立绘，仅允许已解锁该卡的成员读取。 */
  async getCardArtwork(
    user: PunchAuthUser,
    rawId: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const internalId = resolveInternalCardId(rawId);
    if (!internalId) throw new NotFoundException('卡片不存在');
    const game = await this.gameRepo.findOne({ where: { teamId: user.teamId } });
    const state = normalizeGameState(game?.state);
    if (!state.members[user.userId]?.discovered?.includes(internalId)) {
      throw new ForbiddenException('尚未发现这张卡片');
    }
    if (!this.s3Storage.isPunchPrivateConfigured()) {
      throw new ServiceUnavailableException('卡牌私有对象存储尚未配置');
    }
    const key = `${this.cfg.punchStorage.cardAssetsPrefix}/${internalId}.png`;
    const obj = await this.s3Storage.getPunchPrivateObject(key);
    if (!obj) throw new NotFoundException('卡牌图片暂不可用');
    return { body: obj.body, contentType: 'image/png' };
  }
}

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchCardsController {
  constructor(
    private readonly cardsService: PunchCardsService,
    private readonly usersService: PunchUsersService,
  ) {}

  @Get('cards/me')
  getMe(@PunchCurrentUser() user: PunchAuthUser) {
    return this.cardsService.getMe(user);
  }

  @Get('cards/art/:cardId')
  async getArtwork(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('cardId') cardId: string,
    @Res() res: ServerResponse,
  ) {
    const asset = await this.cardsService.getCardArtwork(user, cardId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.body.length));
    res.end(asset.body);
  }

  @Post('cards/actions')
  @HttpCode(HttpStatus.OK)
  performAction(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    return this.cardsService.performActionWithView(user, CardActionSchema.parse(rawBody));
  }

  @Get('cards/actions/:requestKey')
  actionStatus(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('requestKey') requestKey: string,
  ) {
    return this.cardsService.getActionStatus(user, requestKey.trim());
  }

  @Post('cards/gifts/ack')
  @HttpCode(HttpStatus.OK)
  ackGifts(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { ids } = AckIdsSchema.parse(rawBody);
    return this.cardsService.acknowledgeGifts(user, ids);
  }

  @Post('cards/defenses/ack')
  @HttpCode(HttpStatus.OK)
  ackDefenses(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { ids } = AckIdsSchema.parse(rawBody);
    return this.cardsService.acknowledgeDefenses(user, ids);
  }

  @Post('cards/interactions/ack')
  @HttpCode(HttpStatus.OK)
  ackInteractions(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { ids } = AckIdsSchema.parse(rawBody);
    return this.cardsService.acknowledgeInteractions(user, ids);
  }

  @Get('stats/member/:memberKey/cards')
  async memberCards(@PunchCurrentUser() user: PunchAuthUser, @Param('memberKey') memberKey: string) {
    const uid = this.usersService.resolveMemberKey(memberKey);
    if (!uid) throw new BadRequestException('无效的 memberKey');
    const member = await this.usersService.findById(uid);
    if (!member || member.teamId !== user.teamId) {
      throw new ForbiddenException('不可查看其他团队成员的卡牌库存');
    }
    const result = await this.cardsService.getMemberCards(user.teamId, uid);
    return {
      member: {
        memberKey,
        displayName: member.displayName,
      },
      ...result,
    };
  }
}
