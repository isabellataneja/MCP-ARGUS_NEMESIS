import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildMdsAvailabilityReports } from '../availabilityBatch.js';
import { getClinicianSitePattern, resolveRegion, toolInputSchema, toolRegionOptional } from '../filters.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';
import { isActiveEmployment, scoreMdsForClinician, type MdsCandidateShape, type RankedMds } from '../scoring.js';

const REGION_DESC_PREFIX = 'Region-scoped. Defaults to AX-BD-Dhaka if region not passed. ';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export function registerOrchestrationTools(server: McpServer): void {
  const runCheckMdsListAvailability = instrumented(
    'forecaster',
    'check_mds_list_availability',
    async (input: { mds_ids: string[]; target_date: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const reports = await buildMdsAvailabilityReports(input.mds_ids, input.target_date, region);
      const list = input.mds_ids.map((id) => reports[id]);
      console.log('[orchestration.check_mds_list_availability] resultCount=%d', list.length);
      return list;
    },
    (out) => ({ resultCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'check_mds_list_availability',
    {
      description:
        REGION_DESC_PREFIX +
        'Batch vet MDS candidates for a target date; each MDS must match the given region service_provider.',
      inputSchema: toolInputSchema({
        mds_ids: z.array(z.string()).min(1).max(200),
        target_date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runCheckMdsListAvailability(input)),
  );

  const runFindBackupCandidates = instrumented(
    'forecaster',
    'find_backup_candidates',
    async (input: {
      clinician_id: string;
      target_date: string;
      top_n: number;
      exclude_mds_ids: string[];
      region?: string;
    }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { clinician_id, target_date, top_n, exclude_mds_ids } = input;

      const { data: clinician, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id,specialty,ehr_system,scribe_partner_site')
        .eq('clinician_id', clinician_id)
        .like('scribe_partner_site', clinicianPattern)
        .maybeSingle();
      throwIfError('find_backup_candidates.clinician', cErr);
      if (!clinician) throw new Error('clinician_not_found_or_not_region_scope');

      const exclude = new Set(exclude_mds_ids ?? []);
      const { data: candidates, error: mErr } = await db
        .from('mds_profile_info')
        .select(
          'mds_id,mds_name,specialty_experience,active_ehrs,sla_met_pct,ai_mds_retention_pct,avg_overall_review,hot_list,open_escalations,open_remediation_p1_p2,active_p3_remediation,employment_status,is_available',
        )
        .eq('service_provider', region)
        .eq('is_available', true)
        .limit(800);
      throwIfError('find_backup_candidates.mds', mErr);

      const pool = (candidates ?? [])
        .map((m) => m as MdsCandidateShape & { employment_status?: string | null })
        .filter((m) => !exclude.has(m.mds_id))
        .filter((m) => isActiveEmployment(m.employment_status ?? null));

      const ids = pool.map((m) => m.mds_id);
      const reports = await buildMdsAvailabilityReports(ids, target_date, region);
      const blockerFree = pool.filter((m) => (reports[m.mds_id]?.blockers?.length ?? 99) === 0);

      const clinShape = {
        specialty: (clinician as { specialty?: string | null }).specialty ?? null,
        ehr_system: (clinician as { ehr_system?: string | null }).ehr_system ?? null,
      };

      const ranked: RankedMds[] = [];
      for (const m of blockerFree) {
        const { score, components, flags } = scoreMdsForClinician(m, clinShape, region);
        ranked.push({
          mds_id: m.mds_id,
          mds_name: m.mds_name,
          score,
          components,
          flags,
          availability_confirmed: true,
        });
      }
      ranked.sort((a, b) => b.score - a.score);
      const top = ranked.slice(0, top_n);
      console.log('[orchestration.find_backup_candidates] resultCount=%d', top.length);
      return top;
    },
    (out) => ({ resultCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'find_backup_candidates',
    {
      description:
        REGION_DESC_PREFIX +
        'Rank MDS backups that are blocker-free on a target date within the given region.',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        target_date: z.string(),
        top_n: z.number().int().min(1).max(50).optional().default(10),
        exclude_mds_ids: z.array(z.string()).optional().default([]),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runFindBackupCandidates(input)),
  );

  const runGetCliniciansAffectedByMdsAbsence = instrumented(
    'forecaster',
    'get_clinicians_affected_by_mds_absence',
    async (input: { mds_id: string; date: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { mds_id, date } = input;
      const { data: mdsRow, error: mErr } = await db
        .from('mds_profile_info')
        .select('mds_id')
        .eq('mds_id', mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_clinicians_affected_by_mds_absence.mds', mErr);
      if (!mdsRow) return [];

      const { data: pairs, error: pErr } = await db
        .from('clinician_mds_pairings')
        .select('clinician_id,primary_mds_id,active,effective_from,effective_to,shift_start_time')
        .eq('primary_mds_id', mds_id)
        .eq('active', true);
      throwIfError('get_clinicians_affected_by_mds_absence.pairings', pErr);
      const active = (pairs ?? []).filter((r) => {
        const from = String((r as { effective_from?: string }).effective_from ?? '').slice(0, 10);
        const toRaw = (r as { effective_to?: string | null }).effective_to;
        if (from > date) return false;
        if (toRaw === null || toRaw === undefined || String(toRaw).trim() === '') return true;
        return String(toRaw).slice(0, 10) >= date;
      });
      // shift_start_time lives on clinician_mds_pairings, not clinician_profile_info
      const shiftByClinician = new Map<string, string | null>();
      for (const r of active) {
        const cid = String((r as { clinician_id: string }).clinician_id);
        if (!shiftByClinician.has(cid)) {
          const st = (r as { shift_start_time?: string | null }).shift_start_time;
          shiftByClinician.set(cid, st ?? null);
        }
      }
      const ids = [...shiftByClinician.keys()];
      if (ids.length === 0) {
        console.log('[orchestration.get_clinicians_affected_by_mds_absence] resultCount=0');
        return [];
      }
      const { data: clinicians, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id,clinician_name,product_line,ehr_system,specialty,sla_target_min,scribe_partner_site')
        .in('clinician_id', ids)
        .like('scribe_partner_site', clinicianPattern);
      throwIfError('get_clinicians_affected_by_mds_absence.clinicians', cErr);
      const rows =
        clinicians?.map((c) => {
          const clinician_id = (c as { clinician_id: string }).clinician_id;
          return {
            clinician_id,
            clinician_name: (c as { clinician_name?: string | null }).clinician_name ?? null,
            shift_start_time: shiftByClinician.get(clinician_id) ?? null,
            product_line: (c as { product_line?: string | null }).product_line ?? null,
            ehr_system: (c as { ehr_system?: string | null }).ehr_system ?? null,
            specialty: (c as { specialty?: string | null }).specialty ?? null,
            sla_target_min: (c as { sla_target_min?: number | null }).sla_target_min ?? null,
          };
        }) ?? [];
      console.log('[orchestration.get_clinicians_affected_by_mds_absence] resultCount=%d', rows.length);
      return rows;
    },
    (out) => ({ resultCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_clinicians_affected_by_mds_absence',
    {
      description:
        REGION_DESC_PREFIX +
        'List clinicians paired to an MDS on a given date (active pairing window), scoped to the region site pattern.',
      inputSchema: toolInputSchema({
        mds_id: z.string(),
        date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetCliniciansAffectedByMdsAbsence(input)),
  );

  const runProposeBackupPairing = instrumented(
    'forecaster',
    'propose_backup_pairing',
    async (input: {
      clinician_id: string;
      backup_mds_id: string;
      date: string;
      rationale: string;
      confidence_score: number;
      original_mds_id: string;
      gap_id?: string;
      region?: string;
    }) => {
      void input.rationale;
      void input.confidence_score;
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const plan_id = randomUUID();

      const { data: clin, error: cErr } = await db
        .from('clinician_profile_info')
        .select('clinician_id,clinician_name')
        .eq('clinician_id', input.clinician_id)
        .like('scribe_partner_site', clinicianPattern)
        .maybeSingle();
      throwIfError('propose_backup_pairing.clinician', cErr);
      if (!clin) throw new Error('clinician_not_region_scope');

      const { data: primaryMds, error: pErr } = await db
        .from('mds_profile_info')
        .select('mds_id,mds_name')
        .eq('mds_id', input.original_mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('propose_backup_pairing.primary_mds', pErr);
      if (!primaryMds) throw new Error('primary_mds_not_region_scope');

      const { data: backupMds, error: bErr } = await db
        .from('mds_profile_info')
        .select('mds_id,mds_name')
        .eq('mds_id', input.backup_mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('propose_backup_pairing.backup_mds', bErr);
      if (!backupMds) throw new Error('backup_mds_not_region_scope');

      const row = {
        plan_id,
        date: input.date,
        clinician_id: input.clinician_id,
        primary_mds_id: input.original_mds_id,
        backup_mds_id: input.backup_mds_id,
        clinician_name: (clin as { clinician_name?: string | null }).clinician_name ?? null,
        primary_mds_name: (primaryMds as { mds_name?: string | null }).mds_name ?? null,
        backup_mds_name: (backupMds as { mds_name?: string | null }).mds_name ?? null,
        backup_confirmed: false,
        backup_activated: false,
        no_backup_found: false,
      };

      const { error: insErr } = await db.from('daily_coverage_plan').insert(row);
      throwIfError('propose_backup_pairing.insert_plan', insErr);

      if (input.gap_id) {
        const resolution = `backup_proposed:${plan_id}`;
        const { error: gErr } = await db.from('argus_coverage_gaps').update({ resolution }).eq('id', input.gap_id);
        if (gErr) console.error('[orchestration.propose_backup_pairing] gap_update_failed code=%s', gErr.code ?? 'n/a');
      }

      console.log('[orchestration.propose_backup_pairing] plan_id_created=%s', plan_id.slice(0, 8));
      return { plan_id };
    },
    () => ({ created: true }),
  );

  server.registerTool(
    'propose_backup_pairing',
    {
      description:
        REGION_DESC_PREFIX +
        'Insert a daily_coverage_plan backup row and optionally resolve a coverage gap by id. All lookups respect the resolved region.',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        backup_mds_id: z.string(),
        date: z.string(),
        rationale: z.string(),
        confidence_score: z.number().min(0).max(1),
        original_mds_id: z.string(),
        gap_id: z.string().optional(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runProposeBackupPairing(input)),
  );
}
