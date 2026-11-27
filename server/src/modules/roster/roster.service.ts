/**
 * 工作室成员花名册服务（等价迁移原 Go internal/roster/roster.go）：
 * - 登录活跃自动 Upsert；
 * - 若配置了 LecSSO M2M 凭证，启动时及每 10 分钟定时同步全量 lec-studio 组织成员。
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { isCaptainRole } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import {
  OrbitMemberEntity,
  type OrbitMemberSocialSnapshot,
} from './entities/orbit-member.entity.js';

export interface MemberDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  isCaptain: boolean;
  enrollYear: number | null;
  roles: string[];
  social: {
    github: OrbitMemberSocialSnapshot['github'];
    feishu: OrbitMemberSocialSnapshot['feishu'];
  };
}

interface LogtoOrgUser {
  id?: string;
  username?: string;
  name?: string;
  avatar?: string;
  isSuspended?: boolean;
  customData?: Record<string, unknown>;
  identities?: Record<string, { userId?: string; details?: Record<string, unknown> }>;
  organizationRoles?: Array<{ name?: string }>;
}

/** 从 Logto customData 提取脱敏入学年份（仅保留 4 位整数年份，不落库也不下发学号原值）。 */
function extractEnrollYear(customData?: Record<string, unknown>): number | null {
  if (!customData || typeof customData !== 'object') return null;
  const direct = customData.enrollYear ?? customData.enroll_year;
  if (typeof direct === 'number' && direct >= 2015 && direct <= 2099) {
    return Math.floor(direct);
  }
  const rawStudentNo = String(
    customData.studentNumber ?? customData.student_number ?? customData.studentId ?? '',
  ).trim();
  const match = rawStudentNo.match(/^(20\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 2015 && year <= 2099 ? year : null;
}

/** 从 Logto identities 提炼脱敏公开社交名片（GitHub 与飞书，不包含邮箱/手机号）。 */
function extractPublicSocial(
  identities?: Record<string, { userId?: string; details?: Record<string, unknown> }>,
): OrbitMemberSocialSnapshot {
  if (!identities || typeof identities !== 'object') {
    return { github: null, feishu: null };
  }
  const ghDetails = identities.github?.details;
  const ghRaw =
    ghDetails?.rawData && typeof ghDetails.rawData === 'object'
      ? (ghDetails.rawData as Record<string, unknown>)
      : null;
  const ghUserInfo =
    ghRaw?.userInfo && typeof ghRaw.userInfo === 'object'
      ? (ghRaw.userInfo as Record<string, unknown>)
      : ghRaw;
  const ghLogin =
    typeof ghUserInfo?.login === 'string' && ghUserInfo.login.trim()
      ? ghUserInfo.login.trim()
      : null;
  const ghName =
    (typeof ghDetails?.name === 'string' && ghDetails.name.trim()) ||
    (typeof ghUserInfo?.name === 'string' && ghUserInfo.name.trim()) ||
    null;
  const ghAvatar =
    (typeof ghDetails?.avatar === 'string' && ghDetails.avatar.trim()) ||
    (typeof ghUserInfo?.avatar_url === 'string' && ghUserInfo.avatar_url.trim()) ||
    null;
  const ghProfileUrl =
    (typeof ghUserInfo?.html_url === 'string' && ghUserInfo.html_url.trim()) ||
    (ghLogin ? `https://github.com/${encodeURIComponent(ghLogin)}` : null);

  const github = identities.github
    ? { username: ghLogin, name: ghName, avatar: ghAvatar, profileUrl: ghProfileUrl }
    : null;

  const fsDetails = identities.feishu?.details;
  const fsRaw =
    fsDetails?.rawData && typeof fsDetails.rawData === 'object'
      ? (fsDetails.rawData as Record<string, unknown>)
      : null;
  const feishu = identities.feishu
    ? {
        name:
          (typeof fsDetails?.name === 'string' && fsDetails.name.trim()) ||
          (typeof fsRaw?.name === 'string' && fsRaw.name.trim()) ||
          null,
        enName:
          typeof fsRaw?.en_name === 'string' && fsRaw.en_name.trim()
            ? fsRaw.en_name.trim()
            : null,
        avatar:
          (typeof fsDetails?.avatar === 'string' && fsDetails.avatar.trim()) ||
          (typeof fsRaw?.avatar_url === 'string' && fsRaw.avatar_url.trim()) ||
          (typeof fsRaw?.picture === 'string' && fsRaw.picture.trim()) ||
          null,
        linked: true,
      }
    : null;

  return { github, feishu };
}

@Injectable()
export class RosterService implements OnModuleInit {
  private readonly logger = new Logger(RosterService.name);
  private m2mToken = '';
  private m2mExpiresAt = 0;

  constructor(
    @InjectRepository(OrbitMemberEntity)
    private readonly memberRepo: Repository<OrbitMemberEntity>,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.ssoM2mClientId || !this.cfg.ssoM2mClientSecret) {
      this.logger.log('LEC_SSO_M2M_CLIENT_ID 未配置，成员列表将按登录活跃自动同步');
      return;
    }
    void this.syncFromLecSso().catch((err: unknown) => {
      this.logger.warn(
        `首次同步 LecSSO 成员失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  @Cron('*/10 * * * *')
  async handlePeriodicSync(): Promise<void> {
    if (!this.cfg.ssoM2mClientId || !this.cfg.ssoM2mClientSecret) return;
    try {
      await this.syncFromLecSso();
    } catch (err) {
      this.logger.warn(
        `定时同步 LecSSO 成员失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async upsertFromAuth(user: AuthUser): Promise<void> {
    if (!user.userId) return;
    const display = user.displayName || user.username || '';
    const now = new Date();
    await this.memberRepo.query(
      `INSERT INTO orbit_members (user_id, username, display_name, avatar, is_captain, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE orbit_members.username END,
         display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE orbit_members.display_name END,
         avatar = CASE WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE orbit_members.avatar END,
         is_captain = EXCLUDED.is_captain,
         is_active = TRUE,
         updated_at = EXCLUDED.updated_at`,
      [user.userId, user.username, display, user.avatar, user.isCaptain, now],
    );
  }

  async listActive(): Promise<MemberDTO[]> {
    const rows = (await this.memberRepo.query(`
      SELECT
        m.user_id,
        m.username,
        m.display_name,
        m.avatar,
        m.is_captain,
        COALESCE(m.enroll_year, p.enroll_year) AS enroll_year,
        m.roles_json,
        m.social_json
      FROM orbit_members m
      LEFT JOIN LATERAL (
        SELECT pu.enroll_year
        FROM punch_users pu
        WHERE pu.logto_user_id = m.user_id
           OR (m.username <> '' AND lower(pu.username) = lower(m.username))
           OR (m.display_name <> '' AND pu.real_name = m.display_name)
        ORDER BY (pu.logto_user_id = m.user_id) DESC
        LIMIT 1
      ) p ON TRUE
      WHERE m.is_active = TRUE
      ORDER BY m.is_captain DESC, COALESCE(m.enroll_year, p.enroll_year) DESC NULLS LAST, m.display_name ASC, m.username ASC
    `)) as Array<{
      user_id: string;
      username: string;
      display_name: string;
      avatar: string;
      is_captain: boolean;
      enroll_year: number | null;
      roles_json: string[] | null;
      social_json: OrbitMemberSocialSnapshot | null;
    }>;

    return rows.map((r) => {
      const roles =
        Array.isArray(r.roles_json) && r.roles_json.length > 0
          ? r.roles_json
          : r.is_captain
            ? ['captain']
            : ['member'];
      const social = r.social_json ?? {};
      return {
        userId: r.user_id,
        username: r.username ?? '',
        displayName: r.display_name ?? '',
        avatar: r.avatar ?? '',
        isCaptain: Boolean(r.is_captain),
        enrollYear: typeof r.enroll_year === 'number' ? r.enroll_year : null,
        roles,
        social: {
          github: social.github ?? null,
          feishu: social.feishu ?? null,
        },
      };
    });
  }

  async countActive(): Promise<number> {
    const cnt = await this.memberRepo.count({ where: { isActive: true } });
    return Math.max(1, cnt);
  }

  async listActiveCaptains(): Promise<OrbitMemberEntity[]> {
    return this.memberRepo.find({ where: { isActive: true, isCaptain: true } });
  }

  private async fetchM2mToken(): Promise<string> {
    const now = Date.now();
    if (this.m2mToken && now < this.m2mExpiresAt) {
      return this.m2mToken;
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      resource: this.cfg.ssoM2mResource,
      scope: 'all',
    });
    const basic = Buffer.from(
      `${this.cfg.ssoM2mClientId}:${this.cfg.ssoM2mClientSecret}`,
      'utf8',
    ).toString('base64');

    const resp = await fetch(`${this.cfg.ssoEndpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 512);
      throw new Error(`换取 LecSSO M2M Token 失败（HTTP ${resp.status}）: ${body}`);
    }
    const res = (await resp.json()) as { access_token?: string; expires_in?: number };
    this.m2mToken = res.access_token ?? '';
    const ttlSec = Math.max(60, (res.expires_in ?? 300) - 60);
    this.m2mExpiresAt = now + ttlSec * 1000;
    return this.m2mToken;
  }

  async syncFromLecSso(): Promise<number> {
    const token = await this.fetchM2mToken();
    const pageSize = 100;
    const users: LogtoOrgUser[] = [];

    for (let page = 1; page <= 20; page += 1) {
      const url =
        `${this.cfg.ssoEndpoint}/api/organizations/${encodeURIComponent(this.cfg.ssoOrgId)}/users` +
        `?page=${page}&page_size=${pageSize}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!resp.ok) {
        const body = (await resp.text().catch(() => '')).slice(0, 512);
        throw new Error(`拉取 LecSSO 组织成员失败（HTTP ${resp.status}）: ${body}`);
      }
      const batch = (await resp.json()) as LogtoOrgUser[];
      if (!Array.isArray(batch)) break;
      users.push(...batch);
      if (batch.length < pageSize) break;
    }

    const activeIds: string[] = [];
    const now = new Date();
    for (const u of users) {
      if (!u.id || u.isSuspended) continue;
      const roleNames = (u.organizationRoles ?? [])
        .map((r) => r.name ?? '')
        .filter((n) => n.length > 0);
      const display = u.name || u.username || '';
      const enrollYear = extractEnrollYear(u.customData);
      const social = extractPublicSocial(u.identities);
      await this.memberRepo.query(
        `INSERT INTO orbit_members (user_id, username, display_name, avatar, is_captain, enroll_year, roles_json, social_json, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, TRUE, $9)
         ON CONFLICT (user_id) DO UPDATE SET
           username = EXCLUDED.username,
           display_name = EXCLUDED.display_name,
           avatar = EXCLUDED.avatar,
           is_captain = EXCLUDED.is_captain,
           enroll_year = COALESCE(EXCLUDED.enroll_year, orbit_members.enroll_year),
           roles_json = EXCLUDED.roles_json,
           social_json = EXCLUDED.social_json,
           is_active = TRUE,
           updated_at = EXCLUDED.updated_at`,
        [
          u.id,
          u.username ?? '',
          display,
          u.avatar ?? '',
          isCaptainRole(roleNames, this.cfg.ssoOrgId),
          enrollYear,
          JSON.stringify(roleNames),
          JSON.stringify(social),
          now,
        ],
      );
      if (enrollYear !== null) {
        await this.memberRepo.query(
          `UPDATE punch_users SET enroll_year = $1, updated_at = $2
           WHERE logto_user_id = $3 AND enroll_year <> $1`,
          [enrollYear, now, u.id],
        );
      }
      activeIds.push(u.id);
    }

    if (activeIds.length > 0) {
      await this.memberRepo.query(
        `UPDATE orbit_members SET is_active = FALSE WHERE NOT (user_id = ANY($1))`,
        [activeIds],
      );
    }
    this.logger.log(`已从 LecSSO 同步 ${activeIds.length} 名在岗成员`);
    return activeIds.length;
  }
}
