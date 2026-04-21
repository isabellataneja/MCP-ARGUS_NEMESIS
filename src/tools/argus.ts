import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DEFAULT_REGION,
  getClinicianSitePattern,
  KNOWN_REGIONS,
  resolveRegion,
  toolInputSchema,
  toolRegionOptional,
  type Region,
} from '../filters.js';
import { computeLeaveProbability } from '../leaveHeuristics.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';
import { mcpDb } from '../supabase.js';

const REGION_DESC_PREFIX = 'Region-scoped. Defaults to AX-BD-Dhaka if region not passed. ';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function predictedStatusFromProbability(p: number): string {
  if (p > 0.5) return 'likely_out';
  if (p >= 0.2) return 'uncertain';
  return 'likely_in';
}

async function mdsServiceRegion(mdsId: string): Promise<Region> {
  const { data, error } = await db
    .from('mds_profile_info')
    .select('service_provider')
    .eq('mds_id', mdsId)
    .maybeSingle();
  throwIfError('mdsServiceRegion', error);
  const sp = (data as { service_provider?: string } | null)?.service_provider;
  if (sp && KNOWN_REGIONS.includes(sp as Region)) return sp as Region;
  return DEFAULT_REGION;
}

export function registerArgusTools(server: McpServer): void {
  const runGetMdsAvailability = instrumented(
    'argus',
    'get_mds_availability',
    async (input: { mds_id: string; date: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_mds_availability.mds', mErr);
      if (!mds) return null;

      const { data, error } = await db.from('mds_availability').select('*').eq('mds_id', input.mds_id).eq('date', input.date).maybeSingle();
      throwIfError('get_mds_availability', error);
      return data;
    },
    (out) => ({ found: out !== null }),
  );

  server.registerTool(
    'get_mds_availability',
    {
      description:
        REGION_DESC_PREFIX +
        'Fetch mds_availability for an MDS on a date, verifying the MDS is in the given region.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetMdsAvailability(input)),
  );

  const runGetMdsLeaveHistory = instrumented(
    'argus',
    'get_mds_leave_history',
    async (input: { mds_id: string; days_back: number; region?: string }) => {
      const region = resolveRegion(input.region);
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_mds_leave_history.mds', mErr);
      if (!mds) return [];

      const since = new Date();
      since.setUTCDate(since.getUTCDate() - input.days_back);
      const sinceStr = since.toISOString().slice(0, 10);
      const { data, error } = await db
        .from('argus_leave_entries')
        .select('*')
        .eq('mds_id', input.mds_id)
        .gte('leave_date', sinceStr);
      throwIfError('get_mds_leave_history', error);
      console.log('[argus.get_mds_leave_history] rowCount=%d', (data ?? []).length);
      return data ?? [];
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_mds_leave_history',
    {
      description:
        REGION_DESC_PREFIX + 'Leave entries for an MDS in the given region over the last N days.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        days_back: z.number().int().min(1).max(730).optional().default(180),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetMdsLeaveHistory(input)),
  );

  const runPredictLeaveProbability = instrumented(
    'argus',
    'predict_leave_probability',
    async (input: { mds_id: string; target_date: string; region?: string }) => {
      const region =
        input.region !== undefined && input.region !== ''
          ? resolveRegion(input.region)
          : await mdsServiceRegion(input.mds_id);
      const lp = await computeLeaveProbability(input.mds_id, input.target_date, region);
      return { mds_id: input.mds_id, target_date: input.target_date, leave_probability: lp.leave_probability, top_factors: lp.top_factors };
    },
    (out) => ({
      leave_probability: (out as { leave_probability: number }).leave_probability,
      factor_count: (out as { top_factors: unknown[] }).top_factors.length,
    }),
  );

  server.registerTool(
    'predict_leave_probability',
    {
      description:
        REGION_DESC_PREFIX +
        'Heuristic leave probability for an MDS on a target date using that MDS region holiday calendar. When `region` is omitted, uses service_provider from mds_profile_info when known, else MCP_DEFAULT_REGION.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        target_date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runPredictLeaveProbability(input)),
  );

  const runRecordLeavePrediction = instrumented(
    'argus',
    'record_leave_prediction',
    async (input: {
      mds_id: string;
      target_date: string;
      probability: number;
      top_factors: { factor: string; contribution: number }[];
      confidence: string;
      region?: string;
    }) => {
      const region =
        input.region !== undefined && input.region !== ''
          ? resolveRegion(input.region)
          : await mdsServiceRegion(input.mds_id);
      const { data: mdsOk, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('record_leave_prediction.mds', mErr);
      if (!mdsOk) throw new Error('mds_not_in_region_scope');

      const notes = JSON.stringify(input.top_factors).slice(0, 500);
      const row = {
        mds_id: input.mds_id,
        plan_date: input.target_date,
        predicted_status: predictedStatusFromProbability(input.probability),
        confidence: input.confidence,
        notes,
      };
      const { data, error } = await db.from('argus_daily_coverage_forecast').insert(row).select('id').limit(1);
      throwIfError('record_leave_prediction', error);
      console.log('[argus.record_leave_prediction] inserted=%s', data?.[0] ? 'yes' : 'no');
      return data?.[0] ?? {};
    },
    () => ({ inserted: true }),
  );

  server.registerTool(
    'record_leave_prediction',
    {
      description:
        REGION_DESC_PREFIX +
        'Persist a daily coverage forecast row for an MDS in the given region. When `region` is omitted, uses service_provider from mds_profile_info when known, else MCP_DEFAULT_REGION.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        target_date: z.string(),
        probability: z.number(),
        top_factors: z.array(z.object({ factor: z.string(), contribution: z.number() })),
        confidence: z.string().optional().default('medium'),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runRecordLeavePrediction(input)),
  );

  const runGetCoverageGaps = instrumented(
    'argus',
    'get_coverage_gaps',
    async (filters: {
      start_date: string;
      end_date: string;
      resolved?: boolean;
      min_confidence?: string;
      region?: string;
    }) => {
      const region = resolveRegion(filters.region);
      const { data: scopedMds, error: bErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('service_provider', region);
      throwIfError('get_coverage_gaps.scoped_mds', bErr);
      const allowed = new Set((scopedMds ?? []).map((r) => String((r as { mds_id: string }).mds_id)));

      let q = db.from('argus_coverage_gaps').select('*').gte('date', filters.start_date).lte('date', filters.end_date);
      if (filters.resolved === false) q = q.is('resolved_at', null);
      if (filters.resolved === true) q = q.not('resolved_at', 'is', null);
      if (filters.min_confidence) q = q.eq('confidence', filters.min_confidence);
      const { data, error } = await q.order('detected_at', { ascending: false }).limit(500);
      throwIfError('get_coverage_gaps', error);
      const rows = (data ?? []).filter((r) => allowed.has(String((r as { mds_id: string }).mds_id)));
      console.log('[argus.get_coverage_gaps] rowCount=%d', rows.length);
      return rows;
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_coverage_gaps',
    {
      description:
        REGION_DESC_PREFIX + 'Coverage gaps in a date range, scoped to MDS rows in the given region.',
      inputSchema: toolInputSchema({
        start_date: z.string(),
        end_date: z.string(),
        resolved: z.boolean().optional(),
        min_confidence: z.string().optional(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetCoverageGaps(input)),
  );

  const runRecordCoverageGap = instrumented(
    'argus',
    'record_coverage_gap',
    async (input: {
      mds_id: string;
      date: string;
      gap_type: string;
      affected_clinician_id?: string;
      confidence: string;
      specialty?: string;
      region?: string;
    }) => {
      const region = resolveRegion(input.region);
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id,mds_name')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('record_coverage_gap.mds', mErr);
      if (!mds) throw new Error('mds_not_in_region_scope');

      const row = {
        mds_id: input.mds_id,
        date: input.date,
        gap_type: input.gap_type,
        affected_clinician_id: input.affected_clinician_id ?? null,
        confidence: input.confidence,
        specialty: input.specialty ?? null,
        mds_name: (mds as { mds_name?: string | null }).mds_name ?? null,
        detected_at: new Date().toISOString(),
        resolution: null as string | null,
        resolved_at: null as string | null,
      };
      const { data, error } = await db.from('argus_coverage_gaps').insert(row).select('id').limit(1);
      throwIfError('record_coverage_gap', error);
      console.log('[argus.record_coverage_gap] inserted=%s', data?.[0] ? 'yes' : 'no');
      return data?.[0] ?? {};
    },
    () => ({ inserted: true }),
  );

  server.registerTool(
    'record_coverage_gap',
    {
      description:
        REGION_DESC_PREFIX + 'Insert a coverage gap for an MDS verified in the given region.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        date: z.string(),
        gap_type: z.string(),
        affected_clinician_id: z.string().optional(),
        confidence: z.string().optional().default('medium'),
        specialty: z.string().optional(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runRecordCoverageGap(input)),
  );

  const runResolveCoverageGap = instrumented(
    'argus',
    'resolve_coverage_gap',
    async ({ gap_id, resolution, region }: { gap_id: string; resolution: string; region?: string }) => {
      resolveRegion(region);
      const { data, error } = await db
        .from('argus_coverage_gaps')
        .update({ resolution, resolved_at: new Date().toISOString() })
        .eq('id', gap_id)
        .select('id');
      throwIfError('resolve_coverage_gap', error);
      const { error: audErr } = await mcpDb.from('audit_log').insert({
        action: 'resolve_coverage_gap',
        details: { gap_id, resolution_len: resolution.length },
      });
      if (audErr) console.error('[argus.resolve_coverage_gap] audit_insert_failed code=%s', audErr.code ?? 'n/a');
      console.log('[argus.resolve_coverage_gap] updated_rows=%d', (data ?? []).length);
      return { updated: (data ?? []).length };
    },
    (out) => ({ updated_rows: (out as { updated: number }).updated }),
  );

  server.registerTool(
    'resolve_coverage_gap',
    {
      description:
        REGION_DESC_PREFIX +
        'Mark a coverage gap resolved and append an audit row (resolution text not duplicated in logs). `region` is accepted for schema consistency only.',
      inputSchema: toolInputSchema({
        gap_id: z.string(),
        resolution: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runResolveCoverageGap(input)),
  );

  const runGetDailyCoveragePlan = instrumented(
    'argus',
    'get_daily_coverage_plan',
    async (input: { date: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { data: plans, error: pErr } = await db.from('daily_coverage_plan').select('*').eq('date', input.date);
      throwIfError('get_daily_coverage_plan.plans', pErr);
      const ids = [...new Set((plans ?? []).map((r) => String((r as { clinician_id: string }).clinician_id)))];
      if (ids.length === 0) {
        console.log('[argus.get_daily_coverage_plan] rowCount=0');
        return [];
      }
      const { data: clinicians, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id,scribe_partner_site')
        .in('clinician_id', ids)
        .like('scribe_partner_site', clinicianPattern);
      throwIfError('get_daily_coverage_plan.clinicians', cErr);
      const allowed = new Set((clinicians ?? []).map((c) => String((c as { clinician_id: string }).clinician_id)));
      const rows = (plans ?? []).filter((p) => allowed.has(String((p as { clinician_id: string }).clinician_id)));
      console.log('[argus.get_daily_coverage_plan] rowCount=%d', rows.length);
      return rows;
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_daily_coverage_plan',
    {
      description:
        REGION_DESC_PREFIX +
        'Daily coverage plan rows for a date, restricted to clinicians matching the region site pattern.',
      inputSchema: toolInputSchema({
        date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetDailyCoveragePlan(input)),
  );
}
