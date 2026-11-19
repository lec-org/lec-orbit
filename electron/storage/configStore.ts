/**
 * L2 配置与窗口状态层：借鉴 electron-store 原子写入（写临时文件再 rename）+ Zod 强校验 + 版本迁移。
 * 避免强关电脑或断电时写坏配置文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  OrbitConfigPatchSchema,
  OrbitConfigSchema,
  type OrbitConfig,
  type OrbitConfigPatch,
} from '../../src/shared/ipc';

const CURRENT_SCHEMA_VERSION = 1;

function migrateRawConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  const next: Record<string, unknown> = { ...raw };
  if (version < 1) {
    next.schemaVersion = CURRENT_SCHEMA_VERSION;
  }
  return next;
}

export class ConfigStore {
  private readonly filePath: string;
  private state: OrbitConfig;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'config.json');
    this.state = this.load();
  }

  private load(): OrbitConfig {
    if (!fs.existsSync(this.filePath)) {
      return OrbitConfigSchema.parse({});
    }
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return OrbitConfigSchema.parse({});
      }
      const migrated = migrateRawConfig(parsed as Record<string, unknown>);
      const result = OrbitConfigSchema.safeParse(migrated);
      if (result.success) return result.data;
      // 局部字段损坏时尽量保留其余合法字段，其余回退默认值
      const partial = OrbitConfigSchema.partial().safeParse(migrated);
      return OrbitConfigSchema.parse(partial.success ? partial.data : {});
    } catch {
      return OrbitConfigSchema.parse({});
    }
  }

  private saveAtomic(next: OrbitConfig): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get(): OrbitConfig {
    return { ...this.state, scheduledReminders: [...this.state.scheduledReminders] };
  }

  update(patch: OrbitConfigPatch): OrbitConfig {
    const validated = OrbitConfigPatchSchema.parse(patch);
    const merged = OrbitConfigSchema.parse({
      ...this.state,
      ...validated,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    this.state = merged;
    this.saveAtomic(merged);
    return this.get();
  }
}
