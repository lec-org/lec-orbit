/**
 * LecPunch 统一认证与管理员守卫：
 * - 复用 Orbit 的 AuthService（LecSSO JWKS + Opaque userinfo）；
 * - 将 ssoSub (logtoUserId) 自动映射为 punch_users 中的成员记录，并在首次登录时自动绑定或建档到默认团队；
 * - 同步携带 ssoSub，使考勤签退/卡牌抽卡与 EconomyModule(coin) 实现进程内零延迟互通。
 */
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { PunchTeamEntity, PunchUserEntity } from './entities/punch-core.entities.js';
import { newObjectIdHex } from './punch-shared.util.js';

export const PUNCH_AUTH_USER_KEY = 'punchAuthUser';
export const PUNCH_ADMIN_ONLY_KEY = 'punchAdminOnly';

export interface PunchAuthUser {
  userId: string; // punch_users.id（兼容原 Mongo ObjectId）
  ssoSub: string; // LecSSO sub（与 Orbit / EconomyAccount userId 一致）
  teamId: string;
  username: string;
  displayName: string;
  role: 'member' | 'admin';
  enrollYear: number;
  avatarUrl?: string;
}

export const PunchCurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PunchAuthUser => {
    const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    return req[PUNCH_AUTH_USER_KEY] as PunchAuthUser;
  },
);

export const PunchAdminOnly = () => SetMetadata(PUNCH_ADMIN_ONLY_KEY, true);

@Injectable()
export class PunchAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @InjectRepository(PunchTeamEntity)
    private readonly teamRepo: Repository<PunchTeamEntity>,
    private readonly economyLedger: EconomyLedgerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      query?: Record<string, string | string[] | undefined>;
      url?: string;
      [PUNCH_AUTH_USER_KEY]?: unknown;
    }>();

    const rawAuth = req.headers?.authorization ?? req.headers?.Authorization;
    const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    let token =
      authHeader && authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
    if (!token && typeof req.query?.token === 'string') {
      token = req.query.token.trim();
    }
    if (!token && req.url) {
      try {
        token = new URL(req.url, 'http://localhost').searchParams.get('token')?.trim() ?? '';
      } catch {
        // 忽略
      }
    }

    const ssoUser = await this.authService.verifyToken(token);
    if (!ssoUser.isStudio && !ssoUser.isCaptain) {
      throw new ForbiddenException('仅限工作室正式成员访问');
    }

    const member = await this.resolveOrProvisionMember(ssoUser);
    if (member.status === 'disabled') {
      throw new ForbiddenException('当前账号已被禁用');
    }

    // 兜底合并历史迁移时暂存在 punch_users.id 下的期初乐币账户到当前 ssoSub
    await this.economyLedger.mergeLegacyAccountIfNeeded(member.id, ssoUser.userId);

    const effectiveRole: 'member' | 'admin' =
      ssoUser.isCaptain || member.role === 'admin' ? 'admin' : 'member';

    const punchUser: PunchAuthUser = {
      userId: member.id,
      ssoSub: ssoUser.userId,
      teamId: member.teamId,
      username: member.username,
      displayName: member.displayName,
      role: effectiveRole,
      enrollYear: member.enrollYear,
      avatarUrl: member.avatarUrl ?? (ssoUser.avatar || undefined),
    };

    const adminOnly = this.reflector.getAllAndOverride<boolean>(PUNCH_ADMIN_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (adminOnly && punchUser.role !== 'admin') {
      throw new ForbiddenException('仅管理员/队长可执行该操作');
    }

    req[PUNCH_AUTH_USER_KEY] = punchUser;
    return true;
  }

  private async resolveOrProvisionMember(ssoUser: {
    userId: string;
    username: string;
    displayName: string;
    avatar: string;
    isCaptain: boolean;
  }): Promise<PunchUserEntity> {
    let user = await this.userRepo.findOne({ where: { logtoUserId: ssoUser.userId } });
    if (user) {
      let dirty = false;
      if (ssoUser.avatar && user.avatarUrl !== ssoUser.avatar) {
        user.avatarUrl = ssoUser.avatar;
        dirty = true;
      }
      if (ssoUser.isCaptain && user.role !== 'admin') {
        user.role = 'admin';
        dirty = true;
      }
      if (dirty) {
        user.updatedAt = new Date();
        await this.userRepo.save(user);
      }
      return user;
    }

    // 按 username 兜底绑定历史迁移成员
    if (ssoUser.username) {
      user = await this.userRepo.findOne({ where: { username: ssoUser.username } });
      if (user && !user.logtoUserId) {
        user.logtoUserId = ssoUser.userId;
        if (ssoUser.avatar) user.avatarUrl = ssoUser.avatar;
        if (ssoUser.isCaptain) user.role = 'admin';
        user.updatedAt = new Date();
        await this.userRepo.save(user);
        return user;
      }
    }

    // 首次登录自动建档到默认 active 团队
    let team = await this.teamRepo.findOne({ where: { status: 'active' } });
    const now = new Date();
    if (!team) {
      team = this.teamRepo.create({
        id: newObjectIdHex(),
        name: 'LEC 乐程工作室',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await this.teamRepo.save(team);
    }

    const currentYear = new Date().getUTCFullYear();
    const created = this.userRepo.create({
      id: newObjectIdHex(),
      logtoUserId: ssoUser.userId,
      username: ssoUser.username || `member_${ssoUser.userId.slice(0, 8)}`,
      passwordHash: null,
      displayName: ssoUser.displayName || ssoUser.username || '工作室成员',
      teamId: team.id,
      role: ssoUser.isCaptain ? 'admin' : 'member',
      status: 'active',
      enrollYear: currentYear,
      studentId: null,
      realName: ssoUser.displayName || null,
      avatarUrl: ssoUser.avatar || null,
      adminMessageBadgeEnabled: true,
      avatarBase64: null,
      avatarColor: null,
      avatarEmoji: null,
      equippedTitleId: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.userRepo.save(created);
    return created;
  }
}
