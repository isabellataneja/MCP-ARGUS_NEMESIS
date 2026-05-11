import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildMdsAvailabilityReports } from '../availabilityBatch.js';
import { buildFeedbackModifier, getRecentOverrides } from '../feedback/modifier.js';
import { getClinicianSitePattern, resolveRegion, toolInputSchema, toolRegionOptional } from '../filters.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { isActiveEmployment, scoreMdsForClinician, type MdsCandidateShape, type RankedMds } from '../scoring.js';
import { db } from '../supabase.js';

const REGION_DESC_PREFIX = 'Region-scoped. Defaults to AX-BD-Dhaka if region not passed. ';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

const DEFAULT_RULES = {
  recording_hours_cap: 4.5,
  retention_delta_band: 5,
  max_heavy_note_clinicians_per_mds: 3,
  heavy_note_threshold_min: 40,
  min_mds_per_clinician: 2,
  assist_mds_clinician_ratio: 3,
  escalation_score_penalty: 5,
  no_specialty_match_penalty: 12,
  retention_low_threshold_pct: 6,
  clinician_edit_flag_threshold: 5,
  end_of_day_min_rating_coverage: 4,
  sla_target_default_min: 60,
  prior_escalation_no_training_block: true,
  remediation_hard_block: true,
  initial_scope_product_line: 'Assist',
  cross_site_enabled: true,
  cross_site_penalty: 10,
  allowed_bd_providers: ['AX-BD-Dhaka'],
  allowed_india_providers: ['AX-IN-Bangalore', 'IN-IDS-Mohali', 'IN-IDS-Noida'],
  show_best_effort_fallback: true,
  best_effort_score_cap: 50,
} as const;

type NemesisRules = typeof DEFAULT_RULES;

let cachedRules: NemesisRules | null = null;
let cachedRulesExpiry = 0;
const RULES_TTL_MS = 60_000;

async function fetchRules(): Promise<NemesisRules> {
  if (cachedRules && Date.now() < cachedRulesExpiry) return cachedRules;
  try {
    const { data, error } = await db
      .from('nemesis_config')
      .select('config')
      .eq('id', 'singleton')
      .maybeSingle();
    if (!error && data && typeof (data as { config?: unknown }).config === 'object' && (data as { config?: unknown }).config) {
      const merged = { ...DEFAULT_RULES, ...((data as { config: Partial<NemesisRules> }).config) };
      cachedRules = merged as NemesisRules;
    } else {
      cachedRules = { ...DEFAULT_RULES };
    }
  } catch {
    cachedRules = { ...DEFAULT_RULES };
  }
  cachedRulesExpiry = Date.now() + RULES_TTL_MS;
  return cachedRules;
}

export function registerContextTools(server: McpServer): void {
  /* -------------------------------------------------------------------------- */
  /* get_nemesis_rules                                                          */
  /* -------------------------------------------------------------------------- */

  const runGetNemesisRules = instrumented(
    'nemesis',
    'get_nemesis_rules',
    async () => fetchRules(),
    (out) => ({ keys: Object.keys(out as Record<string, unknown>).length }),
  );

  server.registerTool(
    'get_nemesis_rules',
    {
      description:
        'NEMESIS policy snapshot: SLA targets, score caps, cross-site policy, allowed regions, remediation block toggles. Defaults merged with admin overrides from nemesis_config.singleton. Cached 60s. No region filtering — these are platform-wide constants. Example call: `get_nemesis_rules()`.',
      inputSchema: toolInputSchema({}),
    },
    async () => asMcpTextContent(await runGetNemesisRules({})),
  );

  /* -------------------------------------------------------------------------- */
  /* get_pairing_context                                                        */
  /* -------------------------------------------------------------------------- */

  const runGetPairingContext = instrumented(
    'nemesis',
    'get_pairing_context',
    async (input: {
      clinician_id: string;
      shift_date: string;
      top_n: number;
      exclude_mds_ids: string[];
      region?: string;
    }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { clinician_id, shift_date, top_n, exclude_mds_ids } = input;

      const [
        { data: clinician, error: cErr },
        { data: candidates, error: mErr },
        modifier,
        recentOverrides,
        rules,
      ] = await Promise.all([
        db
          .from('clinician_profile_info')
          .select(
            'clinician_id,clinician_name,specialty,ehr_system,product_line,sla_target_min,scribe_partner_site',
          )
          .eq('clinician_id', clinician_id)
          .like('scribe_partner_site', clinicianPattern)
          .maybeSingle(),
        db
          .from('mds_profile_info')
          .select(
            'mds_id,mds_name,specialty_experience,active_ehrs,sla_met_pct,ai_mds_retention_pct,avg_overall_review,hot_list,open_escalations,open_remediation_p1_p2,active_p3_remediation,employment_status,is_available',
          )
          .eq('service_provider', region)
          .eq('is_available', true)
          .limit(800),
        buildFeedbackModifier(clinician_id),
        getRecentOverrides(clinician_id, 5),
        fetchRules(),
      ]);
      throwIfError('get_pairing_context.clinician', cErr);
      throwIfError('get_pairing_context.mds', mErr);
      if (!clinician) throw new Error('clinician_not_found_or_not_region_scope');

      const exclude = new Set(exclude_mds_ids ?? []);
      const clinShape = {
        specialty: (clinician as { specialty?: string | null }).specialty ?? null,
        ehr_system: (clinician as { ehr_system?: string | null }).ehr_system ?? null,
      };

      const pool = (candidates ?? [])
        .map((m) => m as MdsCandidateShape & { employment_status?: string | null })
        .filter((m) => !exclude.has(m.mds_id))
        .filter((m) => isActiveEmployment(m.employment_status ?? null));

      const ranked: RankedMds[] = [];
      for (const m of pool) {
        const { score, components, flags, capped, cap_reason } = scoreMdsForClinician(
          m,
          clinShape,
          region,
          modifier,
        );
        ranked.push({
          mds_id: m.mds_id,
          mds_name: m.mds_name,
          score,
          components,
          flags,
          capped,
          cap_reason,
        });
      }
      ranked.sort((a, b) => b.score - a.score);
      const top = ranked.slice(0, top_n);

      const availability = await buildMdsAvailabilityReports(
        top.map((r) => r.mds_id),
        shift_date,
        region,
      );

      const enriched = top.map((r) => ({
        ...r,
        availability_report: availability[r.mds_id] ?? null,
      }));

      const { data: currentPairingRows, error: pErr } = await db
        .from('clinician_mds_pairings')
        .select('clinician_id,primary_mds_id,active,effective_from,effective_to')
        .eq('clinician_id', clinician_id)
        .eq('active', true);
      throwIfError('get_pairing_context.current_pairing', pErr);
      const today = shift_date.slice(0, 10);
      const currentPairing = (currentPairingRows ?? []).find((r) => {
        const from = String((r as { effective_from?: string }).effective_from ?? '').slice(0, 10);
        const toRaw = (r as { effective_to?: string | null }).effective_to;
        if (from > today) return false;
        if (toRaw === null || toRaw === undefined || String(toRaw).trim() === '') return true;
        return String(toRaw).slice(0, 10) >= today;
      }) as { primary_mds_id?: string } | undefined;

      return {
        region,
        shift_date,
        clinician,
        current_primary_mds_id: currentPairing?.primary_mds_id ?? null,
        ranked_candidates: enriched,
        feedback_signals: modifier,
        recent_overrides: recentOverrides,
        rules_snapshot: {
          sla_target_default_min: rules.sla_target_default_min,
          cross_site_enabled: rules.cross_site_enabled,
          cross_site_penalty: rules.cross_site_penalty,
          best_effort_score_cap: rules.best_effort_score_cap,
        },
      };
    },
    (out) => {
      const o = out as { ranked_candidates?: unknown[]; feedback_signals?: { feedback_count?: number } };
      return {
        candidates: o.ranked_candidates?.length ?? 0,
        feedback_count: o.feedback_signals?.feedback_count ?? 0,
      };
    },
  );

  server.registerTool(
    'get_pairing_context',
    {
      description:
        REGION_DESC_PREFIX +
        'Single-call composite for the NEMESIS pairing workflow: clinician profile, current primary MDS, top-N feedback-aware ranked candidates with availability reports, time-decayed feedback signals, and a rules snapshot. Replaces the get_clinician_profile → rank_mds_candidates → check_mds_list_availability → get_feedback_signals chain when full visibility into each step is not needed. Example: `get_pairing_context({ clinician_id, shift_date: "2026-05-12", top_n: 5, region: "AX-BD-Dhaka" })`.',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        shift_date: z.string().describe('Target shift date yyyy-mm-dd. Used for availability reports.'),
        top_n: z.number().int().min(1).max(20).optional().default(5),
        exclude_mds_ids: z.array(z.string()).optional().default([]),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetPairingContext(input)),
  );

  /* -------------------------------------------------------------------------- */
  /* get_mds_with_history                                                       */
  /* -------------------------------------------------------------------------- */

  const runGetMdsWithHistory = instrumented(
    'nemesis',
    'get_mds_with_history',
    async (input: {
      mds_id: string;
      recent_pairings_limit: number;
      perf_window_days: number;
      region?: string;
    }) => {
      const region = resolveRegion(input.region);
      const { mds_id, recent_pairings_limit, perf_window_days } = input;

      const { data: profile, error: pErr } = await db
        .from('mds_profile_info')
        .select('*')
        .eq('mds_id', mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_mds_with_history.profile', pErr);
      if (!profile) return null;

      const { data: pairingsRaw, error: hErr } = await db
        .from('pairing_history')
        .select(
          'pairing_id, clinician_id, mds_id, recommendation_date, feedback_rating, override_reason, override_to_mds_id, outcome_30d, outcome_60d, outcome_90d',
        )
        .eq('mds_id', mds_id)
        .order('recommendation_date', { ascending: false, nullsFirst: false })
        .limit(Math.min(100, recent_pairings_limit * 3));
      throwIfError('get_mds_with_history.pairings', hErr);

      const end = new Date();
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - perf_window_days);
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      const { data: notes, error: nErr } = await db
        .from('nemesis_note_log')
        .select('*')
        .eq('mds_id', mds_id);
      throwIfError('get_mds_with_history.notes', nErr);
      const inWin = (notes ?? []).filter((r) => {
        const vd = String((r as { visit_date?: string }).visit_date ?? '').slice(0, 10);
        return vd >= startStr && vd <= endStr;
      });

      let tatSum = 0;
      let tatN = 0;
      let revSum = 0;
      let revN = 0;
      let poor = 0;
      for (const row of inWin) {
        const rec = row as Record<string, unknown>;
        const tat =
          (typeof rec.tat_minutes === 'number' ? rec.tat_minutes : null) ??
          (typeof rec.tat_min === 'number' ? rec.tat_min : null) ??
          (typeof rec.tat === 'number' ? rec.tat : null);
        if (typeof tat === 'number') {
          tatSum += tat;
          tatN++;
        }
        const rev = typeof rec.overall_review === 'number' ? rec.overall_review : null;
        if (typeof rev === 'number') {
          revSum += rev;
          revN++;
          if (rev < 3) poor++;
        }
      }

      return {
        profile,
        recent_pairings: (pairingsRaw ?? []).slice(0, recent_pairings_limit),
        performance_summary: {
          window_start: startStr,
          window_end: endStr,
          note_count: inWin.length,
          avg_tat_min: tatN ? tatSum / tatN : null,
          avg_overall_review: revN ? revSum / revN : null,
          poor_review_count: poor,
        },
      };
    },
    (out) =>
      out
        ? {
            note_count:
              (out as { performance_summary?: { note_count?: number } }).performance_summary?.note_count ?? 0,
            pairings:
              (out as { recent_pairings?: unknown[] }).recent_pairings?.length ?? 0,
          }
        : { note_count: 0, pairings: 0 },
  );

  server.registerTool(
    'get_mds_with_history',
    {
      description:
        REGION_DESC_PREFIX +
        'MDS profile, recent pairing history, and rolling-window performance summary in one call. Use when the agent needs to drill into a single MDS after ranking (e.g. close-call tiebreaks or override review). Returns null if the MDS is not in the resolved region. Example: `get_mds_with_history({ mds_id: "688567", recent_pairings_limit: 10, perf_window_days: 90 })`.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        recent_pairings_limit: z.number().int().min(1).max(50).optional().default(10),
        perf_window_days: z.number().int().min(7).max(365).optional().default(90),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetMdsWithHistory(input)),
  );
}
