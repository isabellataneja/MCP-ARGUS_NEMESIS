import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getClinicianSitePattern, resolveRegion, toolInputSchema, toolRegionOptional } from '../filters.js';
import { buildFeedbackModifier, getRecentOverrides, type FeedbackModifier } from '../feedback/modifier.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';

const REGION_DESC_PREFIX = 'Region-scoped. Defaults to AX-BD-Dhaka if region not passed. ';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

async function clinicianBelongsToRegion(clinician_id: string, region: string): Promise<boolean> {
  const pattern = getClinicianSitePattern(region as Parameters<typeof getClinicianSitePattern>[0]);
  const { data, error } = await db
    .from('clinician_profile_info')
    .select('clinician_id')
    .eq('clinician_id', clinician_id)
    .like('scribe_partner_site', pattern)
    .maybeSingle();
  throwIfError('clinicianBelongsToRegion', error);
  return Boolean(data);
}

export function registerFeedbackTools(server: McpServer): void {
  const runGetFeedbackSignals = instrumented(
    'nemesis',
    'get_feedback_signals',
    async (input: { clinician_id: string; region?: string }): Promise<FeedbackModifier | null> => {
      const region = resolveRegion(input.region);
      const inScope = await clinicianBelongsToRegion(input.clinician_id, region);
      if (!inScope) return null;
      return buildFeedbackModifier(input.clinician_id);
    },
    (out) =>
      out
        ? {
            feedback_count: out.feedback_count,
            feedback_source: out.feedback_source,
            blocked_count: out.blocked_mds_ids.length,
            proven_count: out.good_outcome_mds_ids.length,
            reassigned_count: out.reassigned_mds_ids.length,
          }
        : { feedback_count: 0 },
  );

  server.registerTool(
    'get_feedback_signals',
    {
      description:
        REGION_DESC_PREFIX +
        'Time-decayed, consensus-gated feedback signals for one clinician. Returns category penalty boosts (tat / specialty / escalation / workload), proven / reassigned / blocked MDS lists, and reason tags. Mirrors NEMESIS-side FeedbackModifier. Returns null if the clinician is not in the resolved region.',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetFeedbackSignals(input)),
  );

  const runGetRecentOverrides = instrumented(
    'nemesis',
    'get_recent_overrides',
    async (input: { clinician_id: string; limit: number; region?: string }): Promise<string[]> => {
      const region = resolveRegion(input.region);
      const inScope = await clinicianBelongsToRegion(input.clinician_id, region);
      if (!inScope) return [];
      return getRecentOverrides(input.clinician_id, input.limit);
    },
    (out) => ({ count: (out as string[]).length }),
  );

  server.registerTool(
    'get_recent_overrides',
    {
      description:
        REGION_DESC_PREFIX +
        'Recent free-text override-reason prose for a clinician, decay-weighted and deduped. Narrative-only signal for justification prompts — scoring should use get_feedback_signals instead.',
      inputSchema: toolInputSchema({
        clinician_id: z.string(),
        limit: z.number().int().min(1).max(20).optional().default(5),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetRecentOverrides(input)),
  );
}
