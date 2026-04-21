import { computeLeaveProbability } from './leaveHeuristics.js';
import { db } from './supabase.js';
import { BD_MDS_FILTER } from './filters.js';

export type MdsAvailabilityReport = {
  mds_id: string;
  is_available: boolean;
  employment_status: unknown;
  has_upcoming_leave: boolean;
  availability_status: unknown;
  predicted_status: unknown;
  leave_probability: number | null;
  resignation_risk: boolean;
  coverage_risk_level: unknown;
  blockers: string[];
};

function resigningStatus(hr: string | null | undefined): boolean {
  if (!hr) return false;
  const s = hr.toLowerCase();
  return (
    s.includes('notice') ||
    s.includes('resign') ||
    s.includes('exit') ||
    s.includes('terminat')
  );
}

/**
 * Batch-loads profile, availability row, forecast, and heuristic leave probability per MDS.
 * BD scope enforced on `mds_profile_info` reads.
 */
export async function buildMdsAvailabilityReports(
  mdsIds: string[],
  targetDate: string,
): Promise<Record<string, MdsAvailabilityReport>> {
  const uniq = [...new Set(mdsIds)];
  const out: Record<string, MdsAvailabilityReport> = {};
  if (uniq.length === 0) return out;

  const { data: profiles, error: pErr } = await db
    .from('mds_profile_info')
    .select(
      'mds_id,is_available,employment_status,hr_employee_status,hot_list,open_remediation_p1_p2,active_p3_remediation',
    )
    .in('mds_id', uniq)
    .eq('service_provider', BD_MDS_FILTER.service_provider);
  if (pErr) throw new Error(pErr.message);

  const { data: availRows, error: aErr } = await db
    .from('mds_availability')
    .select('mds_id,date,has_upcoming_leave,availability_status,coverage_risk_level')
    .in('mds_id', uniq)
    .eq('date', targetDate);
  if (aErr) throw new Error(aErr.message);

  const { data: forecasts, error: fErr } = await db
    .from('argus_daily_coverage_forecast')
    .select('mds_id,plan_date,predicted_status')
    .in('mds_id', uniq)
    .eq('plan_date', targetDate);
  if (fErr) throw new Error(fErr.message);

  const availByMds = new Map<string, Record<string, unknown>>();
  for (const r of availRows ?? []) {
    const id = String((r as { mds_id: string }).mds_id);
    availByMds.set(id, r as Record<string, unknown>);
  }
  const forecastByMds = new Map<string, Record<string, unknown>>();
  for (const r of forecasts ?? []) {
    const id = String((r as { mds_id: string }).mds_id);
    forecastByMds.set(id, r as Record<string, unknown>);
  }
  const profileByMds = new Map<string, Record<string, unknown>>();
  for (const r of profiles ?? []) {
    const id = String((r as { mds_id: string }).mds_id);
    profileByMds.set(id, r as Record<string, unknown>);
  }

  for (const mdsId of uniq) {
    const profile = profileByMds.get(mdsId) ?? null;
    const availability = availByMds.get(mdsId) ?? null;
    const forecast = forecastByMds.get(mdsId) ?? null;

    const blockers: string[] = [];
    if (!profile) {
      blockers.push('not_bd_mds');
      out[mdsId] = {
        mds_id: mdsId,
        is_available: false,
        employment_status: null,
        has_upcoming_leave: false,
        availability_status: null,
        predicted_status: null,
        leave_probability: null,
        resignation_risk: false,
        coverage_risk_level: null,
        blockers,
      };
      continue;
    }

    const is_available = Boolean(profile.is_available);
    const employment_status = profile.employment_status ?? null;
    const hr = profile.hr_employee_status as string | null | undefined;
    const resignation_risk = resigningStatus(hr);

    const has_upcoming_leave = Boolean(availability?.has_upcoming_leave);
    const availability_status = availability?.availability_status ?? null;
    const coverage_risk_level = availability?.coverage_risk_level ?? null;
    const predicted_status = forecast?.predicted_status ?? null;

    if (!is_available) blockers.push('mds_unavailable');
    if (has_upcoming_leave) blockers.push('on_leave');
    if (resignation_risk) blockers.push('resigning');
    if (profile.hot_list) blockers.push('hot_list');
    if (profile.open_remediation_p1_p2) blockers.push('p1_remediation');
    if (profile.active_p3_remediation) blockers.push('p3_remediation');

    let leave_probability: number | null = null;
    try {
      const lp = await computeLeaveProbability(mdsId, targetDate);
      leave_probability = lp.leave_probability;
      if (leave_probability >= 0.65) blockers.push('high_leave_risk');
    } catch {
      leave_probability = null;
    }

    out[mdsId] = {
      mds_id: mdsId,
      is_available,
      employment_status,
      has_upcoming_leave,
      availability_status,
      predicted_status,
      leave_probability,
      resignation_risk,
      coverage_risk_level,
      blockers,
    };
  }

  return out;
}
