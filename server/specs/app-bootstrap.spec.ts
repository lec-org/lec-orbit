import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import { OrbitHttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { HealthController } from '../src/modules/health/health.controller.js';
import { EconomyS2SController } from '../src/modules/economy/economy-s2s.controller.js';
import { EconomyGatewayService } from '../src/modules/economy/economy-gateway.service.js';

describe('NestJS 12 (@nestjs/platform-node) HTTP 与 rawBody 冒烟测试', () => {
  let app: INestApplication;
  let baseUrl = '';
  let capturedRawBody: Buffer | undefined;

  @Module({
    controllers: [HealthController, EconomyS2SController],
    providers: [
      {
        provide: EconomyGatewayService,
        useValue: {
          settleWagerS2S: async (params: { rawBody: Buffer; orderId: string }) => {
            capturedRawBody = params.rawBody;
            return { orderId: params.orderId, status: 'settled' };
          },
        },
      },
    ],
  })
  class SmokeModule {}

  beforeAll(async () => {
    app = await NestFactory.create(SmokeModule, new NodeAdapter(), {
      rawBody: true,
      logger: ['error'],
    });
    app.useGlobalFilters(new OrbitHttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /healthz 返回 200 与服务状态', async () => {
    const resp = await fetch(`${baseUrl}/healthz`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('lec-orbit-server');
  });

  it('S2S 回调能精确捕获原始 rawBody 字节并校验非法 UUID 返回 400 { error, message }', async () => {
    const badResp = await fetch(`${baseUrl}/api/miniapps/economy/orders/not-a-uuid/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: 'm1', result: 'draw' }),
    });
    expect(badResp.status).toBe(400);
    const badJson = (await badResp.json()) as { error: string; message: string };
    expect(badJson.error).toContain('无效的订单 ID');
    expect(badJson.message).toContain('无效的订单 ID');

    const rawStr = '{"matchId":"m1",  "result":"draw"}';
    const okResp = await fetch(
      `${baseUrl}/api/miniapps/economy/orders/11111111-1111-4111-8111-111111111111/settle`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orbit-App-Id': 'lec-xiangqi',
          'X-Orbit-Timestamp': String(Date.now()),
          'X-Orbit-Nonce': 'nonce-smoke-001',
          'X-Orbit-Signature': 'sha256=' + '0'.repeat(64),
        },
        body: rawStr,
      },
    );
    expect(okResp.status).toBe(200);
    expect(capturedRawBody?.toString('utf8')).toBe(rawStr);
  });

  it('OrbitHttpExceptionFilter 透出 BadRequestException 中文消息而非覆盖为 Bad Request', async () => {
    const { BadRequestException, UnauthorizedException } = await import('@nestjs/common');
    const filter = new OrbitHttpExceptionFilter();
    const capture = (exc: unknown) => {
      let statusCode = 0;
      let payload: unknown = null;
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({
            status: (code: number) => {
              statusCode = code;
              return {
                json: (body: unknown) => {
                  payload = body;
                },
              };
            },
          }),
        }),
      };
      filter.catch(exc, host as never);
      return { statusCode, payload: payload as { error: string; message: string } };
    };

    const bad = capture(new BadRequestException('可用乐币不足，需要 6 乐币（当前可用 0 乐币）'));
    expect(bad.statusCode).toBe(400);
    expect(bad.payload).toEqual({
      error: '可用乐币不足，需要 6 乐币（当前可用 0 乐币）',
      message: '可用乐币不足，需要 6 乐币（当前可用 0 乐币）',
    });

    const unauth = capture(new UnauthorizedException('缺少认证令牌'));
    expect(unauth.statusCode).toBe(401);
    expect(unauth.payload).toEqual({
      error: '缺少认证令牌',
      message: '缺少认证令牌',
    });
  });
});
