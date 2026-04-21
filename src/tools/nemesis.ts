import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  getClinicianSitePattern,
  resolveRegion,
  toolInputSchema,
  toolRegionOptional,
  type Region,
} from '../filters.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { mcpDb } from '../supabase.js';
import { db } from '../supabase.js';
import { isActiveEmployment, scoreMdsForClinician, type MdsCandidateShape, type RankedMds } from '../scoring.js';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

const REGION_DESC_PREFIX = 'Region-scoped. Defaults to AX-BD-Dhaka if region not passed. ';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function mdsIdSetForRegion(region: Region): Promise<Set<string>> {
  const { data, error } = await db.from('mds_profile_info').select('mds_id').eq('service_provider', region);
  throwIfError('mdsIdSetForRegion', error);
  return new Set((data ?? []).map((r) => String((r as { mds_id: string }).mds_id)));
}

export function registerNemesisTools(server: McpServer): void {
  const runGetCurrentPairing = instrumented(
    'nemesis',
    'get_current_pairing',
    async (input: { clinician_id: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { data: clinRow, error: clinErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id')
        .eq('clinician_id', input.clinician_id)
        .like('scribe_partner_site', clinicianPattern)
        .maybeSingle();
      throwIfError('get_current_pairing.clinician', clinErr);
      if (!clinRow) {
        console.log('[nemesis.get_current_pairing] rowCount=0');
        return { primary_mds_id: null as string | null, row: null };
      }

      const today = todayIso();
      const { data, error } = await db
        .from('clinician_mds_pairings')
        .select('clinician_id,primary_mds_id,active,effective_from,effective_to')
        .eq('clinician_id', input.clinician_id)
        .eq('active', true);
      throwIfError('get_current_pairing', error);
      const rows = (data ?? []).filter((r) => {
        const from = String((r as { effective_from?: string }).effective_from ?? '').slice(0, 10);
        const toRaw = (r as { effective_to?: string | null }).effective_to;
        if (from > today) return false;
        if (toRaw === null || toRaw === undefined || String(toRaw).trim() === '') return true;
        return String(toRaw).slice(0, 10) >= today;
      });
      const primary = rows[0] as { primary_mds_id?: string } | undefined;
      console.log('[nemesis.get_current_pairing] rowCount=%d', rows.length);
      return primary?.primary_mds_id
        ? { primary_mds_id: primary.primary_mds_id, row: rows[0] }
        : { primary_mds_id: null as string | null, row: null };
    },
    (out) => ({ has_pairing: Boolean((out as { primary_mds_id?: string | null }).primary_mds_id) }),
  );

  server.registerTool(
    'get_current_pairing',
    {
      description:
        REGION_DESC_PREFIX +
        'Return the active primary MDS pairing for a clinician (text date-safe filters). Clinician must match the resolved region site pattern.',
      inputSchema: toolInputSchema({ clinician_id: z.string(), region: toolRegionOptional }),
    },
    async (input) => asMcpTextContent(await runGetCurrentPairing(input)),
  );

  const runGetMdsPairedClinicians = instrumented(
    'nemesis',
    'get_mds_paired_clinicians',
    async (input: { mds_id: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { data: mdsOk, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_mds_paired_clinicians.mds', mErr);
      if (!mdsOk) {
        console.log('[nemesis.get_mds_paired_clinicians] rowCount=0');
        return [];
      }

      const { data: pairs, error: pErr } = await db
        .from('clinician_mds_pairings')
        .select('clinician_id,primary_mds_id,active,effective_from,effective_to')
        .eq('primary_mds_id', input.mds_id)
        .eq('active', true);
      throwIfError('get_mds_paired_clinicians.pairings', pErr);
      const ids = [...new Set((pairs ?? []).map((r) => String((r as { clinician_id: string }).clinician_id)))];
      if (ids.length === 0) {
        console.log('[nemesis.get_mds_paired_clinicians] rowCount=0');
        return [];
      }
      const { data: clinicians, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id,scribe_partner_site')
        .in('clinician_id', ids)
        .like('scribe_partner_site', clinicianPattern);
      throwIfError('get_mds_paired_clinicians.clinicians', cErr);
      const allowed = new Set((clinicians ?? []).map((c) => String((c as { clinician_id: string }).clinician_id)));
      const filtered = (pairs ?? []).filter((r) => allowed.has(String((r as { clinician_id: string }).clinician_id)));
      console.log('[nemesis.get_mds_paired_clinicians] rowCount=%d', filtered.length);
      return filtered;
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_mds_paired_clinicians',
    {
      description:
        REGION_DESC_PREFIX +
        'List active pairings for an MDS, restricted to clinicians matching the region site pattern. MDS must be in the same region.',
      inputSchema: toolInputSchema({ mds_id: z.string(), region: toolRegionOptional }),
    },
    async (input) => asMcpTextContent(await runGetMdsPairedClinicians(input)),
  );

  const runGetPairingHistory = instrumented(
    'nemesis',
    'get_pairing_history',
    async (filters: {
      clinician_id?: string;
      mds_id?: string;
      window_days: number;
      limit: number;
      region?: string;
    }) => {
      const region = resolveRegion(filters.region);
      const scope = await mdsIdSetForRegion(region);
      let q = db.from('pairing_history').select('*');
      if (filters.clinician_id) q = q.eq('clinician_id', filters.clinician_id);
      if (filters.mds_id) q = q.eq('mds_id', filters.mds_id);
      const { data, error } = await q.limit(Math.min(500, filters.limit * 5));
      throwIfError('get_pairing_history', error);
      const cut = new Date();
      cut.setUTCDate(cut.getUTCDate() - filters.window_days);
      const cutStr = cut.toISOString().slice(0, 10);
      const rows = (data ?? [])
        .filter((r) => scope.has(String((r as { mds_id: string }).mds_id)))
        .filter((r) => {
          const rd = String((r as { recommendation_date?: string }).recommendation_date ?? '').slice(0, 10);
          return rd.length === 0 || rd >= cutStr;
        })
        .sort((a, b) =>
          String((b as { recommendation_date?: string }).recommendation_date ?? '').localeCompare(
            String((a as { recommendation_date?: string }).recommendation_date ?? ''),
          ),
        )
        .slice(0, filters.limit);
      console.log('[nemesis.get_pairing_history] rowCount=%d', rows.length);
      return rows;
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_pairing_history',
    {
      description:
        REGION_DESC_PREFIX +
        'Pairing history scoped to MDS rows in the given region, ordered by recommendation_date descending.',
      inputSchema: toolInputSchema({
        clinician_id: z.string().optional(),
        mds_id: z.string().optional(),
        window_days: z.number().int().min(1).max(730).optional().default(180),
        limit: z.number().int().min(1).max(500).optional().default(100),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetPairingHistory(input)),
  );

  const runGetMdsPerformanceSummary = instrumented(
    'nemesis',
    'get_mds_performance_summary',
    async (input: { mds_id: string; window_days: number; region?: string }) => {
      const region = resolveRegion(input.region);
      const { mds_id, window_days } = input;
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_mds_performance_summary.mds', mErr);
      if (!mds) return null;

      const end = new Date();
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - window_days);
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      const { data: notes, error: nErr } = await db.from('nemesis_note_log').select('*').eq('mds_id', mds_id);
      throwIfError('get_mds_performance_summary.notes', nErr);
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

      const result = {
        mds_id,
        note_count: inWin.length,
        avg_tat_min: tatN ? tatSum / tatN : null,
        avg_overall_review: revN ? revSum / revN : null,
        poor_review_count: poor,
        window_start: startStr,
        window_end: endStr,
      };
      console.log('[nemesis.get_mds_performance_summary] note_count=%d', result.note_count);
      return result;
    },
    (out) => (out ? { note_count: (out as { note_count: number }).note_count } : { note_count: 0 }),
  );

  server.registerTool(
    'get_mds_performance_summary',
    {
      description:
        REGION_DESC_PREFIX +
        'Aggregate NEMESIS note metrics for an MDS in the given region over a rolling window.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        window_days: z.number().int().min(7).max(365).optional().default(90),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetMdsPerformanceSummary(input)),
  );

  const runRankMdsCandidates = instrumented(
    'nemesis',
    'rank_mds_candidates',
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
      const { data: clinician, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id,specialty,ehr_system,scribe_partner_site')
        .eq('clinician_id', clinician_id)
        .like('scribe_partner_site', clinicianPattern)
        .maybeSingle();
      throwIfError('rank_mds_candidates.clinician', cErr);
      if (!clinician) throw new Error('clinician_not_found_or_not_region_scope');

      const { data: candidates, error: mErr } = await db
        .from('mds_profile_info')
        .select(
          'mds_id,mds_name,specialty_experience,active_ehrs,sla_met_pct,ai_mds_retention_pct,avg_overall_review,hot_list,open_escalations,open_remediation_p1_p2,active_p3_remediation,employment_status,is_available',
        )
        .eq('service_provider', region)
        .eq('is_available', true)
        .limit(800);
      throwIfError('rank_mds_candidates.mds', mErr);

      const exclude = new Set(exclude_mds_ids ?? []);
      const clinShape = {
        specialty: (clinician as { specialty?: string | null }).specialty ?? null,
        ehr_system: (clinician as { ehr_system?: string | null }).ehr_system ?? null,
      };

      const ranked: RankedMds[] = [];
      for (const raw of candidates ?? []) {
        const m = raw as MdsCandidateShape & { employment_status?: string | null };
        if (exclude.has(m.mds_id)) continue;
        if (!isActiveEmployment(m.employment_status ?? null)) continue;
        const { score, components, flags } = scoreMdsForClinician(m, clinShape, region);
        ranked.push({
          mds_id: m.mds_id,
          mds_name: m.mds_name,
          score,
          components,
          flags,
        });
      }
      ranked.sort((a, b) => b.score - a.score);
      const top = ranked.slice(0, top_n);
      console.log(
        '[nemesis.rank_mds_candidates] shift_date=%s top_n=%d resultCount=%d',
        shift_date,
        top_n,
        top.length,
      );
      return top;
    },
    (out) => ({ resultCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'rank_mds_candidates',
    {
      description:
        REGION_DESC_PREFIX + 'Rank available MDS candidates for a clinician in the given region (NEMESIS scoring).',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        shift_date: z.string().describe('Target shift date yyyy-mm-dd (reserved for future constraints)'),
        top_n: z.number().int().min(1).max(50).optional().default(10),
        exclude_mds_ids: z.array(z.string()).optional().default([]),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runRankMdsCandidates(input)),
  );

  const runProposePairing = instrumented(
    'nemesis',
    'propose_pairing',
    async (input: {
      clinician_id: string;
      mds_id: string;
      shift_date: string;
      rationale: string;
      confidence_score: number;
      flags_fired: string[];
      region?: string;
    }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { data: clinOk, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id')
        .eq('clinician_id', input.clinician_id)
        .like('scribe_partner_site', clinicianPattern)
        .maybeSingle();
      throwIfError('propose_pairing.clinician', cErr);
      if (!clinOk) throw new Error('clinician_not_in_region_scope');

      const { data: mdsOk, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('propose_pairing.mds', mErr);
      if (!mdsOk) throw new Error('mds_not_in_region_scope');

      const id = randomUUID();
      const pairing_id = randomUUID();
      const shiftDate = input.shift_date.slice(0, 10);
      const tags = (input.flags_fired ?? []).filter(Boolean).join(',');
      const rationaleSan = input.rationale.trim().replace(/\|/g, ' ');
      const flagsFired =
        rationaleSan.length > 0 ? (tags.length > 0 ? `${tags}|${rationaleSan}` : rationaleSan) : tags;

      const row = {
        id,
        clinician_id: input.clinician_id,
        recommended_mds_id: input.mds_id,
        nemesis_score: Math.round(input.confidence_score * 100),
        flags_fired: flagsFired,
        feedback_rating: null as number | null,
        override_occurred: false,
        submitted_by: 'nemesis-mcp',
        created_at: new Date().toISOString(),
        pairing_id,
        recommendation_date: shiftDate,
      };
      const { data, error } = await db.from('feedback_log').insert(row).select('id,pairing_id').limit(1);
      throwIfError('propose_pairing', error);
      console.log('[nemesis.propose_pairing] inserted=%s', data?.[0] ? 'yes' : 'no');
      return data?.[0] ?? { id, pairing_id };
    },
    () => ({ inserted: true }),
  );

  server.registerTool(
    'propose_pairing',
    {
      description:
        REGION_DESC_PREFIX +
        'Record a NEMESIS pairing proposal in feedback_log. shift_date is stored as recommendation_date. rationale is appended to flags_fired after a single | when both tags and rationale exist. Validates clinician + MDS are in the resolved region.',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        mds_id: z.string(),
        shift_date: z.string(),
        rationale: z.string(),
        confidence_score: z.number().min(0).max(1),
        flags_fired: z.array(z.string()).optional().default([]),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runProposePairing(input)),
  );

  const runRecordPairingFeedback = instrumented(
    'nemesis',
    'record_pairing_feedback',
    async (input: {
      pairing_id: string;
      feedback_rating: number;
      region?: string;
      override_info?: { override_to_mds_id: string; override_reason: string };
    }) => {
      resolveRegion(input.region);
      const patch: Record<string, unknown> = { feedback_rating: input.feedback_rating };
      if (input.override_info) {
        patch.override_occurred = true;
        patch.override_to_mds_id = input.override_info.override_to_mds_id;
        patch.override_reason = input.override_info.override_reason;
      }
      const { data, error } = await db.from('feedback_log').update(patch).eq('pairing_id', input.pairing_id).select('id');
      throwIfError('record_pairing_feedback', error);
      const { error: audErr } = await mcpDb.from('audit_log').insert({
        action: 'record_pairing_feedback',
        details: {
          pairing_id: input.pairing_id,
          has_override: Boolean(input.override_info),
        },
      });
      if (audErr) console.error('[nemesis.record_pairing_feedback] audit_insert_failed code=%s', audErr.code ?? 'n/a');
      console.log('[nemesis.record_pairing_feedback] updated_rows=%d', (data ?? []).length);
      return { updated: (data ?? []).length };
    },
    (out) => ({ updated_rows: (out as { updated: number }).updated }),
  );

  server.registerTool(
    'record_pairing_feedback',
    {
      description:
        REGION_DESC_PREFIX +
        'Update feedback_log by pairing_id and append an MCP audit row (no PII in audit payload). `region` is accepted for schema consistency only.',
      inputSchema: toolInputSchema({
        pairing_id: z.string(),
        feedback_rating: z.number(),
        region: toolRegionOptional,
        override_info: z
          .object({
            override_to_mds_id: z.string(),
            override_reason: z.string(),
          })
          .optional(),
      }),
    },
    async (input) => asMcpTextContent(await runRecordPairingFeedback(input)),
  );
}
