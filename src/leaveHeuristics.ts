import { db } from './supabase.js';
import { BD_MDS_FILTER } from './filters.js';

/** 0=Sun … 4=Thu — tunable later via env-driven metadata if needed. */
const DEFAULT_HIGH_LEAVE_DOW = 4;

export type LeaveFactor = { factor: string; contribution: number };

/**
 * Heuristic leave probability (0–1). Real model can replace internals later.
 * Uses last `daysBack` days of `argus_leave_entries` for the MDS (BD-scoped).
 */
export async function computeLeaveProbability(
  mdsId: string,
  targetDate: string,
  daysBack = 180,
): Promise<{ leave_probability: number; top_factors: LeaveFactor[] }> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);

  const { data: mdsRow, error: mdsErr } = await db
    .from('mds_profile_info')
    .select('mds_id')
    .eq('mds_id', mdsId)
    .eq('service_provider', BD_MDS_FILTER.service_provider)
    .maybeSingle();
  if (mdsErr) throw new Error(mdsErr.message);
  if (!mdsRow) {
    return { leave_probability: 0, top_factors: [{ factor: 'mds_not_bd_scope', contribution: 0 }] };
  }

  const { data: leaves, error: leaveErr } = await db
    .from('argus_leave_entries')
    .select('leave_date')
    .eq('mds_id', mdsId)
    .gte('leave_date', sinceStr);
  if (leaveErr) throw new Error(leaveErr.message);

  const leaveDays = new Set((leaves ?? []).map((r) => String((r as { leave_date: string }).leave_date).slice(0, 10)));
  const windowDays = daysBack;
  const baseRate = windowDays > 0 ? Math.min(1, leaveDays.size / windowDays) : 0;

  const factors: LeaveFactor[] = [{ factor: 'historical_base_rate', contribution: baseRate }];

  const prev = addDaysIso(targetDate, -1);
  const { data: holRows, error: holErr } = await db.from('bd_holidays').select('*').limit(2000);
  if (holErr) throw new Error(holErr.message);
  const afterHoliday = (holRows ?? []).some((row) => holidayRowCoversDate(row as Record<string, unknown>, prev));
  if (afterHoliday) {
    factors.push({ factor: 'day_after_bd_holiday', contribution: 0.2 });
  }

  const dow = isoWeekdayUtc(targetDate);
  const highDow = Number(process.env.MCP_HIGH_LEAVE_DOW ?? String(DEFAULT_HIGH_LEAVE_DOW));
  const thursdayBoost = dow === highDow ? 0.15 : 0;
  if (thursdayBoost) {
    factors.push({ factor: 'high_leave_weekday', contribution: thursdayBoost });
  }

  const last7 = addDaysIso(targetDate, -7);
  const recentLeave = [...leaveDays].some((d) => d >= last7 && d < targetDate);
  const recentBoost = recentLeave ? 0.1 : 0;
  if (recentBoost) {
    factors.push({ factor: 'leave_within_last_7_days', contribution: recentBoost });
  }

  let p = baseRate + (afterHoliday ? 0.2 : 0) + thursdayBoost + recentBoost;
  p = Math.max(0, Math.min(1, p));
  const rounded = Math.round(p * 1000) / 1000;

  const top_factors = [...factors].sort((a, b) => b.contribution - a.contribution).slice(0, 3);

  return { leave_probability: rounded, top_factors };
}

function addDaysIso(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function isoWeekdayUtc(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00.000Z`).getUTCDay();
}

function holidayRowCoversDate(row: Record<string, unknown>, d: string): boolean {
  const hd = row.holiday_date;
  if (typeof hd === 'string' && hd.slice(0, 10) === d) return true;
  const s = row.start_date;
  const e = row.end_date;
  if (typeof s === 'string' && typeof e === 'string') {
    const ss = s.slice(0, 10);
    const ee = e.slice(0, 10);
    return d >= ss && d <= ee;
  }
  return false;
}
