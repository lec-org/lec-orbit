/**
 * 工坊互动统计、实时在玩状态（Presence）、防刷评分机会与排行榜服务：
 * - 实时在玩：桌面端打开作品时每 30 秒上报心跳，关闭时主动清除（Redis / 内存 65 秒 TTL 兜底），通过 RealtimeHub 广播；
 * - 游玩记录：启动并结束算一局，累加 mini_apps.play_count 与 mini_app_play_records（游玩次数不受上限限制）；
 * - 评分机会：每完成一局游玩，非作者用户的 rating_chances 置为 1（封顶 1，绝不叠加），提交后归 0；
 * - 防刷限额：按东八区自然日限制单用户每天全工坊最多评分 5 次、同一作品最多评分 2 次，作者不可自评；
 * - 排行榜：支持综合榜（贝叶斯加权分 + 活跃度）、高分榜与热门游玩榜。
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { DataSource, In, Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from '../auth/auth.types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { OrbitMemberEntity } from '../roster/entities/orbit-member.entity.js';
import { MiniAppEntity } from './entities/mini-app.entity.js';
import { MiniAppPlayDailyEntity } from './entities/mini-app-play-daily.entity.js';
import { MiniAppPlayRecordEntity } from './entities/mini-app-play-record.entity.js';
import { MiniAppRatingEntity } from './entities/mini-app-rating.entity.js';

export const DAILY_MAX_RATINGS_GLOBAL = 5;
export const DAILY_MAX_RATINGS_PER_APP = 2;
const INVITE_RATE_WINDOW_MS = 10 * 60_000;
const INVITE_RATE_MAX_SENT = 15;
const PRESENCE_TTL_MS = 65_000;
const PRESENCE_REDIS_KEY = 'lec:orbit:hub:presence:v1';

/** 计算东八区自然日 YYYY-MM-DD（用于每日防刷评分计数）。 */
export function shanghaiDateKey(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 贝叶斯加权评分：避免仅 1 人打 5 星霸榜，人数越多越逼近真实均分。 */
export function computeBayesianScore(
  avgRating: number | null,
  ratingCount: number,
  priorMean = 3.8,
  priorWeight = 3,
): number {
  if (!avgRating || ratingCount <= 0) return 0;
  const score = (ratingCount / (ratingCount + priorWeight)) * avgRating +
    (priorWeight / (ratingCount + priorWeight)) * priorMean;
  return Number(score.toFixed(3));
}

interface StoredPresence {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  appId: string;
  appName: string;
  appType: string;
  startedAt: number;
  expiresAt: number;
}

export interface ActiveHubPlayerDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  appId: string;
  appName: string;
  appType: string;
  appIconUrl: string;
  startedAt: string;
}

export interface MiniAppCatalogEngagementSummary {
  uniquePlayers: number;
  avgRating: number | null;
  ratingCount: number;
  myRatingChances: number;
  myRatingScore: number | null;
  activePlayerCount: number;
}

export interface MiniAppReviewDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  score: number;
  comment: string;
  ratedAt: string;
}

export interface MiniAppPlayerStatDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  playCount: number;
  totalDurationSeconds: number;
  lastPlayedAt: string;
  score: number | null;
  comment: string;
}

export interface MiniAppDailyTrendPointDTO {
  day: string;
  plays: number;
  uniquePlayers: number;
}

export interface MiniAppStatsDTO {
  appId: string;
  appName: string;
  ownerId: string;
  totalPlays: number;
  uniquePlayers: number;
  avgRating: number | null;
  ratingCount: number;
  activePlayers: ActiveHubPlayerDTO[];
  myPlayCount: number;
  myRating: { score: number; comment: string; ratedAt: string } | null;
  myRatingChances: number;
  isOwner: boolean;
  dailyRatingsRemaining: number;
  dailyAppRatingsRemaining: number;
  dailyMaxRatingsGlobal: number;
  dailyMaxRatingsPerApp: number;
  canViewPlayers: boolean;
  dailyTrend: MiniAppDailyTrendPointDTO[];
  reviews: MiniAppReviewDTO[];
  players: MiniAppPlayerStatDTO[];
}

export interface MiniAppLeaderboardItemDTO {
  rank: number;
  appId: string;
  name: string;
  type: string;
  engine: string;
  iconUrl: string;
  description: string;
  ownerId: string;
  ownerName: string;
  totalPlays: number;
  uniquePlayers: number;
  avgRating: number | null;
  ratingCount: number;
  bayesianScore: number;
  activePlayerCount: number;
  myRatingChances: number;
  myRatingScore: number | null;
}

@Injectable()
export class MiniAppsEngagementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MiniAppsEngagementService.name);
  private readonly localPresence = new Map<string, StoredPresence>();
  private readonly inviteRateMap = new Map<string, number[]>();
  private redis: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly dataSource: DataSource,
    @InjectRepository(MiniAppEntity)
    private readonly appRepo: Repository<MiniAppEntity>,
    @InjectRepository(MiniAppPlayRecordEntity)
    private readonly playRepo: Repository<MiniAppPlayRecordEntity>,
    @InjectRepository(MiniAppPlayDailyEntity)
    private readonly playDailyRepo: Repository<MiniAppPlayDailyEntity>,
    @InjectRepository(MiniAppRatingEntity)
    private readonly ratingRepo: Repository<MiniAppRatingEntity>,
    @InjectRepository(OrbitMemberEntity)
    private readonly memberRepo: Repository<OrbitMemberEntity>,
    private readonly realtime: RealtimeHub,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.redisUrl) return;
    try {
      this.redis = new Redis(this.cfg.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      });
      await this.redis.connect();
    } catch (err) {
      this.logger.warn(
        `工坊在线状态 Redis 不可用，降级为内存存储: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.redis?.disconnect();
      this.redis = null;
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
    this.redis = null;
  }

  private presenceField(userId: string, appId: string): string {
    return `${userId}::${appId}`;
  }

  private async readAllPresence(): Promise<StoredPresence[]> {
    const now = Date.now();
    if (this.redis) {
      try {
        const rawMap = await this.redis.hgetall(PRESENCE_REDIS_KEY);
        const expiredFields: string[] = [];
        const alive: StoredPresence[] = [];
        for (const [field, raw] of Object.entries(rawMap)) {
          try {
            const parsed = JSON.parse(raw) as StoredPresence;
            if (!parsed || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now) {
              expiredFields.push(field);
            } else {
              alive.push(parsed);
            }
          } catch {
            expiredFields.push(field);
          }
        }
        if (expiredFields.length > 0) {
          void this.redis.hdel(PRESENCE_REDIS_KEY, ...expiredFields).catch(() => {});
        }
        return alive;
      } catch {
        // 回退内存
      }
    }
    const alive: StoredPresence[] = [];
    for (const [field, entry] of this.localPresence.entries()) {
      if (entry.expiresAt <= now) {
        this.localPresence.delete(field);
      } else {
        alive.push(entry);
      }
    }
    return alive;
  }

  private async writePresence(entry: StoredPresence): Promise<boolean> {
    const field = this.presenceField(entry.userId, entry.appId);
    let existed = false;
    if (this.redis) {
      try {
        const prev = await this.redis.hget(PRESENCE_REDIS_KEY, field);
        if (prev) {
          try {
            const parsed = JSON.parse(prev) as StoredPresence;
            if (parsed.expiresAt > Date.now()) {
              existed = true;
              entry.startedAt = parsed.startedAt;
            }
          } catch {
            // 忽略损坏记录
          }
        }
        await this.redis.hset(PRESENCE_REDIS_KEY, field, JSON.stringify(entry));
        return !existed;
      } catch {
        // 回退内存
      }
    }
    const prev = this.localPresence.get(field);
    if (prev && prev.expiresAt > Date.now()) {
      existed = true;
      entry.startedAt = prev.startedAt;
    }
    this.localPresence.set(field, entry);
    return !existed;
  }

  private async removePresence(userId: string, appId: string): Promise<boolean> {
    const field = this.presenceField(userId, appId);
    if (this.redis) {
      try {
        const removed = await this.redis.hdel(PRESENCE_REDIS_KEY, field);
        this.localPresence.delete(field);
        return removed > 0;
      } catch {
        // 回退内存
      }
    }
    return this.localPresence.delete(field);
  }

  /** 上报/续期「正在玩某工坊作品」心跳。 */
  async reportPresence(
    user: AuthUser,
    appId: string,
    meta?: { appName?: string; appType?: string },
  ): Promise<{ ok: true }> {
    const app = await this.appRepo.findOne({
      where: { id: appId },
      select: { id: true, name: true, type: true, status: true },
    });
    if (app?.status === 'deleted') throw new NotFoundException('工坊作品不存在');
    const now = Date.now();
    const isNew = await this.writePresence({
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      appId,
      appName: app?.name || meta?.appName?.trim() || appId,
      appType: app?.type || meta?.appType?.trim() || 'minigame',
      startedAt: now,
      expiresAt: now + PRESENCE_TTL_MS,
    });
    if (isNew) {
      this.realtime.broadcast({
        type: 'hub.presence.updated',
        payload: { appId, userId: user.userId, active: true },
      });
    }
    return { ok: true };
  }

  /** 主动退出某工坊作品时立即清理在玩状态并广播。 */
  async clearPresence(userId: string, appId: string): Promise<{ ok: true }> {
    const removed = await this.removePresence(userId, appId);
    if (removed) {
      this.realtime.broadcast({
        type: 'hub.presence.updated',
        payload: { appId, userId, active: false },
      });
    }
    return { ok: true };
  }

  /** 查询当前所有在线游玩的同学与作品列表（用于工坊顶部实时动态条）。 */
  async listActivePresence(): Promise<ActiveHubPlayerDTO[]> {
    const entries = await this.readAllPresence();
    if (entries.length === 0) return [];

    const userIds = Array.from(new Set(entries.map((e) => e.userId)));
    const appIds = Array.from(new Set(entries.map((e) => e.appId)));

    const [members, apps] = await Promise.all([
      this.memberRepo.find({
        where: { userId: In(userIds) },
        select: { userId: true, username: true, displayName: true, avatar: true, enrollYear: true },
      }),
      this.appRepo.find({
        where: { id: In(appIds) },
        select: { id: true, name: true, type: true, iconUrl: true, status: true },
      }),
    ]);

    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const appMap = new Map(apps.map((a) => [a.id, a]));

    return entries
      .filter((e) => appMap.get(e.appId)?.status !== 'deleted')
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => {
        const m = memberMap.get(e.userId);
        const a = appMap.get(e.appId);
        return {
          userId: e.userId,
          username: m?.username || e.username,
          displayName: m?.displayName || e.displayName,
          avatar: m?.avatar || e.avatar,
          enrollYear: m?.enrollYear ?? null,
          appId: e.appId,
          appName: a?.name || e.appName,
          appType: a?.type || e.appType,
          appIconUrl: a?.iconUrl || '',
          startedAt: new Date(e.startedAt).toISOString(),
        };
      });
  }

  /**
   * 结束一局游玩（启动并结束算一局）：
   * - 游玩次数不受限制，始终累加 mini_apps.play_count 与 mini_app_play_records；
   * - 非作者用户的 rating_chances 置为 1（封顶 1，绝不叠加）。
   */
  async endPlaySession(
    user: AuthUser,
    appId: string,
    durationSeconds = 0,
  ): Promise<{
    ok: true;
    tracked: boolean;
    playCount?: number;
    myPlayCount?: number;
    ratingChances?: number;
    dailyRatingsRemaining?: number;
  }> {
    await this.clearPresence(user.userId, appId);

    const safeDur = Math.max(0, Math.min(24 * 3600, Math.round(Number(durationSeconds) || 0)));
    const now = new Date();

    const result = await this.dataSource.transaction(
      async (manager) => {
        const [appRow] = (await manager.query(
          `WITH updated AS (
             UPDATE mini_apps SET play_count = play_count + 1
             WHERE id = $1 AND status <> 'deleted'
             RETURNING play_count::int AS "playCount", owner_id AS "ownerId"
           )
           SELECT "playCount", "ownerId" FROM updated`,
          [appId],
        )) as Array<{ playCount: number; ownerId: string }>;
        if (!appRow) return null;

        const [playRow] = (await manager.query(
          `INSERT INTO mini_app_play_records
             (app_id, user_id, play_count, total_duration_seconds, last_session_seconds, first_played_at, last_played_at)
           VALUES ($1, $2, 1, $3, $3, $4, $4)
           ON CONFLICT (app_id, user_id) DO UPDATE SET
             play_count = mini_app_play_records.play_count + 1,
             total_duration_seconds = mini_app_play_records.total_duration_seconds + EXCLUDED.last_session_seconds,
             last_session_seconds = EXCLUDED.last_session_seconds,
             last_played_at = EXCLUDED.last_played_at
           RETURNING play_count::int AS "myPlayCount"`,
          [appId, user.userId, safeDur, now],
        )) as Array<{ myPlayCount: number }>;

        // 按东八区自然日聚合每日游玩统计（用于折线图与热力图）
        const dayKey = shanghaiDateKey(now);
        await manager.query(
          `INSERT INTO mini_app_play_daily
             (app_id, day_key, user_id, play_count, total_duration_seconds)
           VALUES ($1, $2, $3, 1, $4)
           ON CONFLICT (app_id, day_key, user_id) DO UPDATE SET
             play_count = mini_app_play_daily.play_count + 1,
             total_duration_seconds = mini_app_play_daily.total_duration_seconds + EXCLUDED.total_duration_seconds`,
          [appId, dayKey, user.userId, safeDur],
        );

        let chances = 0;
        if (appRow.ownerId !== user.userId) {
          // 封顶 1 次评分机会，不叠加
          const [ratingRow] = (await manager.query(
            `INSERT INTO mini_app_ratings
               (app_id, user_id, score, comment, rating_chances, rated_count, last_rated_day, today_rated_count, updated_at)
             VALUES ($1, $2, NULL, '', 1, 0, '', 0, $3)
             ON CONFLICT (app_id, user_id) DO UPDATE SET
               rating_chances = 1,
               updated_at = EXCLUDED.updated_at
             RETURNING rating_chances::int AS "ratingChances"`,
            [appId, user.userId, now],
          )) as Array<{ ratingChances: number }>;
          chances = Number(ratingRow?.ratingChances ?? 1);
        }

        return {
          playCount: appRow.playCount,
          myPlayCount: Number(playRow?.myPlayCount ?? 1),
          ratingChances: chances,
        };
      },
    );
    if (!result) return { ok: true, tracked: false };

    const today = shanghaiDateKey(now);
    const globalUsed = await this.getUserDailyRatingCount(user.userId, today);

    return {
      ok: true,
      tracked: true,
      ...result,
      dailyRatingsRemaining: Math.max(0, DAILY_MAX_RATINGS_GLOBAL - globalUsed),
    };
  }

  private async getUserDailyRatingCount(userId: string, dayKey: string): Promise<number> {
    const [row] = (await this.ratingRepo.query(
      `SELECT COALESCE(SUM(today_rated_count), 0)::int AS total
       FROM mini_app_ratings
       WHERE user_id = $1 AND last_rated_day = $2`,
      [userId, dayKey],
    )) as Array<{ total: number }>;
    return Number(row?.total ?? 0);
  }

  /** 提交评分（消耗 1 次评分机会，受每日全工坊 5 次 + 同作品 2 次防刷上限保护）。 */
  async submitRating(
    user: AuthUser,
    appId: string,
    score: number,
    rawComment?: string,
  ): Promise<{
    ok: true;
    avgRating: number | null;
    ratingCount: number;
    myRating: { score: number; comment: string; ratedAt: string };
    myRatingChances: number;
    dailyRatingsRemaining: number;
    dailyAppRatingsRemaining: number;
  }> {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('评分必须为 1~5 星整数');
    }
    const comment = (rawComment ?? '').trim().slice(0, 200);

    const now = new Date();
    const today = shanghaiDateKey(now);

    const result = await this.dataSource.transaction(async (manager) => {
      const app = await manager.findOne(MiniAppEntity, {
        where: { id: appId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!app || app.status === 'deleted') throw new NotFoundException('工坊作品不存在');
      if (app.ownerId === user.userId) {
        throw new BadRequestException('不能给自己的作品评分');
      }

      const existing = await manager.findOne(MiniAppRatingEntity, {
        where: { appId, userId: user.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!existing || Number(existing.ratingChances) < 1) {
        throw new BadRequestException('请先启动并完成一局游玩后再评分（每局最多获得 1 次机会，不叠加）');
      }

      const [globalRow] = (await manager.query(
        `SELECT COALESCE(SUM(today_rated_count), 0)::int AS total
         FROM mini_app_ratings
         WHERE user_id = $1 AND last_rated_day = $2`,
        [user.userId, today],
      )) as Array<{ total: number }>;
      const globalUsed = Number(globalRow?.total ?? 0);
      if (globalUsed >= DAILY_MAX_RATINGS_GLOBAL) {
        throw new BadRequestException(
          `今日评分次数已达上限（每天最多 ${DAILY_MAX_RATINGS_GLOBAL} 次），明天再来评价吧`,
        );
      }

      const appTodayUsed = existing.lastRatedDay === today ? Number(existing.todayRatedCount ?? 0) : 0;
      if (appTodayUsed >= DAILY_MAX_RATINGS_PER_APP) {
        throw new BadRequestException(
          `今日对该作品的评分次数已达上限（同一作品每天最多 ${DAILY_MAX_RATINGS_PER_APP} 次）`,
        );
      }

      existing.score = score;
      existing.comment = comment;
      existing.ratingChances = 0;
      existing.ratedCount = Number(existing.ratedCount ?? 0) + 1;
      existing.lastRatedDay = today;
      existing.todayRatedCount = appTodayUsed + 1;
      existing.ratedAt = now;
      existing.updatedAt = now;
      await manager.save(MiniAppRatingEntity, existing);

      const [agg] = (await manager.query(
        `SELECT COUNT(*)::int AS cnt, ROUND(AVG(score)::numeric, 2)::float AS avg
         FROM mini_app_ratings
         WHERE app_id = $1 AND score IS NOT NULL`,
        [appId],
      )) as Array<{ cnt: number; avg: number | null }>;

      return {
        avgRating: agg?.avg !== null && agg?.avg !== undefined ? Number(agg.avg) : null,
        ratingCount: Number(agg?.cnt ?? 0),
        dailyRatingsRemaining: Math.max(0, DAILY_MAX_RATINGS_GLOBAL - (globalUsed + 1)),
        dailyAppRatingsRemaining: Math.max(0, DAILY_MAX_RATINGS_PER_APP - (appTodayUsed + 1)),
      };
    });

    return {
      ok: true,
      avgRating: result.avgRating,
      ratingCount: result.ratingCount,
      myRating: { score, comment, ratedAt: now.toISOString() },
      myRatingChances: 0,
      dailyRatingsRemaining: result.dailyRatingsRemaining,
      dailyAppRatingsRemaining: result.dailyAppRatingsRemaining,
    };
  }

  /** 批量拉取工坊目录卡片的互动摘要（供 MiniAppsService.list 挂载，O(1) SQL）。 */
  async getCatalogSummaries(
    userId: string,
    appIds: string[],
  ): Promise<Map<string, MiniAppCatalogEngagementSummary>> {
    const result = new Map<string, MiniAppCatalogEngagementSummary>();
    if (appIds.length === 0) return result;

    const [playAggs, ratingAggs, myRatings, activePresence] = await Promise.all([
      this.playRepo.query(
        `SELECT app_id AS "appId", COUNT(*)::int AS "uniquePlayers"
         FROM mini_app_play_records
         WHERE app_id = ANY($1::text[])
         GROUP BY app_id`,
        [appIds],
      ) as Promise<Array<{ appId: string; uniquePlayers: number }>>,
      this.ratingRepo.query(
        `SELECT app_id AS "appId",
                COUNT(*)::int AS "ratingCount",
                ROUND(AVG(score)::numeric, 2)::float AS "avgRating"
         FROM mini_app_ratings
         WHERE app_id = ANY($1::text[]) AND score IS NOT NULL
         GROUP BY app_id`,
        [appIds],
      ) as Promise<Array<{ appId: string; ratingCount: number; avgRating: number | null }>>,
      this.ratingRepo.find({
        where: { userId, appId: In(appIds) },
        select: { appId: true, ratingChances: true, score: true },
      }),
      this.readAllPresence(),
    ]);

    const playMap = new Map(playAggs.map((r) => [r.appId, Number(r.uniquePlayers ?? 0)]));
    const ratingMap = new Map(
      ratingAggs.map((r) => [
        r.appId,
        {
          ratingCount: Number(r.ratingCount ?? 0),
          avgRating: r.avgRating !== null && r.avgRating !== undefined ? Number(r.avgRating) : null,
        },
      ]),
    );
    const myMap = new Map(myRatings.map((r) => [r.appId, r]));
    const activeCountMap = new Map<string, number>();
    for (const p of activePresence) {
      activeCountMap.set(p.appId, (activeCountMap.get(p.appId) ?? 0) + 1);
    }

    for (const id of appIds) {
      const rate = ratingMap.get(id);
      const mine = myMap.get(id);
      result.set(id, {
        uniquePlayers: playMap.get(id) ?? 0,
        avgRating: rate?.avgRating ?? null,
        ratingCount: rate?.ratingCount ?? 0,
        myRatingChances: Number(mine?.ratingChances ?? 0),
        myRatingScore: mine?.score !== null && mine?.score !== undefined ? Number(mine.score) : null,
        activePlayerCount: activeCountMap.get(id) ?? 0,
      });
    }
    return result;
  }

  /** 查看单个作品的统计数据、近 35 天日维度趋势/热力图、公开评价列表以及全员可见的游玩同学明细。 */
  async getAppStats(user: AuthUser, appId: string): Promise<MiniAppStatsDTO> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app || app.status === 'deleted') throw new NotFoundException('工坊作品不存在');

    const isOwner = app.ownerId === user.userId;
    const canViewPlayers = true;
    const now = new Date();
    const today = shanghaiDateKey(now);
    const trendDays = 35;
    const startDay = shanghaiDateKey(new Date(now.getTime() - (trendDays - 1) * 86_400_000));

    const [playRows, ratingRows, activeAll, globalUsed, dailyRows] = await Promise.all([
      this.playRepo.find({
        where: { appId },
        order: { lastPlayedAt: 'DESC' },
      }),
      this.ratingRepo.find({
        where: { appId },
        order: { ratedAt: 'DESC', updatedAt: 'DESC' },
      }),
      this.listActivePresence(),
      this.getUserDailyRatingCount(user.userId, today),
      this.playDailyRepo.query(
        `SELECT day_key AS "day",
                COALESCE(SUM(play_count), 0)::int AS "plays",
                COUNT(DISTINCT user_id)::int AS "uniquePlayers"
         FROM mini_app_play_daily
         WHERE app_id = $1 AND day_key >= $2
         GROUP BY day_key
         ORDER BY day_key ASC`,
        [appId, startDay],
      ) as Promise<Array<{ day: string; plays: number; uniquePlayers: number }>>,
    ]);

    const dailyMap = new Map(
      dailyRows.map((row) => [
        row.day,
        { plays: Number(row.plays ?? 0), uniquePlayers: Number(row.uniquePlayers ?? 0) },
      ]),
    );
    const dailyTrend: MiniAppDailyTrendPointDTO[] = [];
    for (let offset = trendDays - 1; offset >= 0; offset -= 1) {
      const day = shanghaiDateKey(new Date(now.getTime() - offset * 86_400_000));
      const hit = dailyMap.get(day);
      dailyTrend.push({
        day,
        plays: hit?.plays ?? 0,
        uniquePlayers: hit?.uniquePlayers ?? 0,
      });
    }

    const relatedUserIds = Array.from(
      new Set([...playRows.map((p) => p.userId), ...ratingRows.map((r) => r.userId)]),
    );
    const members =
      relatedUserIds.length > 0
        ? await this.memberRepo.find({
            where: { userId: In(relatedUserIds) },
            select: { userId: true, username: true, displayName: true, avatar: true, enrollYear: true },
          })
        : [];
    const memberMap = new Map(members.map((m) => [m.userId, m]));

    const ratingByUser = new Map(ratingRows.map((r) => [r.userId, r]));
    const scoredRatings = ratingRows.filter((r) => r.score !== null && r.score !== undefined);
    const ratingCount = scoredRatings.length;
    const avgRating =
      ratingCount > 0
        ? Number((scoredRatings.reduce((sum, r) => sum + Number(r.score ?? 0), 0) / ratingCount).toFixed(2))
        : null;

    const myPlay = playRows.find((p) => p.userId === user.userId);
    const myRatingRow = ratingByUser.get(user.userId);
    const appTodayUsed =
      myRatingRow && myRatingRow.lastRatedDay === today ? Number(myRatingRow.todayRatedCount ?? 0) : 0;

    const reviews: MiniAppReviewDTO[] = scoredRatings.map((r) => {
      const m = memberMap.get(r.userId);
      return {
        userId: r.userId,
        username: m?.username ?? '',
        displayName: m?.displayName || m?.username || '工作室成员',
        avatar: m?.avatar ?? '',
        enrollYear: m?.enrollYear ?? null,
        score: Number(r.score),
        comment: r.comment || '',
        ratedAt: (r.ratedAt ?? r.updatedAt).toISOString(),
      };
    });

    const players: MiniAppPlayerStatDTO[] = canViewPlayers
      ? playRows.map((p) => {
          const m = memberMap.get(p.userId);
          const r = ratingByUser.get(p.userId);
          return {
            userId: p.userId,
            username: m?.username ?? '',
            displayName: m?.displayName || m?.username || '工作室成员',
            avatar: m?.avatar ?? '',
            enrollYear: m?.enrollYear ?? null,
            playCount: Number(p.playCount ?? 0),
            totalDurationSeconds: Number(p.totalDurationSeconds ?? 0),
            lastPlayedAt: new Date(p.lastPlayedAt).toISOString(),
            score: r?.score !== null && r?.score !== undefined ? Number(r.score) : null,
            comment: r?.comment ?? '',
          };
        })
      : [];

    return {
      appId: app.id,
      appName: app.name,
      ownerId: app.ownerId,
      totalPlays: Number(app.playCount ?? 0),
      uniquePlayers: playRows.length,
      avgRating,
      ratingCount,
      activePlayers: activeAll.filter((p) => p.appId === appId),
      myPlayCount: Number(myPlay?.playCount ?? 0),
      myRating:
        myRatingRow && myRatingRow.score !== null && myRatingRow.score !== undefined
          ? {
              score: Number(myRatingRow.score),
              comment: myRatingRow.comment || '',
              ratedAt: (myRatingRow.ratedAt ?? myRatingRow.updatedAt).toISOString(),
            }
          : null,
      myRatingChances: isOwner ? 0 : Number(myRatingRow?.ratingChances ?? 0),
      isOwner,
      dailyRatingsRemaining: Math.max(0, DAILY_MAX_RATINGS_GLOBAL - globalUsed),
      dailyAppRatingsRemaining: Math.max(0, DAILY_MAX_RATINGS_PER_APP - appTodayUsed),
      dailyMaxRatingsGlobal: DAILY_MAX_RATINGS_GLOBAL,
      dailyMaxRatingsPerApp: DAILY_MAX_RATINGS_PER_APP,
      canViewPlayers,
      dailyTrend,
      reviews,
      players,
    };
  }

  /** 工坊游戏/应用排行榜（支持综合榜 / 高分榜 / 热门游玩榜）。 */
  async getLeaderboard(
    user: AuthUser,
    options: { sort?: string; type?: string },
  ): Promise<{ sort: 'composite' | 'rating' | 'plays'; items: MiniAppLeaderboardItemDTO[] }> {
    const sort: 'composite' | 'rating' | 'plays' =
      options.sort === 'rating' || options.sort === 'plays' ? options.sort : 'composite';

    const qb = this.appRepo.createQueryBuilder('a').where("a.status = 'published'");
    if (options.type === 'minigame' || options.type === 'miniapp') {
      qb.andWhere('a.type = :type', { type: options.type });
    }
    const apps = await qb.getMany();
    if (apps.length === 0) return { sort, items: [] };

    const summaries = await this.getCatalogSummaries(
      user.userId,
      apps.map((a) => a.id),
    );

    const rows = apps.map((app) => {
      const s = summaries.get(app.id);
      const avgRating = s?.avgRating ?? null;
      const ratingCount = s?.ratingCount ?? 0;
      const uniquePlayers = s?.uniquePlayers ?? 0;
      const totalPlays = Number(app.playCount ?? 0);
      const bayesianScore = computeBayesianScore(avgRating, ratingCount);
      return {
        appId: app.id,
        name: app.name,
        type: app.type,
        engine: app.engine,
        iconUrl: app.iconUrl,
        description: app.description,
        ownerId: app.ownerId,
        ownerName: app.ownerName,
        totalPlays,
        uniquePlayers,
        avgRating,
        ratingCount,
        bayesianScore,
        activePlayerCount: s?.activePlayerCount ?? 0,
        myRatingChances: app.ownerId === user.userId ? 0 : (s?.myRatingChances ?? 0),
        myRatingScore: s?.myRatingScore ?? null,
      };
    });

    rows.sort((a, b) => {
      if (sort === 'rating') {
        return (
          (b.avgRating ?? -1) - (a.avgRating ?? -1) ||
          b.ratingCount - a.ratingCount ||
          b.uniquePlayers - a.uniquePlayers
        );
      }
      if (sort === 'plays') {
        return (
          b.uniquePlayers - a.uniquePlayers ||
          b.totalPlays - a.totalPlays ||
          b.bayesianScore - a.bayesianScore
        );
      }
      // 综合榜：贝叶斯加权评分 + 游玩人气平滑加权
      const scoreA = a.bayesianScore + Math.log10(1 + a.uniquePlayers * 2 + a.totalPlays * 0.3) * 0.45;
      const scoreB = b.bayesianScore + Math.log10(1 + b.uniquePlayers * 2 + b.totalPlays * 0.3) * 0.45;
      return scoreB - scoreA || b.totalPlays - a.totalPlays;
    });

    return {
      sort,
      items: rows.slice(0, 50).map((row, idx) => ({ rank: idx + 1, ...row })),
    };
  }

  /**
   * 发起工坊组队房间邀请（供 orbitSDK.multiplayer.sendRoomInvite 调用）：
   * - 强校验目标均为本工作室成员、禁止邀请自己、单次最多 8 人、10 分钟内限发 15 份防骚扰；
   * - 向每位受邀同学实时推送可交互通知（hub.room_invite），对方点「接受并进房」即直达对应游戏与房间。
   */
  async sendRoomInvites(
    user: AuthUser,
    appId: string,
    input: {
      toUserIds: string[];
      roomId: string;
      roomName?: string;
      message?: string;
      mode?: 'sidepanel' | 'workspace' | 'standalone';
      expiresInSeconds?: number;
      meta?: Record<string, unknown>;
      appNameHint?: string;
    },
  ): Promise<{
    ok: true;
    appId: string;
    roomId: string;
    expiresAt: string;
    sent: Array<{ userId: string; displayName: string; inviteId: string }>;
  }> {
    const roomId = input.roomId.trim();
    if (!roomId || roomId.length > 128) {
      throw new BadRequestException('房间号长度需在 1~128 字符之间');
    }

    const targets = Array.from(
      new Set(input.toUserIds.map((id) => id.trim()).filter((id) => id && id !== user.userId)),
    );
    if (targets.length === 0) {
      throw new BadRequestException('请至少选择一位其他工作室成员发起邀请');
    }
    if (targets.length > 8) {
      throw new BadRequestException('单次最多同时邀请 8 位队友');
    }

    // 简单滑动窗口防刷（10 分钟最多发送 15 份组队邀请）
    const nowMs = Date.now();
    const recent = (this.inviteRateMap.get(user.userId) ?? []).filter(
      (ts) => nowMs - ts < INVITE_RATE_WINDOW_MS,
    );
    if (recent.length + targets.length > INVITE_RATE_MAX_SENT) {
      throw new BadRequestException('发送组队邀请过于频繁，请稍后再试（10 分钟内最多 15 人次）');
    }

    const [app, validMembers] = await Promise.all([
      this.appRepo.findOne({ where: { id: appId } }),
      this.memberRepo.find({
        where: { userId: In(targets), isActive: true },
        select: { userId: true, username: true, displayName: true, avatar: true },
      }),
    ]);

    if (app?.status === 'deleted') throw new NotFoundException('工坊作品不存在');
    if (validMembers.length === 0) {
      throw new BadRequestException('未找到有效的受邀工作室成员');
    }

    const appName = app?.name || input.appNameHint?.trim() || appId;
    const appIconUrl = app?.iconUrl || '';
    const roomName = (input.roomName ?? '').trim().slice(0, 64);
    const customMsg = (input.message ?? '').trim().slice(0, 140);
    const ttlSeconds = Math.min(3600, Math.max(60, Math.round(input.expiresInSeconds ?? 600)));
    const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();

    const sent: Array<{ userId: string; displayName: string; inviteId: string }> = [];
    for (const member of validMembers) {
      const notif = await this.notifications.createAndPush({
        sourceApp: 'orbit',
        eventType: 'hub.room_invite',
        title: `${user.displayName} 邀请你加入《${appName}》组队`,
        body:
          customMsg ||
          `房间：${roomName || roomId} · 点击「接受并进房」立即打开并加入对局`,
        payload: {
          appId,
          appName,
          appIconUrl,
          roomId,
          roomName: roomName || undefined,
          mode: input.mode,
          message: customMsg || undefined,
          meta: input.meta ?? undefined,
          inviterId: user.userId,
          inviterUsername: user.username,
          inviterName: user.displayName,
          inviterAvatar: user.avatar,
          expiresAt,
        },
        targetUserId: member.userId,
        actionStatus: 'pending',
      });
      sent.push({
        userId: member.userId,
        displayName: member.displayName || member.username,
        inviteId: notif.id,
      });
      recent.push(nowMs);
    }

    this.inviteRateMap.set(user.userId, recent);

    return {
      ok: true,
      appId,
      roomId,
      expiresAt,
      sent,
    };
  }
}
