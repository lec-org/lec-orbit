import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { FunctionsService } from '../functions/functions.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RosterService } from '../roster/roster.service.js';
import { S3StorageService } from '../storage/s3-storage.service.js';
import { MiniAppEntity } from './entities/mini-app.entity.js';
import { MiniAppVersionEntity } from './entities/mini-app-version.entity.js';
import { MiniAppKvEntity } from './entities/mini-app-kv.entity.js';
import { MiniAppsEngagementService } from './miniapps-engagement.service.js';
import {
  isAllowedGitHubReleaseUrl,
  MINIAPP_MAX_BUNDLE_BYTES,
  normalizeAndValidateManifest,
  validateZipBundle,
  type ExtractedFunctionBundle,
  type MiniAppManifest,
} from './miniapp-validator.util.js';

const KV_MAX_VALUE_BYTES = 64 * 1024;
const KV_MAX_TOTAL_BYTES = 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const REVIEW_CLOSED = '该版本已不在待审核队列中，请刷新工坊';
const REVIEW_PENDING = '该作品已有待审核版本，请先撤回该版本';

export interface MiniAppVersionDTO {
  id: string;
  appId: string;
  version: string;
  channel: string;
  status: string;
  sourceType: string;
  bundleUrl: string;
  bundleSha256: string;
  bundleSize: number;
  iconUrl?: string;
  manifest: Record<string, unknown>;
  changelog: string;
  uploaderId: string;
  reviewerId?: string;
  reviewNote?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface MiniAppCatalogDTO {
  id: string;
  name: string;
  type: string;
  engine: string;
  description: string;
  iconUrl: string;
  tags: string[];
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
  status: string;
  featuredRank: number;
  playCount: number;
  uniquePlayers?: number;
  avgRating?: number | null;
  ratingCount?: number;
  myRatingChances?: number;
  myRatingScore?: number | null;
  activePlayerCount?: number;
  activeVersion?: MiniAppVersionDTO;
  latestVersion?: MiniAppVersionDTO;
  pendingVersion: MiniAppVersionDTO | null;
  recoveryVersion?: MiniAppVersionDTO;
  canDeleteGame?: boolean;
  createdAt: string;
  updatedAt: string;
}

function toVersionDTO(v: MiniAppVersionEntity): MiniAppVersionDTO {
  return {
    id: v.id,
    appId: v.appId,
    version: v.version,
    channel: v.channel,
    status: v.status,
    sourceType: v.sourceType,
    bundleUrl: v.bundleUrl,
    bundleSha256: v.bundleSha256,
    bundleSize: Number(v.bundleSize ?? 0),
    iconUrl: v.iconUrl ?? undefined,
    manifest: v.manifestJson ?? {},
    changelog: v.changelog,
    uploaderId: v.uploaderId,
    reviewerId: v.reviewerId ?? undefined,
    reviewNote: v.reviewNote ?? undefined,
    createdAt: new Date(v.createdAt).toISOString(),
    reviewedAt: v.reviewedAt ? new Date(v.reviewedAt).toISOString() : undefined,
  };
}

function isPendingRelease(version: MiniAppVersionEntity): boolean {
  return version.channel === 'release' && version.status === 'pending';
}

function isDeletableGame(app: MiniAppEntity): boolean {
  return app.type === 'minigame' &&
    (app.status === 'suspended' || (app.status === 'draft' && !app.activeVersionId));
}

function versionMetadata(app: MiniAppEntity, version?: MiniAppVersionEntity) {
  const manifest = version?.manifestJson;
  const valid = manifest?.id === app.id && typeof manifest.name === 'string' && manifest.name !== '';
  return {
    name: valid ? manifest.name as string : app.name,
    type: valid && typeof manifest.type === 'string' ? manifest.type : app.type,
    engine: valid && typeof manifest.engine === 'string' ? manifest.engine : app.engine,
    description: valid ? (typeof manifest.description === 'string' ? manifest.description : '') : app.description,
    tagsJson: valid
      ? (Array.isArray(manifest.tags) ? manifest.tags.filter((tag): tag is string => typeof tag === 'string') : [])
      : (Array.isArray(app.tagsJson) ? app.tagsJson : []),
    iconUrl: version?.iconUrl ?? app.iconUrl,
  };
}

function toCatalogDTO(
  a: MiniAppEntity,
  active?: MiniAppVersionEntity,
  latest?: MiniAppVersionEntity,
  pending?: MiniAppVersionEntity,
  recovery?: MiniAppVersionEntity,
): MiniAppCatalogDTO {
  const metadata = versionMetadata(a, active);
  return {
    id: a.id,
    name: metadata.name,
    type: metadata.type,
    engine: metadata.engine,
    description: metadata.description,
    iconUrl: metadata.iconUrl,
    tags: metadata.tagsJson,
    ownerId: a.ownerId,
    ownerName: a.ownerName,
    ownerAvatar: a.ownerAvatar,
    status: a.status,
    featuredRank: Number(a.featuredRank ?? 0),
    playCount: Number(a.playCount ?? 0),
    activeVersion: active ? toVersionDTO(active) : undefined,
    latestVersion: latest ? toVersionDTO(latest) : undefined,
    pendingVersion: pending ? toVersionDTO(pending) : null,
    recoveryVersion: recovery ? toVersionDTO(recovery) : undefined,
    createdAt: new Date(a.createdAt).toISOString(),
    updatedAt: new Date(a.updatedAt).toISOString(),
  };
}

@Injectable()
export class MiniAppsService {
  private readonly logger = new Logger(MiniAppsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(MiniAppEntity)
    private readonly appRepo: Repository<MiniAppEntity>,
    @InjectRepository(MiniAppVersionEntity)
    private readonly versionRepo: Repository<MiniAppVersionEntity>,
    @InjectRepository(MiniAppKvEntity)
    private readonly kvRepo: Repository<MiniAppKvEntity>,
    private readonly s3: S3StorageService,
    private readonly roster: RosterService,
    private readonly notifications: NotificationsService,
    private readonly functionsService?: FunctionsService,
    private readonly engagementService?: MiniAppsEngagementService,
  ) {}

  private reviewableReleases(repo: Repository<MiniAppVersionEntity>, appId: string) {
    const qb = repo.createQueryBuilder('v');
    const newer = qb.subQuery().select('1').from(MiniAppVersionEntity, 'newer')
      .where("newer.app_id = v.app_id AND newer.status = 'approved'")
      .andWhere('(newer.created_at, newer.id) > (v.created_at, v.id)');
    return qb.where("v.app_id = :appId AND v.channel = 'release' AND v.status = 'pending'", { appId })
      .andWhere(`NOT EXISTS ${newer.getQuery()}`);
  }

  private async assertQueueEmpty(repo: Repository<MiniAppVersionEntity>, appId: string) {
    if (await this.reviewableReleases(repo, appId).getExists()) {
      throw new ConflictException(REVIEW_PENDING);
    }
  }

  private async lockApp(manager: EntityManager, appId: string, includeDeleted = false) {
    const app = await manager.findOne(MiniAppEntity, {
      where: { id: appId }, lock: { mode: 'pessimistic_write' },
    });
    if (!app || (!includeDeleted && app.status === 'deleted')) throw new NotFoundException('应用不存在');
    return app;
  }

  private async supersedeEarlierReleases(manager: EntityManager, version: MiniAppVersionEntity) {
    const qb = manager.getRepository(MiniAppVersionEntity).createQueryBuilder();
    const approved = qb.subQuery().select('approved.created_at, approved.id')
      .from(MiniAppVersionEntity, 'approved').where('approved.id = :approvedId');
    await qb.update().set({ status: 'superseded' })
      .where("app_id = :appId AND channel = 'release' AND status = 'pending'", { appId: version.appId })
      .andWhere(`(created_at, id) < ${approved.getQuery()}`, { approvedId: version.id })
      .execute();
  }

  private async submissionTime(manager: EntityManager, appId: string): Promise<Date> {
    const latest = await manager.findOne(MiniAppVersionEntity, {
      where: { appId }, select: { id: true, createdAt: true }, order: { createdAt: 'DESC', id: 'DESC' },
    });
    return new Date(Math.max(Date.now(), latest ? latest.createdAt.getTime() + 1 : 0));
  }

  private assertUploadOwner(user: AuthUser, existing: MiniAppEntity | null, targetAppId?: string) {
    if (targetAppId && !existing) throw new NotFoundException('工坊作品不存在');
    if (existing && existing.ownerId !== user.userId &&
        (targetAppId || !user.isCaptain || existing.status === 'deleted')) {
      throw new ForbiddenException('仅作品作者可上传新版本');
    }
  }

  private async notifyPending(user: AuthUser, app: MiniAppEntity, version: MiniAppVersionEntity) {
    try {
      const captains = await this.roster.listActiveCaptains();
      const metadata = versionMetadata(app, version);
      await Promise.all(captains.map((captain) => this.notifications.createAndPush({
        sourceApp: 'orbit',
        eventType: 'hub.version.pending',
        title: `工坊上新待审核：《${metadata.name}》v${version.version}`,
        body: `${user.displayName} 提交了 ${metadata.name}（${metadata.engine}），请前往「工坊 → 待审核」试玩并决定是否上架。`,
        payload: { appId: app.id, versionId: version.id, version: version.version },
        targetUserId: captain.userId,
      })));
    } catch (error) {
      this.logger.warn(`工坊审核通知发送失败（${version.id}）`, error);
    }
  }

  async list(
    user: AuthUser,
    query: { type?: string; engine?: string; q?: string; mine?: boolean; pending?: boolean },
  ): Promise<MiniAppCatalogDTO[]> {
    const qb = this.appRepo.createQueryBuilder('a').where('a.status <> :deleted', { deleted: 'deleted' });
    const keyword = query.q?.trim();
    const filterType = query.type === 'miniapp' || query.type === 'minigame';
    const filterEngine = Boolean(query.engine && query.engine !== 'all');
    if (filterType || filterEngine || keyword) {
      qb.leftJoin(MiniAppVersionEntity, 'active', `active.id = a.active_version_id
        AND active.app_id = a.id AND active.manifest_json->>'id' = a.id
        AND active.manifest_json->>'name' <> ''`);
    }

    if (filterType) {
      qb.andWhere("COALESCE(active.manifest_json->>'type', a.type) = :type", { type: query.type });
    }
    if (filterEngine) {
      qb.andWhere("COALESCE(active.manifest_json->>'engine', a.engine) = :engine", { engine: query.engine });
    }
    if (keyword) {
      qb.andWhere(`(COALESCE(active.manifest_json->>'name', a.name) ILIKE :like
        OR (CASE WHEN active.id IS NULL THEN a.description ELSE active.manifest_json->>'description' END) ILIKE :like
        OR a.id ILIKE :like)`, {
        like: `%${keyword}%`,
      });
    }

    if (query.mine) {
      qb.andWhere('a.owner_id = :ownerId', { ownerId: user.userId });
    } else if (!user.isCaptain) {
      qb.andWhere('(a.status = :pub OR a.owner_id = :ownerId)', {
        pub: 'published',
        ownerId: user.userId,
      });
    }

    const apps = await qb
      .orderBy('a.featured_rank', 'DESC')
      .addOrderBy('a.play_count', 'DESC')
      .addOrderBy('a.updated_at', 'DESC')
      .getMany();

    if (apps.length === 0) return [];

    const versions = await this.versionRepo
      .createQueryBuilder('v')
      .where('v.app_id IN (:...ids)', { ids: apps.map((a) => a.id) })
      .orderBy('v.created_at', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .getMany();

    const versionById = new Map<string, MiniAppVersionEntity>();
    const latestByApp = new Map<string, MiniAppVersionEntity>();
    const pendingByApp = new Map<string, MiniAppVersionEntity>();
    const withdrawnByApp = new Map<string, MiniAppVersionEntity>();
    const approvedSeen = new Set<string>();

    for (const v of versions) {
      versionById.set(v.id, v);
      if (!latestByApp.has(v.appId)) latestByApp.set(v.appId, v);
      if (v.status === 'approved') approvedSeen.add(v.appId);
      if (isPendingRelease(v) && !approvedSeen.has(v.appId) && !pendingByApp.has(v.appId)) pendingByApp.set(v.appId, v);
      if (v.channel === 'release' && v.status === 'withdrawn' && !withdrawnByApp.has(v.appId)) {
        withdrawnByApp.set(v.appId, v);
      }
    }

    const items: MiniAppCatalogDTO[] = [];
    for (const a of apps) {
      const isOwner = a.ownerId === user.userId;
      const canSeePrivate = user.isCaptain || isOwner;
      const pending = canSeePrivate ? pendingByApp.get(a.id) : undefined;
      if (query.pending && !pending) continue;
      const active = a.activeVersionId ? versionById.get(a.activeVersionId) : undefined;
      const hitLatest = latestByApp.get(a.id);
      const latest =
        hitLatest && (canSeePrivate || hitLatest.status === 'approved')
          ? hitLatest
          : undefined;
      const withdrawn = withdrawnByApp.get(a.id);
      let recovery: MiniAppVersionEntity | undefined;
      if (isOwner && !pending) {
        if (withdrawn && (!active || withdrawn.createdAt > active.createdAt)) recovery = withdrawn;
        else if (a.status === 'suspended' && active?.status === 'approved') recovery = active;
      }
      const item = toCatalogDTO(a, active, latest, pending, recovery);
      if (isOwner && !pending && isDeletableGame(a)) item.canDeleteGame = true;
      items.push(item);
    }

    if (this.engagementService && items.length > 0) {
      const summaries = await this.engagementService
        .getCatalogSummaries(
          user.userId,
          items.map((item) => item.id),
        )
        .catch(() => null);
      if (summaries) {
        for (const item of items) {
          const s = summaries.get(item.id);
          if (!s) continue;
          item.uniquePlayers = s.uniquePlayers;
          item.avgRating = s.avgRating;
          item.ratingCount = s.ratingCount;
          item.myRatingChances = item.ownerId === user.userId ? 0 : s.myRatingChances;
          item.myRatingScore = s.myRatingScore;
          item.activePlayerCount = s.activePlayerCount;
        }
      }
    }

    return items;
  }

  async getDetail(user: AuthUser, appId: string) {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app || app.status === 'deleted') throw new NotFoundException('工坊应用不存在');
    if (app.status !== 'published' && !user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('无权查看尚未上架的应用');
    }

    const canSeePrivate = user.isCaptain || app.ownerId === user.userId;
    const qb = this.versionRepo
      .createQueryBuilder('v')
      .where('v.app_id = :appId', { appId: app.id })
      .orderBy('v.created_at', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .take(20);
    if (!canSeePrivate) {
      qb.andWhere('v.status = :approved', { approved: 'approved' });
    }
    const versions = await qb.getMany();

    const latest = versions[0];
    const active = app.activeVersionId
      ? versions.find((v) => v.id === app.activeVersionId) ?? await this.versionRepo.findOneBy({
        id: app.activeVersionId, appId, status: 'approved',
      })
      : null;
    const pending = canSeePrivate
      ? await this.reviewableReleases(this.versionRepo, appId).orderBy('v.created_at', 'DESC').addOrderBy('v.id', 'DESC').getOne()
      : null;

    return {
      ...toCatalogDTO(app, active ?? undefined, latest, pending ?? undefined),
      versions: versions.map(toVersionDTO),
    };
  }

  async uploadBundle(
    user: AuthUser,
    fileBuffer: Buffer,
    form: { targetAppId?: string; channel?: string; changelog?: string; directPublish?: string },
  ): Promise<MiniAppCatalogDTO> {
    if (!this.s3.isConfigured()) {
      throw new ServiceUnavailableException('RustFS 对象存储尚未配置，无法上传构建包');
    }
    if (fileBuffer.length <= 0 || fileBuffer.length > MINIAPP_MAX_BUNDLE_BYTES) {
      throw new BadRequestException(
        '构建包体积需在 1B ~ 100MB 之间；更大体积请改用 GitHub Releases 导入',
      );
    }

    let validated;
    try {
      validated = await validateZipBundle(fileBuffer);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'ZIP 校验失败');
    }

    if (form.targetAppId !== undefined && typeof form.targetAppId !== 'string') {
      throw new BadRequestException('无效的作品 ID');
    }
    const targetAppId = form.targetAppId?.trim();
    if (targetAppId && targetAppId !== validated.manifest.id) {
      throw new BadRequestException('构建包内的作品 ID 必须与当前作品一致');
    }
    const existing = await this.appRepo.findOne({ where: { id: validated.manifest.id } });
    this.assertUploadOwner(user, existing, targetAppId);
    if (targetAppId) await this.assertQueueEmpty(this.versionRepo, targetAppId);

    const safeVer = validated.manifest.version.replace(/\//g, '_');
    const bundleRelKey = `miniapps/${validated.manifest.id}/${safeVer}-${validated.sha256.slice(0, 10)}.zip`;
    let bundleUrl: string;
    try {
      bundleUrl = await this.s3.putPublicObject(bundleRelKey, fileBuffer, 'application/zip');
    } catch (err) {
      throw new BadGatewayException(
        `上传构建包至 RustFS 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let iconUrl = '';
    if (validated.iconBytes && validated.iconContentType && validated.iconExt) {
      const iconKey = `miniapps/${validated.manifest.id}/icon-${validated.sha256.slice(0, 8)}${validated.iconExt}`;
      try {
        iconUrl = await this.s3.putPublicObject(
          iconKey,
          validated.iconBytes,
          validated.iconContentType,
        );
      } catch {
        // 图标上传失败不阻塞
      }
    }

    const channel = targetAppId || form.channel?.trim() === 'release' ? 'release' : 'preview';
    const directPublish =
      !targetAppId && user.isCaptain && (form.directPublish === 'true' || form.directPublish === '1');

    return this.persistVersion(user, {
      manifest: validated.manifest,
      targetAppId,
      iconUrl,
      sourceType: 'rustfs',
      bundleUrl,
      bundleKey: bundleRelKey,
      bundleSha256: validated.sha256,
      bundleSize: validated.compressedBytes,
      channel,
      changelog: (form.changelog ?? '').trim(),
      directPublish,
      functionBundle: validated.functionBundle,
    });
  }

  async importFromGitHub(
    user: AuthUser,
    input: {
      targetAppId?: string;
      bundleUrl: string;
      bundleSha256: string;
      bundleSize?: number;
      iconUrl?: string;
      channel?: string;
      changelog?: string;
      directPublish?: boolean;
      manifest: Partial<MiniAppManifest>;
    },
  ): Promise<MiniAppCatalogDTO> {
    if (!isAllowedGitHubReleaseUrl(input.bundleUrl)) {
      throw new BadRequestException(
        '仅允许导入来自 https://github.com 或 githubusercontent.com 的 Releases ZIP 链接',
      );
    }
    const sha = input.bundleSha256.trim().toLowerCase();
    if (!SHA256_HEX_RE.test(sha)) {
      throw new BadRequestException('请提供 64 位十六进制 SHA256 校验值以确保完整性');
    }

    let manifest: MiniAppManifest;
    try {
      manifest = normalizeAndValidateManifest(input.manifest);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Manifest 非法');
    }

    const targetAppId = input.targetAppId?.trim();
    if (targetAppId && targetAppId !== manifest.id) {
      throw new BadRequestException('清单内的作品 ID 必须与当前作品一致');
    }

    return this.persistVersion(user, {
      manifest,
      targetAppId,
      iconUrl: input.iconUrl?.trim() || '',
      sourceType: 'github',
      bundleUrl: input.bundleUrl.trim(),
      bundleKey: '',
      bundleSha256: sha,
      bundleSize: input.bundleSize ?? 0,
      channel: targetAppId || input.channel?.trim() === 'release' ? 'release' : 'preview',
      changelog: (input.changelog ?? '').trim(),
      directPublish: Boolean(!targetAppId && user.isCaptain && input.directPublish),
    });
  }

  private async persistVersion(
    user: AuthUser,
    input: {
      targetAppId?: string;
      manifest: MiniAppManifest;
      iconUrl: string;
      sourceType: string;
      bundleUrl: string;
      bundleKey: string;
      bundleSha256: string;
      bundleSize: number;
      channel: string;
      changelog: string;
      directPublish: boolean;
      functionBundle?: ExtractedFunctionBundle;
    },
  ): Promise<MiniAppCatalogDTO> {
    const verId = randomUUID();
    const status = input.directPublish ? 'approved' : 'pending';

    const { savedApp, savedVer, active } = await this.dataSource.transaction(async (manager) => {
      let app = await manager.findOne(MiniAppEntity, {
        where: { id: input.manifest.id }, lock: { mode: 'pessimistic_write' },
      });
      this.assertUploadOwner(user, app, input.targetAppId);
      const versions = manager.getRepository(MiniAppVersionEntity);
      if (input.targetAppId) await this.assertQueueEmpty(versions, input.targetAppId);
      const now = await this.submissionTime(manager, input.manifest.id);
      const iconUrl = input.iconUrl || app?.iconUrl || '';
      if (!app) {
        app = manager.create(MiniAppEntity, {
          id: input.manifest.id,
          name: input.manifest.name,
          type: input.manifest.type,
          engine: input.manifest.engine,
          description: input.manifest.description,
          iconUrl,
          tagsJson: input.manifest.tags,
          ownerId: user.userId,
          ownerName: user.displayName,
          ownerAvatar: user.avatar,
          status: input.directPublish ? 'published' : 'draft',
          activeVersionId: input.directPublish ? verId : null,
          featuredRank: 0,
          playCount: '0',
          createdAt: now,
          updatedAt: now,
        });
        await manager.insert(MiniAppEntity, app);
      } else if (app.status === 'deleted' || input.directPublish || (!app.activeVersionId && app.status !== 'published')) {
        if (!app.activeVersionId || input.directPublish) {
          app.name = input.manifest.name;
          app.type = input.manifest.type;
          app.engine = input.manifest.engine;
          app.description = input.manifest.description;
          app.tagsJson = input.manifest.tags;
          app.iconUrl = iconUrl;
        }
        if (app.status === 'deleted') app.status = app.activeVersionId ? 'suspended' : 'draft';
        if (input.directPublish) {
          app.status = 'published';
          app.activeVersionId = verId;
        }
        app.updatedAt = now;
        await manager.save(MiniAppEntity, app);
      }

      const ver = manager.create(MiniAppVersionEntity, {
        id: verId,
        appId: input.manifest.id,
        version: input.manifest.version,
        channel: input.channel,
        status,
        sourceType: input.sourceType,
        bundleUrl: input.bundleUrl,
        bundleKey: input.bundleKey,
        bundleSha256: input.bundleSha256,
        bundleSize: String(input.bundleSize),
        iconUrl,
        manifestJson: input.manifest as unknown as Record<string, unknown>,
        changelog: input.changelog,
        uploaderId: user.userId,
        reviewerId: input.directPublish ? user.userId : null,
        reviewNote: null,
        createdAt: now,
        reviewedAt: input.directPublish ? now : null,
      });
      await manager.save(MiniAppVersionEntity, ver);
      if (input.functionBundle && this.functionsService) {
        await this.functionsService.saveVersionBundleTx(
          manager,
          ver.id,
          ver.appId,
          ver.version,
          input.functionBundle,
          now,
        );
      }
      if (input.directPublish) await this.supersedeEarlierReleases(manager, ver);

      const active = input.directPublish ? ver : app.activeVersionId
        ? await versions.findOneBy({ id: app.activeVersionId, appId: app.id, status: 'approved' })
        : null;
      return { savedApp: app, savedVer: ver, active };
    });

    const pending = isPendingRelease(savedVer) ? savedVer : undefined;
    if (pending) await this.notifyPending(user, savedApp, pending);

    return toCatalogDTO(savedApp, active ?? undefined, savedVer, pending);
  }

  async deleteGame(user: AuthUser, appId: string) {
    await this.dataSource.transaction(async (manager) => {
      const app = await this.lockApp(manager, appId, true);
      if (app.status === 'deleted') {
        if (app.ownerId !== user.userId) throw new NotFoundException('应用不存在');
        return;
      }
      if (app.ownerId !== user.userId) throw new ForbiddenException('仅作者可删除游戏');
      if (!isDeletableGame(app)) {
        throw new ConflictException('仅可删除未上架的草稿游戏或已下架的游戏');
      }
      await this.assertQueueEmpty(manager.getRepository(MiniAppVersionEntity), appId);
      await manager.update(MiniAppEntity, appId, { status: 'deleted', updatedAt: new Date() });
    });
    return { ok: true };
  }

  async withdrawVersion(user: AuthUser, appId: string, versionId: string) {
    await this.dataSource.transaction(async (manager) => {
      const app = await this.lockApp(manager, appId);
      if (app.ownerId !== user.userId) throw new ForbiddenException('仅作品作者可撤回送审');
      const versions = manager.getRepository(MiniAppVersionEntity);
      const version = await versions.findOneBy({ id: versionId, appId });
      if (!version) throw new NotFoundException('目标版本不存在');
      if (version.channel === 'release' && version.status === 'withdrawn') return;
      if (!isPendingRelease(version)) throw new ConflictException(REVIEW_CLOSED);
      await versions.update(version.id, { status: 'withdrawn' });
    });
    return { ok: true };
  }

  async resubmitVersion(user: AuthUser, appId: string, versionId: string) {
    const { app, submission } = await this.dataSource.transaction(async (manager) => {
      const app = await this.lockApp(manager, appId);
      if (app.ownerId !== user.userId) throw new ForbiddenException('仅作品作者可重新送审');
      const versions = manager.getRepository(MiniAppVersionEntity);
      const version = await versions.findOneBy({ id: versionId, appId });
      if (!version) throw new NotFoundException('目标版本不存在');
      const withdrawn = version.channel === 'release' && version.status === 'withdrawn';
      const suspendedActive = app.status === 'suspended' && app.activeVersionId === versionId && version.status === 'approved';
      if (!withdrawn && !suspendedActive) throw new ConflictException('此版本当前无法重新送审，请刷新工坊');
      await this.assertQueueEmpty(versions, appId);
      const submission = versions.create({
        ...version,
        id: randomUUID(),
        channel: 'release',
        status: 'pending',
        uploaderId: user.userId,
        reviewerId: null,
        reviewNote: null,
        reviewedAt: null,
        createdAt: await this.submissionTime(manager, appId),
      });
      await versions.save(submission);
      if (this.functionsService) {
        await this.functionsService.cloneVersionBundleTx(
          manager,
          version.id,
          submission.id,
          submission.createdAt,
        );
      }
      return { app, submission };
    });
    await this.notifyPending(user, app, submission);
    return { versionId: submission.id };
  }

  async reviewVersion(
    reviewer: AuthUser,
    appId: string,
    versionId: string,
    decision: 'approve' | 'reject',
    noteRaw?: string,
  ) {
    if (!reviewer.isCaptain) throw new ForbiddenException('仅队长可审核作品');
    const note = (noteRaw ?? '').trim();
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';

    const { app, ver } = await this.dataSource.transaction(async (manager) => {
      const app = await this.lockApp(manager, appId);
      const versions = manager.getRepository(MiniAppVersionEntity);
      const ver = await versions.findOneBy({ id: versionId, appId });
      if (!ver) throw new NotFoundException('目标版本不存在');
      if (!isPendingRelease(ver) || !await this.reviewableReleases(versions, appId)
        .andWhere('v.id = :versionId', { versionId }).getExists()) {
        throw new ConflictException(REVIEW_CLOSED);
      }
      const now = new Date();
      ver.status = nextStatus;
      ver.reviewerId = reviewer.userId;
      ver.reviewNote = note;
      ver.reviewedAt = now;
      await manager.save(MiniAppVersionEntity, ver);

      if (decision === 'approve') {
        await this.supersedeEarlierReleases(manager, ver);
        Object.assign(app, versionMetadata(app, ver));
        app.status = 'published';
        app.activeVersionId = ver.id;
        app.updatedAt = now;
        await manager.save(MiniAppEntity, app);
      }
      return { app, ver };
    });

    const title =
      decision === 'approve'
        ? `《${app.name}》v${ver.version} 已通过审核并上架`
        : `《${app.name}》v${ver.version} 审核未通过`;
    const body =
      decision === 'approve'
        ? `审核人：${reviewer.displayName}。全员现在可以在 Orbit 工坊中打开体验！`
        : `审核人：${reviewer.displayName}。意见：${note}`;

    void this.notifications.createAndPush({
      sourceApp: 'orbit',
      eventType: 'hub.version.reviewed',
      title,
      body,
      payload: { appId: app.id, versionId: ver.id, decision },
      targetUserId: ver.uploaderId,
    }).catch((error: unknown) => this.logger.warn(`工坊审核结果通知发送失败（${ver.id}）`, error));

    return { ok: true, appId: app.id, versionId: ver.id, status: nextStatus };
  }

  async updateStatus(
    user: AuthUser,
    appId: string,
    input: { status?: string; activeVersionId?: string },
  ) {
    await this.dataSource.transaction(async (manager) => {
      const app = await this.lockApp(manager, appId);
      if (!user.isCaptain && app.ownerId !== user.userId) {
        throw new ForbiddenException('仅作者或队长可执行此操作');
      }
      const versions = manager.getRepository(MiniAppVersionEntity);
      if (input.status) {
        if (!['published', 'suspended', 'draft'].includes(input.status)) {
          throw new BadRequestException('不支持的应用状态');
        }
        if (input.status === 'published' && !user.isCaptain) {
          throw new ForbiddenException('普通成员不能直接改为已上架状态');
        }
        if (input.status === 'suspended' && app.status !== 'suspended') {
          await versions.update({ appId, channel: 'release', status: 'pending' }, { status: 'withdrawn' });
        }
        app.status = input.status;
      }
      if (input.activeVersionId) {
        const version = await versions.findOneBy({ id: input.activeVersionId, appId, status: 'approved' });
        if (!version) throw new BadRequestException('仅可回滚到已审核通过的历史版本');
        app.activeVersionId = version.id;
        Object.assign(app, versionMetadata(app, version));
      }
      app.updatedAt = new Date();
      await manager.save(MiniAppEntity, app);
    });
    return { ok: true };
  }

  async recordPlay(appId: string) {
    await this.appRepo.query(
      `UPDATE mini_apps SET play_count = play_count + 1 WHERE id = $1 AND status <> 'deleted'`,
      [appId],
    );
    return { ok: true };
  }

  // ── 托管云存档 KV ──

  private async assertAppNotDeleted(appId: string) {
    if (await this.appRepo.existsBy({ id: appId, status: 'deleted' })) {
      throw new NotFoundException('工坊应用不存在');
    }
  }

  async listKvKeys(userId: string, appId: string) {
    await this.assertAppNotDeleted(appId);
    const rows = await this.kvRepo.find({
      where: { appId, userId },
      select: { key: true },
      order: { key: 'ASC' },
    });
    return { keys: rows.map((r) => r.key) };
  }

  async getKv(userId: string, appId: string, key: string) {
    await this.assertAppNotDeleted(appId);
    const item = await this.kvRepo.findOne({ where: { appId, userId, key } });
    if (!item) throw new NotFoundException('键不存在');
    return {
      key: item.key,
      value: item.valueJson,
      updatedAt: new Date(item.updatedAt).toISOString(),
    };
  }

  async setKv(userId: string, appId: string, key: string, value: unknown) {
    await this.assertAppNotDeleted(appId);
    if (!key || key.length > 128) {
      throw new BadRequestException('存档键长度需在 1~128 字符之间');
    }
    const serialized = JSON.stringify(value === undefined ? null : value);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');
    if (sizeBytes > KV_MAX_VALUE_BYTES) {
      throw new PayloadTooLargeException('单条云存档不能超过 64 KB');
    }

    const [row] = (await this.kvRepo.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::int AS used
       FROM mini_app_kv
       WHERE app_id = $1 AND user_id = $2 AND key <> $3`,
      [appId, userId, key],
    )) as [{ used: number }];
    if (Number(row?.used ?? 0) + sizeBytes > KV_MAX_TOTAL_BYTES) {
      throw new PayloadTooLargeException('单应用云存档总配额已达 1 MB 上限');
    }

    const now = new Date();
    await this.kvRepo.query(
      `INSERT INTO mini_app_kv (app_id, user_id, key, value_json, size_bytes, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (app_id, user_id, key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         size_bytes = EXCLUDED.size_bytes,
         updated_at = EXCLUDED.updated_at`,
      [appId, userId, key, serialized, sizeBytes, now],
    );
    return { ok: true, key, sizeBytes };
  }

  async deleteKv(userId: string, appId: string, key: string) {
    await this.assertAppNotDeleted(appId);
    await this.kvRepo.delete({ appId, userId, key });
    return { ok: true };
  }
}
