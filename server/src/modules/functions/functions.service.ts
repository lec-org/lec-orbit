/**
 * Orbit FaaS（方案 E）核心网关与平台底座能力服务：
 * - 代理调用集群内网 supabase/edge-runtime，并强制校验应用权限、路由白名单与频次限流；
 * - 完整提供 5 大受控 ctx 底座能力（均按 15s 单次上下文令牌强隔离 appId）：
 *   1. ctx.roomState（Redis 房间状态 + CAS 乐观锁 + TTL，支持无 Redis 内存降级）
 *   2. ctx.realtime（复用 RealtimeHub /api/v1/ws 实现发暗牌点对点推送与房间广播）
 *   3. ctx.kv（PostgreSQL 应用级持久化全局 KV）
 *   4. ctx.economy（仅限本应用订单的赌约核验与零和结算）
 *   5. ctx.secrets（AES-256-GCM 加密托管环境变量，作者自助配置、队长可查名不可窃取明文）
 */
import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { openAppSecret, sealAppSecret } from '../../common/utils/crypto-secret.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from '../auth/auth.types.js';
import { EconomyGatewayService } from '../economy/economy-gateway.service.js';
import type { InternalSettleWagerInput } from '../economy/economy.types.js';
import { MiniAppEntity } from '../miniapps/entities/mini-app.entity.js';
import { MiniAppVersionEntity } from '../miniapps/entities/mini-app-version.entity.js';
import type { ExtractedFunctionBundle } from '../miniapps/miniapp-validator.util.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import {
  MiniAppFunctionBundleEntity,
  MiniAppGlobalKvEntity,
  MiniAppSecretEntity,
} from './entities/functions.entities.js';
import {
  FnRateLimiter,
  FnRingLogger,
  signFnContextToken,
  verifyFnContextToken,
  type FnContextClaims,
  type FnInvocationLogEntry,
} from './functions-context.util.js';

const ROOM_STATE_MAX_BYTES = 128 * 1024;
const GLOBAL_KV_MAX_VALUE_BYTES = 64 * 1024;
const GLOBAL_KV_MAX_APP_BYTES = 2 * 1024 * 1024;
const MAX_SECRETS_PER_APP = 32;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const ROOM_ID_RE = /^[a-zA-Z0-9:_-]{1,64}$/;
const FN_NAME_RE = /^[a-zA-Z0-9_-]{1,48}$/;

interface MemoryRoomEntry {
  value: unknown;
  version: number;
  expiresAt: number;
}

@Injectable()
export class FunctionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FunctionsService.name);
  private readonly ringLogger = new FnRingLogger(200);
  private readonly rateLimiter = new FnRateLimiter();

  // Redis 客户端（无 Redis 时自动降级到进程内存，保证单测与本地联调零依赖）
  private redis: Redis | null = null;
  private readonly memRoomState = new Map<string, MemoryRoomEntry>();
  private readonly memRoomMembers = new Map<string, Set<string>>();

  constructor(
    private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(MiniAppEntity)
    private readonly appRepo: Repository<MiniAppEntity>,
    @InjectRepository(MiniAppVersionEntity)
    private readonly versionRepo: Repository<MiniAppVersionEntity>,
    @InjectRepository(MiniAppFunctionBundleEntity)
    private readonly bundleRepo: Repository<MiniAppFunctionBundleEntity>,
    @InjectRepository(MiniAppGlobalKvEntity)
    private readonly globalKvRepo: Repository<MiniAppGlobalKvEntity>,
    @InjectRepository(MiniAppSecretEntity)
    private readonly secretRepo: Repository<MiniAppSecretEntity>,
    private readonly economyGateway: EconomyGatewayService,
    private readonly hub: RealtimeHub,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.redisUrl) return;
    try {
      this.redis = new Redis(this.cfg.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      });
      await this.redis.connect();
      this.logger.log('Orbit FaaS Redis 房间状态与订阅总线已连接');
    } catch (err) {
      this.logger.warn(
        `Orbit FaaS Redis 连接失败，降级为内存存储: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.redis?.disconnect();
      this.redis = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
    this.redis = null;
  }

  private getSigningSecret(): string {
    return (
      this.cfg.internalServiceToken ||
      this.cfg.economy.credentialMasterKey ||
      'orbit-fn-dev-fallback-secret'
    );
  }

  private getEncryptionMasterKey(): string {
    return this.cfg.economy.credentialMasterKey || this.cfg.internalServiceToken || 'orbit-dev-key';
  }

  // ── 1. 函数包持久化与审核源码查看 ──

  /** 在 MiniAppsService.persistVersion 事务内落库提取到的云函数源码/Wasm 包。 */
  async saveVersionBundleTx(
    manager: EntityManager,
    versionId: string,
    appId: string,
    version: string,
    extracted: ExtractedFunctionBundle,
    now: Date,
  ): Promise<void> {
    const entity = manager.create(MiniAppFunctionBundleEntity, {
      versionId,
      appId,
      version,
      routesJson: extracted.routes,
      filesJson: extracted.files,
      timeoutMs: extracted.timeoutMs,
      allowStreaming: extracted.allowStreaming,
      sha256: extracted.sha256,
      createdAt: now,
    });
    await manager.save(MiniAppFunctionBundleEntity, entity);
  }

  /** 重新送审创建新版本记录时，同步克隆原版本的云函数包。 */
  async cloneVersionBundleTx(
    manager: EntityManager,
    fromVersionId: string,
    toVersionId: string,
    now: Date,
  ): Promise<void> {
    const source = await manager.findOne(MiniAppFunctionBundleEntity, {
      where: { versionId: fromVersionId },
    });
    if (!source) return;
    const copy = manager.create(MiniAppFunctionBundleEntity, {
      versionId: toVersionId,
      appId: source.appId,
      version: source.version,
      routesJson: source.routesJson,
      filesJson: source.filesJson,
      timeoutMs: source.timeoutMs,
      allowStreaming: source.allowStreaming,
      sha256: source.sha256,
      createdAt: now,
    });
    await manager.save(MiniAppFunctionBundleEntity, copy);
  }

  /** 作者或队长查看某版本的云函数源码（用于队长审核代码与作者自查）。 */
  private async requireAvailableApp(appId: string): Promise<MiniAppEntity> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app || app.status === 'deleted') throw new NotFoundException('工坊应用不存在');
    return app;
  }

  async getVersionFunctionsSource(user: AuthUser, appId: string, versionId: string) {
    const app = await this.requireAvailableApp(appId);
    if (!user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('仅作品作者或队长可查看云函数源码');
    }

    const bundle = await this.bundleRepo.findOne({ where: { versionId, appId } });
    if (!bundle) {
      return {
        appId,
        versionId,
        hasFunctions: false,
        routes: [],
        files: [],
      };
    }

    return {
      appId: bundle.appId,
      versionId: bundle.versionId,
      version: bundle.version,
      hasFunctions: true,
      routes: bundle.routesJson,
      timeoutMs: bundle.timeoutMs,
      allowStreaming: bundle.allowStreaming,
      sha256: bundle.sha256,
      files: bundle.filesJson.map((f) => ({
        path: f.path,
        isBinary: f.isBinary,
        sizeBytes: f.sizeBytes,
        source: f.isBinary ? null : Buffer.from(f.contentBase64, 'base64').toString('utf8'),
      })),
    };
  }

  /** 供内网 orbit-fn-runtime 按需拉取函数包（仅受 InternalTokenGuard 保护）。 */
  async getInternalBundle(appId: string, versionId: string) {
    await this.requireAvailableApp(appId);
    const bundle = await this.bundleRepo.findOne({ where: { appId, versionId } });
    if (!bundle) {
      throw new NotFoundException('云函数包不存在');
    }
    return {
      appId: bundle.appId,
      versionId: bundle.versionId,
      version: bundle.version,
      routes: bundle.routesJson,
      timeoutMs: bundle.timeoutMs,
      allowStreaming: bundle.allowStreaming,
      sha256: bundle.sha256,
      files: bundle.filesJson,
    };
  }

  // ── 2. 用户调用云函数网关 ──

  /** 校验权限、限流并代理转发至内网 supabase/edge-runtime（返回原始 Response 支持 JSON 与 SSE）。 */
  async invokeFunction(
    user: AuthUser,
    appId: string,
    fnName: string,
    rawBody: unknown,
    opts?: { previewVersionId?: string },
  ): Promise<{
    status: number;
    contentType: string;
    isStream: boolean;
    bodyStream?: ReadableStream<Uint8Array> | null;
    bodyText?: string;
  }> {
    if (!this.cfg.edgeRuntimeUrl) {
      throw new ServiceUnavailableException('Orbit 托管云函数运行时尚未配置');
    }
    if (!FN_NAME_RE.test(fnName)) {
      throw new BadRequestException('无效的云函数名称');
    }

    // 1. 限流校验（应用级 60/min + 单用户 20/min）
    const appLimit = this.rateLimiter.consume(`fn:app:${appId}`, 60, 60_000);
    if (!appLimit.allowed) {
      throw new HttpException(
        `应用云函数调用过于频繁，请 ${appLimit.retryAfterSec} 秒后重试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const userLimit = this.rateLimiter.consume(`fn:user:${appId}:${user.userId}`, 20, 60_000);
    if (!userLimit.allowed) {
      throw new HttpException(
        `你的调用频率超出限制，请 ${userLimit.retryAfterSec} 秒后重试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. 校验应用与目标版本（普通成员仅能调用已上架的 activeVersion；作者/队长可测试指定 previewVersionId）
    const app = await this.requireAvailableApp(appId);

    const isOwnerOrCaptain = user.isCaptain || app.ownerId === user.userId;
    let targetVersionId = app.activeVersionId;
    if (opts?.previewVersionId) {
      if (!isOwnerOrCaptain) {
        throw new ForbiddenException('仅作者或队长可调试未上架的预览版本云函数');
      }
      targetVersionId = opts.previewVersionId;
    } else if (app.status !== 'published' || !targetVersionId) {
      throw new ForbiddenException('该工坊应用尚未上架或未通过审核，无法调用云函数');
    }

    const version = await this.versionRepo.findOne({
      where: { id: targetVersionId, appId: app.id },
    });
    if (!version || (!opts?.previewVersionId && version.status !== 'approved')) {
      throw new ForbiddenException('目标版本未通过审核，无法调用云函数');
    }

    const perms = (version.manifestJson?.permissions ?? {}) as {
      scopes?: unknown;
      networkDomains?: unknown;
    };
    const scopes = Array.isArray(perms.scopes)
      ? perms.scopes.filter((s): s is string => typeof s === 'string')
      : [];
    const allowedDomains = Array.isArray(perms.networkDomains)
      ? perms.networkDomains.filter((d): d is string => typeof d === 'string')
      : [];

    if (!scopes.includes('cloud.functions')) {
      throw new ForbiddenException('该应用版本未获批 cloud.functions 权限');
    }

    const bundle = await this.bundleRepo.findOne({ where: { versionId: version.id, appId: app.id } });
    if (!bundle || !bundle.routesJson.includes(fnName)) {
      throw new NotFoundException(`应用 ${appId} 未提供云函数：${fnName}`);
    }

    // 3. 签发单次短期上下文 JWT 并转发至内网 edge-runtime
    const requestId = randomUUID();
    const ttlSec = bundle.allowStreaming ? 70 : 20;
    const ctxToken = signFnContextToken(
      this.getSigningSecret(),
      {
        appId: app.id,
        versionId: version.id,
        fnName,
        requestId,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        isCaptain: user.isCaptain,
        scopes,
        allowedDomains,
      },
      ttlSec,
    );

    const metaB64 = Buffer.from(
      JSON.stringify({
        appId: app.id,
        versionId: version.id,
        fnName,
        requestId,
        allowedDomains,
        user: {
          userId: user.userId,
          username: user.username,
          displayName: user.displayName,
          isCaptain: user.isCaptain,
        },
      }),
      'utf8',
    ).toString('base64');

    const startedAt = Date.now();
    const invokeUrl = `${this.cfg.edgeRuntimeUrl}/invoke/${encodeURIComponent(app.id)}/${encodeURIComponent(version.id)}/${encodeURIComponent(fnName)}`;
    const hardTimeoutMs = bundle.allowStreaming
      ? Math.min(Math.max(bundle.timeoutMs, 5000), 65_000)
      : Math.min(Math.max(bundle.timeoutMs, 1000), 16_000);

    let resp: Response;
    try {
      resp = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orbit-Internal-Token': this.cfg.internalServiceToken,
          'X-Orbit-Fn-Context-Token': ctxToken,
          'X-Orbit-Fn-Meta': metaB64,
        },
        body: JSON.stringify(rawBody ?? {}),
        signal: AbortSignal.timeout(hardTimeoutMs + 1500),
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.ringLogger.push(app.id, {
        requestId,
        fnName,
        userId: user.userId,
        status: 504,
        durationMs,
        logs: [],
        error: `运行时超时或不可达：${errMsg}`,
        createdAt: new Date().toISOString(),
      });
      throw new BadGatewayException(`云函数执行超时或运行时暂不可用：${errMsg}`);
    }

    const durationMs = Date.now() - startedAt;
    const logs = this.parseLogsHeader(resp.headers.get('x-orbit-fn-logs'));
    const contentType = resp.headers.get('content-type') || 'application/json; charset=utf-8';
    const isStream = contentType.toLowerCase().includes('text/event-stream');

    if (isStream) {
      this.ringLogger.push(app.id, {
        requestId,
        fnName,
        userId: user.userId,
        status: resp.status,
        durationMs,
        logs,
        createdAt: new Date().toISOString(),
      });
      return { status: resp.status, contentType, isStream: true, bodyStream: resp.body };
    }

    const bodyText = await resp.text();
    let errorSummary: string | undefined;
    if (!resp.ok) {
      errorSummary = bodyText.slice(0, 300);
    }
    this.ringLogger.push(app.id, {
      requestId,
      fnName,
      userId: user.userId,
      status: resp.status,
      durationMs,
      logs,
      ...(errorSummary ? { error: errorSummary } : {}),
      createdAt: new Date().toISOString(),
    });
    return { status: resp.status, contentType, isStream: false, bodyText };
  }

  private parseLogsHeader(raw: string | null): Array<{ level: string; text: string }> {
    if (!raw) return [];
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ── 3. 云函数桥接令牌验签与 5 大平台能力实现 ──

  verifyBridgeToken(token: string): FnContextClaims {
    const claims = verifyFnContextToken(this.getSigningSecret(), token);
    if (!claims) {
      throw new UnauthorizedException('无效或已过期的云函数上下文令牌');
    }
    return claims;
  }

  // 3.1 ctx.roomState（Redis + CAS 乐观锁）

  async bridgeRoomStateGet(claims: FnContextClaims, roomId: string) {
    if (!ROOM_ID_RE.test(roomId)) throw new BadRequestException('无效的 roomId');
    const key = `orbit:fn:room:${claims.appId}:${roomId}`;

    if (this.redis) {
      const raw = await this.redis.get(key);
      if (!raw) return { value: null, version: 0 };
      const parsed = JSON.parse(raw) as { value: unknown; version: number };
      return { value: parsed.value ?? null, version: Number(parsed.version ?? 0) };
    }

    const cur = this.memRoomState.get(key);
    if (!cur || Date.now() >= cur.expiresAt) {
      this.memRoomState.delete(key);
      return { value: null, version: 0 };
    }
    return { value: cur.value, version: cur.version };
  }

  async bridgeRoomStateSet(
    claims: FnContextClaims,
    roomId: string,
    input: { value: unknown; ttlSeconds?: number; expectedVersion?: number },
  ) {
    if (!ROOM_ID_RE.test(roomId)) throw new BadRequestException('无效的 roomId');
    const serializedVal = JSON.stringify(input.value ?? null);
    if (Buffer.byteLength(serializedVal, 'utf8') > ROOM_STATE_MAX_BYTES) {
      throw new BadRequestException('房间状态单条体积不能超过 128KB');
    }
    const ttl = Math.min(Math.max(Math.floor(input.ttlSeconds ?? 3600), 10), 86_400);
    const key = `orbit:fn:room:${claims.appId}:${roomId}`;

    if (this.redis) {
      const raw = await this.redis.get(key);
      const curVer = raw ? Number((JSON.parse(raw) as { version?: number }).version ?? 0) : 0;
      if (input.expectedVersion !== undefined && curVer !== input.expectedVersion) {
        throw new ConflictException('房间状态发生并发冲突，请重试');
      }
      const nextVer = curVer + 1;
      await this.redis.set(key, JSON.stringify({ value: input.value ?? null, version: nextVer }), 'EX', ttl);
      return { ok: true, version: nextVer };
    }

    const cur = this.memRoomState.get(key);
    const curVer = cur && Date.now() < cur.expiresAt ? cur.version : 0;
    if (input.expectedVersion !== undefined && curVer !== input.expectedVersion) {
      throw new ConflictException('房间状态发生并发冲突，请重试');
    }
    const nextVer = curVer + 1;
    this.memRoomState.set(key, {
      value: input.value ?? null,
      version: nextVer,
      expiresAt: Date.now() + ttl * 1000,
    });
    return { ok: true, version: nextVer };
  }

  async bridgeRoomStateDel(claims: FnContextClaims, roomId: string) {
    if (!ROOM_ID_RE.test(roomId)) throw new BadRequestException('无效的 roomId');
    const key = `orbit:fn:room:${claims.appId}:${roomId}`;
    if (this.redis) await this.redis.del(key);
    else this.memRoomState.delete(key);
    return { ok: true };
  }

  // 3.2 ctx.realtime（复用 RealtimeHub /api/v1/ws 解决长连接）

  async joinRealtimeRoom(user: AuthUser, appId: string, roomId: string) {
    if (!ROOM_ID_RE.test(roomId)) throw new BadRequestException('无效的 roomId');
    const key = `orbit:ws:room:${appId}:${roomId}`;
    if (this.redis) {
      await this.redis.sadd(key, user.userId);
      await this.redis.expire(key, 86_400);
    } else {
      const set = this.memRoomMembers.get(key) ?? new Set<string>();
      set.add(user.userId);
      this.memRoomMembers.set(key, set);
    }
    return { ok: true, appId, roomId };
  }

  async leaveRealtimeRoom(user: AuthUser, appId: string, roomId: string) {
    if (!ROOM_ID_RE.test(roomId)) throw new BadRequestException('无效的 roomId');
    const key = `orbit:ws:room:${appId}:${roomId}`;
    if (this.redis) {
      await this.redis.srem(key, user.userId);
    } else {
      this.memRoomMembers.get(key)?.delete(user.userId);
    }
    return { ok: true, appId, roomId };
  }

  async bridgeRealtimeSendToUser(
    claims: FnContextClaims,
    input: { targetUserId: string; event: string; payload?: unknown },
  ) {
    const target = input.targetUserId.trim();
    if (!target || !input.event.trim()) throw new BadRequestException('缺少目标用户或事件名');
    await this.hub.pushToUser(target, {
      type: 'miniapp.realtime',
      payload: {
        appId: claims.appId,
        roomId: null,
        event: input.event.trim(),
        payload: input.payload ?? null,
        ts: Date.now(),
      },
    });
    return { ok: true };
  }

  async bridgeRealtimeBroadcastRoom(
    claims: FnContextClaims,
    input: { roomId: string; event: string; payload?: unknown },
  ) {
    if (!ROOM_ID_RE.test(input.roomId) || !input.event.trim()) {
      throw new BadRequestException('无效的 roomId 或事件名');
    }
    const key = `orbit:ws:room:${claims.appId}:${input.roomId}`;
    const members = this.redis
      ? await this.redis.smembers(key)
      : [...(this.memRoomMembers.get(key) ?? [])];

    const evt = {
      type: 'miniapp.realtime',
      payload: {
        appId: claims.appId,
        roomId: input.roomId,
        event: input.event.trim(),
        payload: input.payload ?? null,
        ts: Date.now(),
      },
    };
    await Promise.all(members.map((uid) => this.hub.pushToUser(uid, evt)));
    return { ok: true, delivered: members.length };
  }

  // 3.3 ctx.kv（应用级持久化全局 KV）

  async bridgeKvListKeys(claims: FnContextClaims) {
    const rows = await this.globalKvRepo.find({
      where: { appId: claims.appId },
      select: { key: true },
      order: { key: 'ASC' },
    });
    return { keys: rows.map((r) => r.key) };
  }

  async bridgeKvGet(claims: FnContextClaims, key: string) {
    if (!key || key.length > 128) throw new BadRequestException('KV 键名长度需在 1~128 之间');
    const row = await this.globalKvRepo.findOne({ where: { appId: claims.appId, key } });
    return { value: row ? row.valueJson : null };
  }

  async bridgeKvSet(claims: FnContextClaims, key: string, value: unknown) {
    if (!key || key.length > 128) throw new BadRequestException('KV 键名长度需在 1~128 之间');
    const sizeBytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
    if (sizeBytes > GLOBAL_KV_MAX_VALUE_BYTES) {
      throw new BadRequestException('单条应用 KV 体积不能超过 64KB');
    }
    const [sumRow] = (await this.dataSource.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::int AS total
       FROM mini_app_global_kv WHERE app_id = $1 AND key <> $2`,
      [claims.appId, key],
    )) as [{ total: number }];
    if (Number(sumRow?.total ?? 0) + sizeBytes > GLOBAL_KV_MAX_APP_BYTES) {
      throw new BadRequestException('应用全局 KV 总配额（2MB）已满');
    }
    await this.globalKvRepo.save(
      this.globalKvRepo.create({
        appId: claims.appId,
        key,
        valueJson: value ?? null,
        sizeBytes,
        updatedAt: new Date(),
      }),
    );
    return { ok: true };
  }

  async bridgeKvDel(claims: FnContextClaims, key: string) {
    await this.globalKvRepo.delete({ appId: claims.appId, key });
    return { ok: true };
  }

  // 3.4 ctx.economy（仅限本应用订单，免 App Secret！）

  async bridgeEconomyGetWager(claims: FnContextClaims, orderId: string) {
    const order = await this.economyGateway.getWagerInternal(orderId);
    if (order.appId !== claims.appId) {
      throw new ForbiddenException('云函数禁止访问其他应用的托管赌约单');
    }
    return order;
  }

  async bridgeEconomySettleWager(
    claims: FnContextClaims,
    orderId: string,
    input: InternalSettleWagerInput,
  ) {
    const hasScope =
      claims.scopes.includes('economy.wager.coin') ||
      claims.scopes.includes('economy.wager.punch');
    if (!hasScope) {
      throw new ForbiddenException('应用未获批 economy.wager.* 权限，禁止云函数结算赌约');
    }
    return this.economyGateway.settleWagerInternal(orderId, {
      ...input,
      appId: claims.appId,
    });
  }

  // 3.5 ctx.secrets（加密环境变量管理与读取）

  async bridgeSecretGet(claims: FnContextClaims, name: string) {
    const clean = name.trim();
    if (!SECRET_NAME_RE.test(clean)) return { value: null };
    const row = await this.secretRepo.findOne({ where: { appId: claims.appId, name: clean } });
    if (!row) return { value: null };
    return { value: openAppSecret(row.valueSealed, this.getEncryptionMasterKey()) };
  }

  async listSecrets(user: AuthUser, appId: string) {
    const app = await this.requireAvailableApp(appId);
    if (!user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('仅作品作者或队长可管理环境变量');
    }
    const rows = await this.secretRepo.find({
      where: { appId },
      order: { name: 'ASC' },
    });
    return {
      items: rows.map((r) => ({
        name: r.name,
        updatedBy: r.updatedBy,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async upsertSecret(user: AuthUser, appId: string, name: string, value: string) {
    const app = await this.requireAvailableApp(appId);
    if (!user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('仅作品作者或队长可配置环境变量');
    }
    const cleanName = name.trim().toUpperCase();
    if (!SECRET_NAME_RE.test(cleanName)) {
      throw new BadRequestException('变量名须为大写字母、数字和下划线（2~48 位，如 OPENAI_API_KEY）');
    }
    if (!value || value.length > 4096) {
      throw new BadRequestException('变量值不能为空且不超过 4096 字符');
    }
    const count = await this.secretRepo.count({ where: { appId } });
    const exists = await this.secretRepo.findOne({ where: { appId, name: cleanName } });
    if (!exists && count >= MAX_SECRETS_PER_APP) {
      throw new BadRequestException(`每个应用最多配置 ${MAX_SECRETS_PER_APP} 个环境变量`);
    }

    const sealed = sealAppSecret(value, this.getEncryptionMasterKey());
    await this.secretRepo.save(
      this.secretRepo.create({
        appId,
        name: cleanName,
        valueSealed: sealed,
        updatedBy: user.displayName || user.username || user.userId,
        updatedAt: new Date(),
      }),
    );
    return { ok: true, name: cleanName };
  }

  async deleteSecret(user: AuthUser, appId: string, name: string) {
    const app = await this.requireAvailableApp(appId);
    if (!user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('仅作品作者或队长可删除环境变量');
    }
    await this.secretRepo.delete({ appId, name: name.trim().toUpperCase() });
    return { ok: true };
  }

  // ── 4. 开发者调用日志 ──

  async getInvocationLogs(
    user: AuthUser,
    appId: string,
    limit = 50,
  ): Promise<{ items: FnInvocationLogEntry[] }> {
    const app = await this.requireAvailableApp(appId);
    if (!user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('仅作品作者或队长可查看云函数运行日志');
    }
    return { items: this.ringLogger.list(appId, limit) };
  }
}
