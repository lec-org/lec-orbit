import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isCaptainRole } from '../auth/auth.service.js';

// Names must round-trip through the settings editor (one line per group, comma-separated members).
const name = z.string().trim().min(1).max(80).regex(/^[^、,，\r\n]+$/);
const schedule = z.object({ groups: z.array(z.array(name).min(1).max(100)).max(100), version: z.string().regex(/^\d{1,10}$/).nullable() });

@Controller('api/v1/duty-schedule')
@UseGuards(SsoAuthGuard)
export class DutyController {
  constructor(@InjectDataSource() private db: DataSource, @Inject(APP_CONFIG) private cfg: AppConfig) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    if (!user.isStudio) throw new ForbiddenException();
    const [row] = await this.db.query(`SELECT CASE WHEN groups_json <> '[]'::jsonb THEN to_char(anchor,'YYYY-MM-DD') END AS anchor,
      groups_json AS groups, xmin::text AS version FROM orbit_duty_schedule WHERE id = 1`);
    return row ?? { anchor: null, groups: [], version: null };
  }

  @Put()
  async save(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const captain = isCaptainRole(user.roles, this.cfg.ssoOrgId, false);
    if (!user.isStudio || !captain) throw new ForbiddenException('仅工作室队长可管理值日生');
    const input = schedule.safeParse(body);
    if (!input.success) throw new BadRequestException('排班格式不正确');
    // PostgreSQL xmin changes with each committed edit. Keep an empty row on clear
    // so a stale editor cannot recreate a schedule after another user cleared it.
    const { groups, version } = input.data;
    const monday = "date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai')::date";
    const write = version === null
      ? `INSERT INTO orbit_duty_schedule (id, anchor, groups_json) VALUES (1, ${monday}, $1::jsonb) ON CONFLICT DO NOTHING`
      : `UPDATE orbit_duty_schedule SET anchor = CASE WHEN groups_json = '[]'::jsonb THEN ${monday} ELSE anchor END,
           groups_json = $1::jsonb WHERE id = 1 AND xmin::text = $2`;
    const params = [JSON.stringify(groups)];
    if (version !== null) params.push(version);
    const [row] = await this.db.query(`WITH changed AS (${write} RETURNING xmin::text AS version) SELECT version FROM changed`, params);
    if (!row) throw new ConflictException('排班已在其他设备修改，请读取最新排班后再保存');
    return row;
  }
}
