import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import { DataSource } from 'typeorm';
import { loadAppConfig } from '../src/config/env.config.js';
import { InitialSchema1764000000000 } from '../src/database/migrations/1764000000000-InitialSchema.js';
import { AddMiniAppVersionIconUrl1764200000000 } from '../src/database/migrations/1764200000000-AddMiniAppVersionIconUrl.js';
import { AddOrbitMemberProfileFields1764400000000 } from '../src/database/migrations/1764400000000-AddOrbitMemberProfileFields.js';
import type { AuthUser } from '../src/modules/auth/auth.types.js';
import { MiniAppKvEntity } from '../src/modules/miniapps/entities/mini-app-kv.entity.js';
import { MiniAppVersionEntity } from '../src/modules/miniapps/entities/mini-app-version.entity.js';
import { MiniAppEntity } from '../src/modules/miniapps/entities/mini-app.entity.js';
import { MiniAppsService } from '../src/modules/miniapps/miniapps.service.js';
import type { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { OrbitMemberEntity } from '../src/modules/roster/entities/orbit-member.entity.js';
import { RosterService } from '../src/modules/roster/roster.service.js';
import type { S3StorageService } from '../src/modules/storage/s3-storage.service.js';

const dsn = process.env.ORBIT_TEST_POSTGRES_DSN?.trim();

function member(id: string, isCaptain = false): AuthUser {
  return {
    userId: id,
    username: id,
    displayName: id,
    avatar: '',
    organizations: ['lec-studio'],
    roles: [],
    isStudio: true,
    isCaptain,
  };
}

function bundle(id: string, version: string, name: string): Buffer {
  return Buffer.from(zipSync({
    'orbit.manifest.json': strToU8(JSON.stringify({
      schemaVersion: 1, id, version, name, type: 'minigame', engine: 'web',
      entry: 'index.html', icon: 'icon.svg', description: name, tags: [version],
    })),
    'index.html': strToU8('<!doctype html><title>Workshop</title>'),
    'icon.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  }));
}

async function responseStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe.skipIf(!dsn)('Workshop release lifecycle (PostgreSQL)', () => {
  const schema = `workshop_test_${randomUUID().replaceAll('-', '')}`;
  const author = member('author');
  const visitor = member('visitor');
  const captain = member('captain', true);
  const legacyAppId = `legacy-${randomUUID()}`;
  const legacyVersionId = randomUUID();
  let db: DataSource;
  let service: MiniAppsService;
  let schemaCreated = false;

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres', url: dsn, schema,
      entities: [MiniAppEntity, MiniAppVersionEntity, MiniAppKvEntity, OrbitMemberEntity],
      extra: { options: `-c search_path=${schema}` },
    }).initialize();
    await db.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    const runner = db.createQueryRunner();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      await new InitialSchema1764000000000().up(runner);
      await runner.query(
        `INSERT INTO mini_apps (id, name, type, engine, owner_id, created_at, updated_at)
         VALUES ($1, 'Legacy work', 'minigame', 'web', $2, now(), now())`,
        [legacyAppId, author.userId],
      );
      await runner.query(
        `INSERT INTO mini_app_versions (id, app_id, version, bundle_url, bundle_sha256, uploader_id, created_at)
         VALUES ($1, $2, '0.9.0', 'https://bundles.example.test/legacy.zip', $3, $4, now())`,
        [legacyVersionId, legacyAppId, 'a'.repeat(64), author.userId],
      );
      const migration = new AddMiniAppVersionIconUrl1764200000000();
      await migration.up(runner);
      await migration.down(runner);
      await migration.up(runner);
      await migration.up(runner);
      await new AddOrbitMemberProfileFields1764400000000().up(runner);
    } finally {
      await runner.release();
    }

    const rosterRepo = db.getRepository(OrbitMemberEntity);
    await rosterRepo.insert({
      userId: captain.userId, displayName: captain.displayName, isCaptain: true, updatedAt: new Date(),
    });

    const storage: Pick<S3StorageService, 'isConfigured' | 'putPublicObject'> = {
      isConfigured: () => true,
      putPublicObject: async (key) => `https://bundles.example.test/${key}`,
    };
    const notifications: Pick<NotificationsService, 'createAndPush'> = {
      createAndPush: async (input) => ({
        id: randomUUID(), sourceApp: input.sourceApp, eventType: input.eventType,
        title: input.title, body: input.body ?? '', payload: input.payload ?? {},
        targetUserId: input.targetUserId ?? undefined,
        actionStatus: input.actionStatus ?? undefined, isRead: false,
        createdAt: new Date().toISOString(),
      }),
    };
    service = new MiniAppsService(
      db, db.getRepository(MiniAppEntity), db.getRepository(MiniAppVersionEntity),
      db.getRepository(MiniAppKvEntity), storage as S3StorageService,
      new RosterService(rosterRepo, loadAppConfig({})),
      notifications as NotificationsService,
    );
  }, 15_000);

  afterAll(async () => {
    if (!db?.isInitialized) return;
    try {
      if (schemaCreated) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.destroy();
    }
  });

  it('preserves a preexisting build when the nullable version icon migration reapplies', async () => {
    expect(await db.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'mini_app_versions' AND column_name = 'icon_url'`,
      [schema],
    )).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);
    expect(await db.getRepository(MiniAppVersionEntity).findOneByOrFail({ id: legacyVersionId }))
      .toMatchObject({
        appId: legacyAppId, version: '0.9.0', iconUrl: null,
        bundleUrl: 'https://bundles.example.test/legacy.zip', bundleSha256: 'a'.repeat(64),
      });
  });

  it('lets only the owner withdraw and returns an explicit null for the empty queue', async () => {
    const id = `withdraw-${randomUUID()}`;
    const uploaded = await service.uploadBundle(author, bundle(id, '1.0.0', 'First build'), {
      channel: 'release',
    });
    const pendingId = uploaded.pendingVersion!.id;
    expect(await responseStatus(service.withdrawVersion(visitor, id, pendingId))).toBe(403);
    expect(await responseStatus(service.withdrawVersion(captain, id, pendingId))).toBe(403);
    expect(await responseStatus(service.withdrawVersion(author, id, pendingId))).toBe(200);
    expect(await responseStatus(service.withdrawVersion(author, id, pendingId))).toBe(200);
    expect(await responseStatus(service.reviewVersion(captain, id, pendingId, 'approve'))).toBe(409);
    expect((await service.list(captain, { pending: true })).some((app) => app.id === id)).toBe(false);
    const owned = (await service.list(author, { mine: true })).find((app) => app.id === id);
    expect(JSON.stringify(owned)).toContain('"pendingVersion":null');
  });

  it('resubmits the same build under a fresh review ID', async () => {
    const id = `retry-${randomUUID()}`;
    const uploaded = await service.uploadBundle(author, bundle(id, '1.0.0', 'Retry build'), {
      channel: 'release', changelog: 'Changes for review',
    });
    const originalId = uploaded.pendingVersion!.id;
    await service.withdrawVersion(author, id, originalId);
    expect(await responseStatus(service.resubmitVersion(visitor, id, originalId))).toBe(403);

    const retry = await service.resubmitVersion(author, id, originalId);
    expect(retry.versionId).not.toBe(originalId);
    const versions = db.getRepository(MiniAppVersionEntity);
    const original = await versions.findOneByOrFail({ id: originalId });
    expect(original.status).toBe('withdrawn');
    expect(await versions.findOneByOrFail({ id: retry.versionId })).toMatchObject({
      appId: id, status: 'pending', channel: 'release', version: original.version,
      bundleUrl: original.bundleUrl, bundleKey: original.bundleKey,
      bundleSha256: original.bundleSha256, bundleSize: original.bundleSize,
      manifestJson: original.manifestJson, changelog: original.changelog,
      reviewerId: null, reviewNote: null, reviewedAt: null,
    });
    expect(await responseStatus(service.resubmitVersion(author, id, originalId))).toBe(409);
    expect(await responseStatus(service.reviewVersion(captain, id, originalId, 'approve'))).toBe(409);
    expect((await service.list(captain, { pending: true })).find((app) => app.id === id))
      .toMatchObject({ pendingVersion: { id: retry.versionId } });
  });

  it('downlists the app and withdraws pending releases while preserving previews and the active build', async () => {
    const id = `suspend-${randomUUID()}`;
    const initial = await service.uploadBundle(author, bundle(id, '1.0.0', 'Published build'), {
      channel: 'release',
    });
    const activeId = initial.pendingVersion!.id;
    await service.reviewVersion(captain, id, activeId, 'approve');
    const release = await service.uploadBundle(author, bundle(id, '1.1.0', 'Pending release'), {
      channel: 'release',
    });
    const releaseId = release.pendingVersion!.id;
    await service.uploadBundle(author, bundle(id, '1.2.0', 'Pending preview'), {
      channel: 'preview',
    });

    expect(await responseStatus(service.updateStatus(visitor, id, { status: 'suspended' }))).toBe(403);
    await service.updateStatus(author, id, { status: 'suspended' });
    expect(await db.getRepository(MiniAppEntity).findOneByOrFail({ id })).toMatchObject({
      status: 'suspended', activeVersionId: activeId,
    });
    const versions = db.getRepository(MiniAppVersionEntity);
    expect(await versions.findOneByOrFail({ appId: id, version: '1.1.0' }))
      .toMatchObject({ channel: 'release', status: 'withdrawn' });
    expect(await versions.findOneByOrFail({ appId: id, version: '1.2.0' }))
      .toMatchObject({ channel: 'preview', status: 'pending' });
    expect(await responseStatus(service.reviewVersion(captain, id, releaseId, 'approve'))).toBe(409);
    expect((await service.list(visitor, {})).some((app) => app.id === id)).toBe(false);
    expect((await service.list(captain, { pending: true })).some((app) => app.id === id)).toBe(false);
    expect((await service.list(author, { mine: true })).find((app) => app.id === id)).toMatchObject({
      status: 'suspended', pendingVersion: null, recoveryVersion: { id: releaseId },
    });
  });

  it('lets the author remove a preview from both catalogs and reuse the same ID', async () => {
    const id = `delete-preview-${randomUUID()}`;
    const uploaded = await service.uploadBundle(author, bundle(id, '1.0.0', 'Private playtest'), {
      channel: 'preview',
    });
    expect((await service.list(author, { mine: true })).find((app) => app.id === id))
      .toMatchObject({ canDeleteGame: true });
    expect(await responseStatus(service.deleteGame(visitor, id))).toBe(403);
    expect(await responseStatus(service.deleteGame(captain, id))).toBe(403);
    await service.deleteGame(author, id);
    await service.deleteGame(author, id);
    expect((await service.list(author, { mine: true })).some((app) => app.id === id)).toBe(false);
    expect((await service.list(captain, {})).some((app) => app.id === id)).toBe(false);
    expect(await responseStatus(service.getDetail(author, id))).toBe(404);
    expect(await db.getRepository(MiniAppVersionEntity).findOneBy({ id: uploaded.latestVersion!.id })).not.toBeNull();
    expect(await responseStatus(service.uploadBundle(captain, bundle(id, '1.1.0', 'Taken ID'), {
      channel: 'release', directPublish: 'true',
    }))).toBe(403);
    const restored = await service.uploadBundle(author, bundle(id, '1.1.0', 'Back to playtest'), {
      channel: 'preview',
    });
    expect(restored).toMatchObject({ id, ownerId: author.userId, status: 'draft' });
    expect((await service.list(author, { mine: true })).find((app) => app.id === id))
      .toMatchObject({ canDeleteGame: true });
  });

  it('requires first withdrawing formal reviews or downlisting published games and preserves saves', async () => {
    const id = `delete-published-${randomUUID()}`;
    const initial = await service.uploadBundle(author, bundle(id, '1.0.0', 'First release'), {
      channel: 'release',
    });
    const activeId = initial.pendingVersion!.id;
    expect(await responseStatus(service.deleteGame(author, id))).toBe(409);
    await service.reviewVersion(captain, id, activeId, 'approve');
    expect(await responseStatus(service.deleteGame(author, id))).toBe(409);
    await service.updateStatus(author, id, { status: 'suspended' });
    const retry = await service.resubmitVersion(author, id, activeId);
    expect(await responseStatus(service.deleteGame(author, id))).toBe(409);
    await service.withdrawVersion(author, id, retry.versionId);
    const saves = db.getRepository(MiniAppKvEntity);
    await saves.insert({ appId: id, userId: author.userId, key: 'score', valueJson: 42, updatedAt: new Date() });

    await service.deleteGame(author, id);

    expect(await db.getRepository(MiniAppEntity).findOneByOrFail({ id }))
      .toMatchObject({ status: 'deleted', activeVersionId: activeId });
    expect((await service.list(captain, {})).some((app) => app.id === id)).toBe(false);
    expect(await responseStatus(service.resubmitVersion(author, id, activeId))).toBe(404);
    expect(await responseStatus(service.updateStatus(captain, id, { status: 'published' }))).toBe(404);
    expect(await saves.findOneByOrFail({ appId: id, userId: author.userId, key: 'score' }))
      .toMatchObject({ valueJson: 42 });
  });

  it('returns one 409 when approval and withdrawal race for the same release', async () => {
    const id = `race-${randomUUID()}`;
    const initial = await service.uploadBundle(author, bundle(id, '1.0.0', 'Initial build'), {
      channel: 'release',
    });
    const activeId = initial.pendingVersion!.id;
    await service.reviewVersion(captain, id, activeId, 'approve');
    await service.updateStatus(author, id, { status: 'suspended' });
    expect((await service.list(author, { mine: true })).find((app) => app.id === id))
      .toMatchObject({ recoveryVersion: { id: activeId } });
    const submitted = await service.resubmitVersion(author, id, activeId);
    await service.updateStatus(author, id, { status: 'suspended' });
    const [withdraw, approve] = await Promise.all([
      responseStatus(service.withdrawVersion(author, id, submitted.versionId)),
      responseStatus(service.reviewVersion(captain, id, submitted.versionId, 'approve')),
    ]);
    expect([withdraw, approve].sort((a, b) => a - b)).toEqual([200, 409]);
    const app = await db.getRepository(MiniAppEntity).findOneByOrFail({ id });
    const version = await db.getRepository(MiniAppVersionEntity).findOneByOrFail({ id: submitted.versionId });
    if (approve === 200) {
      expect(version.status).toBe('approved');
      expect(app).toMatchObject({ status: 'published', activeVersionId: version.id });
    } else {
      expect(version.status).toBe('withdrawn');
      expect(app).toMatchObject({ status: 'suspended', activeVersionId: activeId });
    }
  });

  it('publishes replacement metadata only on approval and supersedes older pending releases', async () => {
    const id = `replace-${randomUUID()}`;
    const initial = await service.uploadBundle(author, bundle(id, '1.0.0', 'Public title'), {
      channel: 'release',
    });
    const activeId = initial.pendingVersion!.id;
    await service.reviewVersion(captain, id, activeId, 'approve');
    const publicCard = (await service.list(visitor, {})).find((app) => app.id === id)!;
    const stale = await service.uploadBundle(author, bundle(id, '1.1.0', 'Older candidate'), {
      targetAppId: id,
    });
    const newest = await service.uploadBundle(author, bundle(id, '1.2.0', 'New title'), {
      channel: 'release',
    });
    const staleId = stale.pendingVersion!.id;
    const newestId = newest.pendingVersion!.id;
    const previous = {
      name: 'Public title', description: 'Public title', iconUrl: publicCard.iconUrl,
      tags: ['1.0.0'], activeVersion: { id: activeId }, pendingVersion: null,
    };
    expect((await service.list(visitor, {})).find((app) => app.id === id)).toMatchObject(previous);
    expect(await service.getDetail(visitor, id)).toMatchObject(previous);
    expect(await service.getDetail(captain, id)).toMatchObject({ pendingVersion: { id: newestId } });

    await service.reviewVersion(captain, id, newestId, 'approve');
    expect(await responseStatus(service.reviewVersion(captain, id, staleId, 'approve'))).toBe(409);
    const versions = db.getRepository(MiniAppVersionEntity);
    expect(await versions.findOneByOrFail({ id: staleId })).toMatchObject({ status: 'superseded' });
    const legacyId = randomUUID();
    await versions.insert({
      id: legacyId, appId: id, version: '0.9.0', channel: 'release', status: 'pending',
      bundleUrl: 'https://bundles.example.test/older-release.zip', bundleSha256: 'b'.repeat(64),
      uploaderId: author.userId, createdAt: new Date(0),
    });
    expect(await responseStatus(service.reviewVersion(captain, id, legacyId, 'approve'))).toBe(409);
    expect((await service.list(captain, { pending: true })).some((app) => app.id === id)).toBe(false);
    const published = (await service.list(visitor, {})).find((app) => app.id === id);
    expect(published).toMatchObject({
      name: 'New title', description: 'New title', tags: ['1.2.0'],
      activeVersion: { id: newestId }, pendingVersion: null,
    });
    expect(published!.iconUrl).toBeTruthy();
    expect(published!.iconUrl).not.toBe(publicCard.iconUrl);

    await db.getRepository(MiniAppEntity).update(id, {
      name: 'Legacy candidate title', description: 'Legacy candidate description',
      type: 'miniapp', engine: 'unity',
    });
    expect((await service.list(visitor, { q: 'New title', type: 'minigame', engine: 'web' }))
      .some((app) => app.id === id)).toBe(true);
    expect((await service.list(visitor, { q: 'New title', type: 'minigame', engine: 'unity' }))
      .some((app) => app.id === id)).toBe(false);
    expect((await service.list(visitor, { q: 'Legacy candidate' })).some((app) => app.id === id))
      .toBe(false);
  });

  it('supersedes an older pending release when a captain publishes directly', async () => {
    const id = `direct-${randomUUID()}`;
    const initial = await service.uploadBundle(captain, bundle(id, '1.0.0', 'In review'), {
      channel: 'release',
    });
    const pendingId = initial.pendingVersion!.id;
    const published = await service.uploadBundle(captain, bundle(id, '1.1.0', 'Direct release'), {
      channel: 'release', directPublish: 'true',
    });
    expect(published).toMatchObject({
      name: 'Direct release', status: 'published', pendingVersion: null,
      activeVersion: { status: 'approved', version: '1.1.0' },
    });
    expect(await db.getRepository(MiniAppVersionEntity).findOneByOrFail({ id: pendingId }))
      .toMatchObject({ status: 'superseded' });
    expect(await responseStatus(service.reviewVersion(captain, id, pendingId, 'approve'))).toBe(409);
  });

  it('requires a contextual replacement bundle to retain the current app ID', async () => {
    const id = `target-${randomUUID()}`;
    const unrelatedId = `wrong-${randomUUID()}`;
    const initial = await service.uploadBundle(author, bundle(id, '1.0.0', 'Initial build'), {
      channel: 'release',
    });
    await service.reviewVersion(captain, id, initial.pendingVersion!.id, 'approve');
    expect(await responseStatus(service.uploadBundle(author, bundle(unrelatedId, '1.1.0', 'Wrong'), {
      targetAppId: id,
    }))).toBe(400);
    expect(await db.getRepository(MiniAppEntity).findOneBy({ id: unrelatedId })).toBeNull();
  });
});
