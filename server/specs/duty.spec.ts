import { expect, mock, test } from 'bun:test';
import { DataSource } from 'typeorm';
import { AddDutySchedule1764800000000 } from '../src/database/migrations/1764800000000-AddDutySchedule.js';
import { DutyController } from '../src/modules/roster/duty.controller.js';
import type { AuthUser } from '../src/modules/auth/auth.types.js';
import type { AppConfig } from '../src/config/env.config.js';

test('管理员、往届队长、其他组织队长均不能写入排班，只有本组织队长可以', async () => {
  const query = mock(async () => [{ version: '101' }]);
  const api = new DutyController({ query } as unknown as DataSource, { ssoOrgId: 'studio' } as AppConfig);
  const save = (role: string) => api.save({ roles: [role], isStudio: true } as AuthUser, { groups: [['甲']], version: null });
  for (const role of ['member', 'studio:admin', 'studio:senior-captain', 'other:captain']) {
    await expect(save(role)).rejects.toThrow('仅工作室队长');
  }
  expect(query).not.toHaveBeenCalled();
  await save(' studio: Captain ');
  await save(' LEC-CAPTAIN ');
  expect(query).toHaveBeenCalledTimes(2);
  await expect(api.save({ roles: ['captain'], isStudio: true } as AuthUser, { groups: [['甲、乙']], version: null })).rejects.toThrow('排班格式不正确');
  expect(query).toHaveBeenCalledTimes(2);
});

test.skipIf(!process.env.DUTY_TEST_DB_URL)('并发创建、修改与清空均拒绝旧版本', async () => {
  const db = await new DataSource({ type: 'postgres', url: process.env.DUTY_TEST_DB_URL }).initialize();
  // Dedicated disposable database; no application data should be present.
  const runner = db.createQueryRunner();
  try {
    const [{ exists }] = await db.query("SELECT to_regclass('orbit_duty_schedule') IS NOT NULL AS exists");
    if (exists) throw new Error('测试需要全新的空数据库');
    await new AddDutySchedule1764800000000().up(runner);
    const api = new DutyController(db, { ssoOrgId: 'studio' } as AppConfig);
    const user = { roles: ['captain'], isStudio: true } as AuthUser;
    const race = async (version: string | null) => {
      const outcomes = await Promise.allSettled(['甲', '乙'].map(n => api.save(user, { groups: [[n]], version })));
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
      const loser = outcomes.find(o => o.status === 'rejected');
      expect(loser?.reason.getStatus()).toBe(409);
    };
    await race(null);
    const first = await api.get(user);
    await race(first.version);
    await expect(api.save(user, { groups: [], version: first.version })).rejects.toThrow('其他设备');
    const current = await api.get(user);
    const cleared = await api.save(user, { groups: [], version: current.version });
    expect(await api.get(user)).toEqual({ groups: [], anchor: null, version: cleared.version });
    await expect(api.save(user, { groups: [['甲']], version: null })).rejects.toThrow('其他设备');
    await api.save(user, { groups: [['新组']], version: cleared.version });
    expect((await api.get(user)).anchor).not.toBeNull();
  } finally { await runner.release(); await db.destroy(); }
});
