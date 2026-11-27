import { describe, expect, it } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import {
  FnRateLimiter,
  FnRingLogger,
  scanFunctionSourceSafety,
  signFnContextToken,
  verifyFnContextToken,
} from '../src/modules/functions/functions-context.util.js';
import { FunctionsService } from '../src/modules/functions/functions.service.js';
import { validateZipBundle } from '../src/modules/miniapps/miniapp-validator.util.js';
import { loadAppConfig } from '../src/config/env.config.js';
import type { AuthUser } from '../src/modules/auth/auth.types.js';

function createMockFunctionsService(appStatus = 'published') {
  const sentEvents: Array<{ userId: string; event: unknown }> = [];
  const hubMock = {
    pushToUser: async (userId: string, event: unknown) => {
      sentEvents.push({ userId, event });
    },
  };
  const economyMock = {
    getWagerInternal: async (orderId: string) => ({
      orderId,
      appId: 'other-app',
      status: 'locked',
      asset: 'coin',
      amount: 10,
      matchId: 'm1',
      title: '测试对局',
      creatorUserId: 'u1',
      opponentUserId: 'u2',
    }),
    settleWagerInternal: async () => ({ ok: true }),
  };

  const cfg = loadAppConfig({
    ORBIT_INTERNAL_TOKEN: 'test-internal-secret-token-123456',
    EDGE_RUNTIME_URL: 'http://127.0.0.1:9000',
  });

  const service = new FunctionsService(
    {} as never,
    cfg,
    { findOne: async () => ({ id: 'test-app', ownerId: 'test-author', status: appStatus }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    economyMock as never,
    hubMock as never,
  );
  return { service, sentEvents, cfg };
}

describe('Orbit FaaS（方案 E）核心安全与平台底座能力', () => {
  it('让作者和队长访问已删除游戏的云函数时返回 404', async () => {
    const { service } = createMockFunctionsService('deleted');
    const author = { userId: 'test-author', isCaptain: false } as AuthUser;
    const captain = { userId: 'captain', isCaptain: true } as AuthUser;
    const app = 'test-app';
    const version = '00000000-0000-4000-8000-000000000001';
    const calls = [
      service.getVersionFunctionsSource(author, app, version),
      service.invokeFunction(captain, app, 'test', null, { previewVersionId: version }),
      service.getInternalBundle(app, version),
      service.listSecrets(author, app),
      service.upsertSecret(author, app, 'TEST_VALUE', 'placeholder'),
      service.deleteSecret(author, app, 'TEST_VALUE'),
      service.getInvocationLogs(captain, app),
    ];
    const results = await Promise.allSettled(calls);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 404 });
    }
  });

  it('静态源码安全扫描拦截危险系统调用并放行合法业务代码', () => {
    const safeCode = `
      // 允许在注释里提到 Deno.Command 和 process.env
      /* eval('not-code') */
      export default async function (req, ctx) {
        const key = await ctx.secrets.get('DEEPSEEK_KEY');
        return { ok: true, user: ctx.user.displayName, hasKey: Boolean(key) };
      }
    `;
    expect(() => scanFunctionSourceSafety(safeCode, 'functions/chat.ts')).not.toThrow();

    const blockedSamples = [
      `const cmd = new Deno.Command('sh', { args: ['-c', 'id'] });`,
      `const txt = await Deno.readTextFile('/etc/passwd');`,
      `const secret = Deno.env.get('ORBIT_INTERNAL_TOKEN');`,
      `const secret2 = process.env.DATABASE_URL;`,
      `const fs = await import('node:fs');`,
      `eval('1+1')`,
      `new Function('return this')()`,
      `EdgeRuntime.userWorkers.create({})`,
    ];
    for (const sample of blockedSamples) {
      expect(() => scanFunctionSourceSafety(sample, 'functions/evil.ts')).toThrow('云函数安全扫描拦截');
    }
  });

  it('短期 HS256 上下文令牌支持签发、验签并拒绝篡改', () => {
    const secret = 'orbit-unit-test-secret';
    const token = signFnContextToken(
      secret,
      {
        appId: 'werewolf',
        versionId: '00000000-0000-0000-0000-000000000001',
        fnName: 'deal',
        requestId: 'req-1',
        userId: 'u-alice',
        displayName: 'Alice',
        isCaptain: false,
        scopes: ['cloud.functions', 'realtime.room'],
        allowedDomains: ['api.deepseek.com'],
      },
      15,
    );
    const claims = verifyFnContextToken(secret, token);
    expect(claims).not.toBeNull();
    expect(claims?.appId).toBe('werewolf');
    expect(claims?.userId).toBe('u-alice');

    // 篡改签名或密钥错误均验签失败
    expect(verifyFnContextToken('wrong-secret', token)).toBeNull();
    expect(verifyFnContextToken(secret, `${token}x`)).toBeNull();
  });

  it('环形日志缓冲与限流器按配置生效', () => {
    const ring = new FnRingLogger(3);
    for (let i = 1; i <= 5; i++) {
      ring.push('app-a', {
        requestId: `r${i}`,
        fnName: 'ping',
        userId: 'u1',
        status: 200,
        durationMs: i * 10,
        logs: [],
        createdAt: new Date().toISOString(),
      });
    }
    const items = ring.list('app-a', 10);
    expect(items.map((x) => x.requestId)).toEqual(['r5', 'r4', 'r3']);

    const limiter = new FnRateLimiter();
    expect(limiter.consume('k1', 2, 60_000).allowed).toBe(true);
    expect(limiter.consume('k1', 2, 60_000).allowed).toBe(true);
    const third = limiter.consume('k1', 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('ZIP 构建包提取云函数源码与 .wasm 产物，并拦截缺失权限、缺路由或危险源码', async () => {
    const validManifest = {
      schemaVersion: 1,
      id: 'lec-werewolf',
      name: '乐程狼人杀',
      version: '1.0.0',
      type: 'minigame',
      engine: 'web',
      entry: 'index.html',
      permissions: {
        scopes: ['user.profile', 'cloud.functions', 'realtime.room'],
        networkDomains: [],
      },
      functions: {
        dir: 'functions',
        timeoutMs: 5000,
        allowStreaming: false,
        routes: ['deal'],
      },
    };

    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const validZip = zipSync({
      'orbit.manifest.json': strToU8(JSON.stringify(validManifest)),
      'index.html': strToU8('<!doctype html><html></html>'),
      'functions/deal.ts': strToU8('export default async (req, ctx) => ({ ok: true });'),
      'functions/engine.wasm': wasmBytes,
    });

    const validated = await validateZipBundle(Buffer.from(validZip));
    expect(validated.functionBundle).toBeDefined();
    expect(validated.functionBundle?.routes).toEqual(['deal']);
    expect(validated.functionBundle?.files.length).toBe(2);
    const wasmFile = validated.functionBundle?.files.find((f) => f.path === 'engine.wasm');
    expect(wasmFile?.isBinary).toBe(true);
    expect(wasmFile?.sizeBytes).toBe(8);
    expect(validated.functionBundle?.sha256).toHaveLength(64);

    // 未声明 cloud.functions 权限必须拒绝
    const noScopeManifest = {
      ...validManifest,
      permissions: { scopes: ['user.profile'], networkDomains: [] },
    };
    const noScopeZip = zipSync({
      'orbit.manifest.json': strToU8(JSON.stringify(noScopeManifest)),
      'index.html': strToU8('<html></html>'),
      'functions/deal.ts': strToU8('export default () => ({ ok: true });'),
    });
    await expect(validateZipBundle(Buffer.from(noScopeZip))).rejects.toThrow('cloud.functions');

    // 缺少路由入口文件必须拒绝
    const missingRouteZip = zipSync({
      'orbit.manifest.json': strToU8(JSON.stringify(validManifest)),
      'index.html': strToU8('<html></html>'),
      'functions/other.ts': strToU8('export default () => ({ ok: true });'),
    });
    await expect(validateZipBundle(Buffer.from(missingRouteZip))).rejects.toThrow('缺少入口文件');

    // 危险代码必须拦截
    const evilZip = zipSync({
      'orbit.manifest.json': strToU8(JSON.stringify(validManifest)),
      'index.html': strToU8('<html></html>'),
      'functions/deal.ts': strToU8(`const p = new Deno.Command('cat', { args: ['/etc/passwd'] }); export default () => p;`),
    });
    await expect(validateZipBundle(Buffer.from(evilZip))).rejects.toThrow('云函数安全扫描拦截');

    // 不支持的扩展名必须拒绝
    const badExtZip = zipSync({
      'orbit.manifest.json': strToU8(JSON.stringify(validManifest)),
      'index.html': strToU8('<html></html>'),
      'functions/deal.ts': strToU8('export default () => ({ ok: true });'),
      'functions/run.sh': strToU8('#!/bin/sh\necho hi'),
    });
    await expect(validateZipBundle(Buffer.from(badExtZip))).rejects.toThrow('不支持的文件类型');
  });

  it('ctx.roomState 支持 CAS 乐观锁与房间广播推送，且 ctx.economy 严格拦截跨应用订单', async () => {
    const { service, sentEvents, cfg } = createMockFunctionsService();
    const alice: AuthUser = {
      userId: 'u-alice',
      username: 'alice',
      displayName: 'Alice',
      avatar: '',
      organizations: ['lec-studio'],
      roles: [],
      isStudio: true,
      isCaptain: false,
    };
    const bob: AuthUser = {
      userId: 'u-bob',
      username: 'bob',
      displayName: 'Bob',
      avatar: '',
      organizations: ['lec-studio'],
      roles: [],
      isStudio: true,
      isCaptain: false,
    };

    const token = signFnContextToken(
      cfg.internalServiceToken,
      {
        appId: 'werewolf',
        versionId: 'v1',
        fnName: 'deal',
        requestId: 'req-room',
        userId: 'u-alice',
        displayName: 'Alice',
        isCaptain: false,
        scopes: ['cloud.functions', 'realtime.room', 'economy.wager.coin'],
        allowedDomains: [],
      },
      30,
    );
    const claims = service.verifyBridgeToken(token);

    // 1. 房间状态写入、读取与 CAS 冲突检测
    const setRes = await service.bridgeRoomStateSet(claims, 'room-1', {
      value: { phase: 'night', turn: 1 },
      ttlSeconds: 300,
    });
    expect(setRes.version).toBe(1);

    const getRes = await service.bridgeRoomStateGet(claims, 'room-1');
    expect(getRes.version).toBe(1);
    expect((getRes.value as { phase: string }).phase).toBe('night');

    await expect(
      service.bridgeRoomStateSet(claims, 'room-1', {
        expectedVersion: 99,
        value: { phase: 'day', turn: 2 },
      }),
    ).rejects.toThrow('并发冲突');

    const casOk = await service.bridgeRoomStateSet(claims, 'room-1', {
      expectedVersion: 1,
      value: { phase: 'day', turn: 2 },
    });
    expect(casOk.ok).toBe(true);
    expect(casOk.version).toBe(2);

    // 2. 加入房间并测试点对点发暗牌 + 房间广播
    await service.joinRealtimeRoom(alice, 'werewolf', 'room-1');
    await service.joinRealtimeRoom(bob, 'werewolf', 'room-1');

    await service.bridgeRealtimeSendToUser(claims, {
      targetUserId: 'u-alice',
      event: 'role_assigned',
      payload: { role: 'seer' },
    });
    expect(sentEvents.length).toBe(1);
    expect(sentEvents[0]).toMatchObject({
      userId: 'u-alice',
      event: {
        type: 'miniapp.realtime',
        payload: { appId: 'werewolf', event: 'role_assigned', payload: { role: 'seer' } },
      },
    });

    const bcast = await service.bridgeRealtimeBroadcastRoom(claims, {
      roomId: 'room-1',
      event: 'phase_changed',
      payload: { phase: 'day' },
    });
    expect(bcast.delivered).toBe(2);
    expect(sentEvents.length).toBe(3);

    // 3. 跨应用赌约强隔离（order.appId='other-app' !== claims.appId='werewolf'）
    await expect(service.bridgeEconomyGetWager(claims, 'ord-999')).rejects.toThrow('禁止访问其他应用');
  });
});
