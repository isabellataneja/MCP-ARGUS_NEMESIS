import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { BD_CLINICIAN_SITE_PATTERN, BD_MDS_FILTER } from '../filters.js';
import { computeLeaveProbability } from '../leaveHeuristics.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';
import { mcpDb } from '../supabase.js';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function predictedStatusFromProbability(p: number): string {
  if (p > 0.5) return 'likely_out';
  if (p >= 0.2) return 'uncertain';
  return 'likely_in';
}

export function registerArgusTools(server: McpServer): void {
  const runGetMdsAvailability = instrumented(
    'argus',
    'get_mds_availability',
    async ({ mds_id, date }: { mds_id: string; date: string }) => {
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', mds_id)
        .eq('service_provider', BD_MDS_FILTER.service_provider)
        .maybeSingle();
      throwIfError('get_mds_availability.mds', mErr);
      if (!mds) return null;

      const { data, error } = await db.from('mds_availability').select('*').eq('mds_id', mds_id).eq('date', date).maybeSingle();
      throwIfError('get_mds_availability', error);
      return data;
    },
    (out) => ({ found: out !== null }),
  );

  server.registerTool(
    'get_mds_availability',
    {
      description: 'Fetch mds_availability for an MDS on a date, verifying BD scope on mds_profile_info.',
      inputSchema: { mds_id: z.string(), date: z.string() },
    },
    async (input) => asMcpTextContent(await runGetMdsAvailability(input)),
  );

  const runGetMdsLeaveHistory = instrumented(
    'argus',
    'get_mds_leave_history',
    async ({ mds_id, days_back }: { mds_id: string; days_back: number }) => {
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', mds_id)
        .eq('service_provider', BD_MDS_FILTER.service_provider)
        .maybeSingle();
      throwIfError('get_mds_leave_history.mds', mErr);
      if (!mds) return [];

      const since = new Date();
      since.setUTCDate(since.getUTCDate() - days_back);
      const sinceStr = since.toISOString().slice(0, 10);
      const { data, error } = await db
        .from('argus_leave_entries')
        .select('*')
        .eq('mds_id', mds_id)
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
      description: 'Leave entries for a BD MDS over the last N days.',
      inputSchema: {
        mds_id: z.string(),
        days_back: z.number().int().min(1).max(730).optional().default(180),
      },
    },
    async (input) => asMcpTextContent(await runGetMdsLeaveHistory(input)),
  );

  const runPredictLeaveProbability = instrumented(
    'argus',
    'predict_leave_probability',
    async ({ mds_id, target_date }: { mds_id: string; target_date: string }) => {
      const lp = await computeLeaveProbability(mds_id, target_date);
      return { mds_id, target_date, leave_probability: lp.leave_probability, top_factors: lp.top_factors };
    },
    (out) => ({
      leave_probability: (out as { leave_probability: number }).leave_probability,
      factor_count: (out as { top_factors: unknown[] }).top_factors.length,
    }),
  );

  server.registerTool(
    'predict_leave_probability',
    {
      description: 'Heuristic leave probability for an MDS on a target date.',
      inputSchema: { mds_id: z.string(), target_date: z.string() },
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
    }) => {
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
      description: 'Persist a daily coverage forecast row for an MDS.',
      inputSchema: {
        mds_id: z.string(),
        target_date: z.string(),
        probability: z.number(),
        top_factors: z.array(z.object({ factor: z.string(), contribution: z.number() })),
        confidence: z.string().optional().default('medium'),
      },
    },
    async (input) => asMcpTextContent(await runRecordLeavePrediction(input)),
  );

  const runGetCoverageGaps = instrumented(
    'argus',
    'get_coverage_gaps',
    async (filters: { start_date: string; end_date: string; resolved?: boolean; min_confidence?: string }) => {
      const { data: bdMds, error: bErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('service_provider', BD_MDS_FILTER.service_provider);
      throwIfError('get_coverage_gaps.bd_mds', bErr);
      const allowed = new Set((bdMds ?? []).map((r) => String((r as { mds_id: string }).mds_id)));

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
      description: 'Coverage gaps in a date range, BD MDS scope via mds_profile_info membership.',
      inputSchema: {
        start_date: z.string(),
        end_date: z.string(),
        resolved: z.boolean().optional(),
        min_confidence: z.string().optional(),
      },
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
    }) => {
      const { data: mds, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id,mds_name')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', BD_MDS_FILTER.service_provider)
        .maybeSingle();
      throwIfError('record_coverage_gap.mds', mErr);
      if (!mds) throw new Error('mds_not_bd_scope');

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
      description: 'Insert a coverage gap for a BD-verified MDS.',
      inputSchema: {
        mds_id: z.string(),
        date: z.string(),
        gap_type: z.string(),
        affected_clinician_id: z.string().optional(),
        confidence: z.string().optional().default('medium'),
        specialty: z.string().optional(),
      },
    },
    async (input) => asMcpTextContent(await runRecordCoverageGap(input)),
  );

  const runResolveCoverageGap = instrumented(
    'argus',
    'resolve_coverage_gap',
    async ({ gap_id, resolution }: { gap_id: string; resolution: string }) => {
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
      description: 'Mark a coverage gap resolved and append an audit row (resolution text not duplicated in logs).',
      inputSchema: { gap_id: z.string(), resolution: z.string() },
    },
    async (input) => asMcpTextContent(await runResolveCoverageGap(input)),
  );

  const runGetDailyCoveragePlan = instrumented(
    'argus',
    'get_daily_coverage_plan',
    async ({ date }: { date: string }) => {
      const { data: plans, error: pErr } = await db.from('daily_coverage_plan').select('*').eq('date', date);
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
        .like('scribe_partner_site', BD_CLINICIAN_SITE_PATTERN);
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
      description: 'Daily coverage plan rows for a date, restricted to Bangladesh-site clinicians.',
      inputSchema: { date: z.string() },
    },
    async (input) => asMcpTextContent(await runGetDailyCoveragePlan(input)),
  );
}
