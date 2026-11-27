import type { DutySchedule } from '@shared/duty';
import { z } from 'zod';

const dutyResponse = z.object({
  groups: z.array(z.array(z.string().trim().min(1).max(80).regex(/^[^、,，\r\n]+$/)).min(1).max(100)).max(100),
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  version: z.unknown().optional(),
}).refine(({ groups, anchor }) => {
  if (!groups.length) return anchor === null;
  if (!anchor) return false;
  const date = new Date(anchor);
  return date.getUTCDay() === 1 && date.toISOString().slice(0, 10) === anchor;
});

export function parseDutyResponse(raw: unknown) {
  return dutyResponse.parse(raw);
}

export class OrbitHttpError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export class DutyVersionError extends Error {
  constructor() { super('服务端不支持安全保存排班，请更新 Orbit 服务端后重试。'); }
}

export function dutyVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) throw new DutyVersionError();
  return value;
}

export function editableDutyVersion(data: DutySchedule & { version?: unknown }) {
  if (data.version === null && data.groups.length === 0) return null;
  return dutyVersion(data.version);
}

export function dutyRefreshFailure(previous: DutySchedule | null, error: unknown) {
  const status = error instanceof OrbitHttpError ? error.status : undefined;
  if (status === 401) return { schedule: null, message: '登录已失效，请重新登录' };
  if (status === 403) return { schedule: null, message: '当前账号无权查看值日安排' };
  return { schedule: previous, message: previous ? '同步失败，按上次读取的排班显示' : '排班同步失败，稍后自动重试' };
}
