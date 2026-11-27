import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-node';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireCaptain } from '../../common/decorators/require-captain.decorator.js';
import { CaptainGuard } from '../../common/guards/captain.guard.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MINIAPP_MAX_BUNDLE_BYTES, type MiniAppManifest } from './miniapp-validator.util.js';
import { MiniAppsEngagementService } from './miniapps-engagement.service.js';
import { MiniAppsService } from './miniapps.service.js';

const PresenceSchema = z.object({
  appName: z.string().trim().max(80).optional(),
  appType: z.string().trim().max(32).optional(),
});

const EndSessionSchema = z.object({
  durationSeconds: z.number().min(0).max(86400).optional(),
});

const RateAppSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(200).optional(),
});

const SendInviteSchema = z.object({
  toUserIds: z.array(z.string().trim().min(1)).min(1, '请至少选择一位队友').max(8, '单次最多邀请 8 位队友'),
  roomId: z.string().trim().min(1, '请提供房间号').max(128, '房间号最长 128 字符'),
  roomName: z.string().trim().max(64).optional(),
  message: z.string().trim().max(140).optional(),
  mode: z.enum(['sidepanel', 'workspace', 'standalone']).optional(),
  expiresInSeconds: z.number().int().min(60).max(3600).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  appNameHint: z.string().trim().max(80).optional(),
});

const UuidSchema = z.string().uuid('无效的版本 ID');

const ReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});

const StatusUpdateSchema = z.object({
  status: z.string().optional(),
  activeVersionId: z.string().uuid('无效的版本 ID').optional(),
});

const ImportGitHubSchema = z.object({
  targetAppId: z.string().optional(),
  bundleUrl: z.string().trim().min(1, '导入参数不完整'),
  bundleSha256: z.string().trim().min(1, '导入参数不完整'),
  bundleSize: z.number().int().min(0).optional(),
  iconUrl: z.string().optional(),
  channel: z.string().optional(),
  changelog: z.string().optional(),
  directPublish: z.boolean().optional(),
  manifest: z.record(z.string(), z.unknown()),
});

interface UploadedBinaryFile {
  buffer?: Buffer;
}

@Controller('api/v1/apps')
@UseGuards(SsoAuthGuard, CaptainGuard)
export class MiniAppsController {
  constructor(
    private readonly service: MiniAppsService,
    private readonly engagement: MiniAppsEngagementService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: string,
    @Query('engine') engine?: string,
    @Query('q') q?: string,
    @Query('mine') mine?: string,
    @Query('pending') pending?: string,
  ) {
    const items = await this.service.list(user, {
      type: type?.trim(),
      engine: engine?.trim(),
      q,
      mine: mine === '1' || mine === 'true',
      pending: pending === '1' || pending === 'true',
    });
    return { items };
  }

  /** 当前正在游玩工坊作品的在线成员动态列表（必须定义在 :id 路由之前）。 */
  @Get('presence')
  async listPresence() {
    const items = await this.engagement.listActivePresence();
    return { items };
  }

  /** 工坊游戏/应用排行榜（支持 composite 综合 / rating 高分 / plays 热门）。 */
  @Get('leaderboard')
  getLeaderboard(
    @CurrentUser() user: AuthUser,
    @Query('sort') sort?: string,
    @Query('type') type?: string,
  ) {
    return this.engagement.getLeaderboard(user, {
      sort: sort?.trim(),
      type: type?.trim(),
    });
  }

  @Get(':id')
  getDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getDetail(user, id.trim());
  }

  @Get(':id/stats')
  getStats(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.engagement.getAppStats(user, id.trim());
  }

  @Post(':id/presence')
  @HttpCode(HttpStatus.OK)
  reportPresence(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const body = PresenceSchema.parse(rawBody ?? {});
    return this.engagement.reportPresence(user, appId.trim(), body);
  }

  @Delete(':id/presence')
  @HttpCode(HttpStatus.OK)
  clearPresence(@CurrentUser() user: AuthUser, @Param('id') appId: string) {
    return this.engagement.clearPresence(user.userId, appId.trim());
  }

  @Post(':id/play-session/end')
  @HttpCode(HttpStatus.OK)
  endPlaySession(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const body = EndSessionSchema.parse(rawBody ?? {});
    return this.engagement.endPlaySession(user, appId.trim(), body.durationSeconds);
  }

  @Post(':id/rate')
  @HttpCode(HttpStatus.OK)
  submitRating(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const body = RateAppSchema.parse(rawBody ?? {});
    return this.engagement.submitRating(user, appId.trim(), body.score, body.comment);
  }

  /** 向指定工作室成员发送游戏组队房间邀请，对方点「接受并进房」后直接打开对应作品并进入房间。 */
  @Post(':id/invites')
  @HttpCode(HttpStatus.CREATED)
  sendRoomInvites(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const body = SendInviteSchema.parse(rawBody ?? {});
    return this.engagement.sendRoomInvites(user, appId.trim(), body);
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MINIAPP_MAX_BUNDLE_BYTES } }),
  )
  uploadBundle(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedBinaryFile | undefined,
    @Body() formBody: { targetAppId?: string; channel?: string; changelog?: string; directPublish?: string },
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('请上传构建包文件（字段名 file，格式 .zip/.lecapp）');
    }
    return this.service.uploadBundle(user, file.buffer, formBody ?? {});
  }

  @Post('import-github')
  @HttpCode(HttpStatus.CREATED)
  importGitHub(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const req = ImportGitHubSchema.parse(rawBody);
    return this.service.importFromGitHub(user, {
      ...req,
      manifest: req.manifest as unknown as Partial<MiniAppManifest>,
    });
  }

  @Post(':id/versions/:versionId/review')
  @RequireCaptain()
  @HttpCode(HttpStatus.OK)
  reviewVersion(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('versionId') versionId: string,
    @Body() rawBody: unknown,
  ) {
    const body = ReviewSchema.parse(rawBody);
    return this.service.reviewVersion(
      user,
      appId.trim(),
      UuidSchema.parse(versionId.trim()),
      body.decision,
      body.note,
    );
  }

  @Post(':id/versions/:versionId/withdraw')
  @HttpCode(HttpStatus.OK)
  withdrawVersion(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.service.withdrawVersion(user, appId.trim(), UuidSchema.parse(versionId.trim()));
  }

  @Post(':id/versions/:versionId/resubmit')
  @HttpCode(HttpStatus.CREATED)
  resubmitVersion(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.service.resubmitVersion(user, appId.trim(), UuidSchema.parse(versionId.trim()));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteGame(@CurrentUser() user: AuthUser, @Param('id') appId: string) {
    return this.service.deleteGame(user, appId.trim());
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const body = StatusUpdateSchema.parse(rawBody);
    return this.service.updateStatus(user, appId.trim(), body);
  }

  @Post(':id/play')
  @HttpCode(HttpStatus.OK)
  recordPlay(@Param('id') appId: string) {
    return this.service.recordPlay(appId.trim());
  }

  // ── 云存档 KV ──

  @Get(':id/kv')
  listKvKeys(@CurrentUser() user: AuthUser, @Param('id') appId: string) {
    return this.service.listKvKeys(user.userId, appId.trim());
  }

  @Get(':id/kv/:key')
  getKv(@CurrentUser() user: AuthUser, @Param('id') appId: string, @Param('key') key: string) {
    return this.service.getKv(user.userId, appId.trim(), key.trim());
  }

  @Put(':id/kv/:key')
  setKv(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('key') key: string,
    @Body() rawBody: { value?: unknown },
  ) {
    if (!rawBody || typeof rawBody !== 'object' || !('value' in rawBody)) {
      throw new BadRequestException('请提供合法的 JSON value');
    }
    return this.service.setKv(user.userId, appId.trim(), key.trim(), rawBody.value);
  }

  @Delete(':id/kv/:key')
  deleteKv(@CurrentUser() user: AuthUser, @Param('id') appId: string, @Param('key') key: string) {
    return this.service.deleteKv(user.userId, appId.trim(), key.trim());
  }
}
