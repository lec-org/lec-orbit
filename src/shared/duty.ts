export interface DutySchedule { anchor: string | null; groups: string[][] }

const day = 86_400_000;
export function dutyWeek(now: number, schedule?: DutySchedule | null) {
  const date = new Date(now + 8 * 3_600_000);
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const anchor = schedule?.anchor ? Date.parse(schedule.anchor) : NaN;
  const hasGroups = Boolean(schedule?.groups.length) && Number.isFinite(anchor);
  const weekStart = hasGroups ? Math.max(monday, anchor) : monday;
  const index = hasGroups && schedule ? Math.floor((weekStart - anchor) / (7 * day)) % schedule.groups.length : -1;
  const label = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace('-', '.');
  return { index, dates: `${label(weekStart)} – ${label(weekStart + 6 * day)}` };
}
