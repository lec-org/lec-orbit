/**
 * LecSSO 认证服务：
 * - JWT 令牌使用 jose 远程 JWKS 验签（自动缓存与轮换）；
 * - Opaque 令牌经 LecSSO /me userinfo 校验并缓存 60 秒；
 * - 与原 Go 版 internal/auth/jwks.go 保持完全一致的身份提取与队长角色判定规则。
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from './auth.types.js';

interface CachedOpaqueEntry {
  user: AuthUser;
  expiresAt: number;
}

/** 判定组织角色列表中是否包含队长/管理员角色。 */
export function isCaptainRole(roles: string[], orgId: string, allowAdmin = true): boolean {
  for (const raw of roles) {
    const value = raw.trim();
    const idx = value.lastIndexOf(':');
    if (idx >= 0 && value.slice(0, idx) !== orgId) continue;
    const part = value.slice(idx + 1).trim().toLowerCase();
    if (part === 'captain' || (allowAdmin && part === 'admin') || part === 'lec-captain') {
      return true;
    }
  }
  return false;
}

function extractStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

@Injectable()
export class AuthService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private readonly opaqueCache = new Map<string, CachedOpaqueEntry>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwks) {
      const jwksUrl = new URL(`${this.cfg.ssoIssuer}/jwks`);
      this.jwks = createRemoteJWKSet(jwksUrl);
    }
    return this.jwks;
  }

  /** 校验 Bearer Token（自动区分 JWT 与 Opaque Token）。 */
  async verifyToken(rawToken: string): Promise<AuthUser> {
    const token = rawToken.trim();
    if (!token) {
      throw new UnauthorizedException('缺少认证令牌');
    }
    if (token.split('.').length === 3) {
      return this.verifyJwt(token);
    }
    return this.verifyOpaqueViaUserinfo(token);
  }

  private async verifyJwt(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.getJwks(), {
        issuer: this.cfg.ssoIssuer,
      });
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      if (!sub) {
        throw new UnauthorizedException('JWT 缺少 sub');
      }
      const orgId = typeof payload.organization_id === 'string' ? payload.organization_id : '';
      const orgs = extractStringArray(payload.organizations);
      if (orgId && !orgs.includes(orgId)) {
        orgs.push(orgId);
      }
      const roles = extractStringArray(payload.organization_roles);
      const scopeStr = typeof payload.scope === 'string' ? payload.scope : '';
      const isCaptain =
        isCaptainRole(roles, this.cfg.ssoOrgId) || ` ${scopeStr} `.includes(' studio:admin:access ');

      const username = typeof payload.username === 'string' ? payload.username : '';
      const name = typeof payload.name === 'string' ? payload.name : '';
      const avatar = typeof payload.picture === 'string' ? payload.picture : '';

      return {
        userId: sub,
        username,
        displayName: name || username,
        avatar,
        organizations: orgs,
        roles,
        isStudio: orgId === this.cfg.ssoOrgId || orgs.includes(this.cfg.ssoOrgId),
        isCaptain,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('JWT 验签失败或已过期');
    }
  }

  private async verifyOpaqueViaUserinfo(token: string): Promise<AuthUser> {
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const cached = this.opaqueCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.user;
    }

    const resp = await fetch(`${this.cfg.ssoIssuer}/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    }).catch((err: unknown) => {
      throw new UnauthorizedException(
        `访问 LecSSO userinfo 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 512).trim();
      throw new UnauthorizedException(`LecSSO 令牌无效（HTTP ${resp.status}）: ${text}`);
    }

    const payload = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    const sub = typeof payload?.sub === 'string' ? payload.sub : '';
    if (!sub) {
      throw new UnauthorizedException('userinfo 缺少 sub');
    }

    const orgs = extractStringArray(payload?.organizations);
    const roles = extractStringArray(payload?.organization_roles);
    const username = typeof payload?.username === 'string' ? payload.username : '';
    const name = typeof payload?.name === 'string' ? payload.name : '';
    const avatar = typeof payload?.picture === 'string' ? payload.picture : '';

    const user: AuthUser = {
      userId: sub,
      username,
      displayName: name || username,
      avatar,
      organizations: orgs,
      roles,
      isStudio: orgs.includes(this.cfg.ssoOrgId),
      isCaptain: isCaptainRole(roles, this.cfg.ssoOrgId),
    };

    if (this.opaqueCache.size > 2000) {
      this.opaqueCache.clear();
    }
    this.opaqueCache.set(cacheKey, { user, expiresAt: now + 60_000 });
    return user;
  }
}
