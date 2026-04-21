import type { SupabaseClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { scopeBangladesh } from '../queryScope.js';

/** Placeholder tables — replace with your real NEMESIS schema in Supabase. */
const T = {
  mdsAvailability: 'nemesis_mds_availability',
  clinicianPreferences: 'nemesis_clinician_preferences',
  pairingProposals: 'nemesis_pairing_proposals',
} as const;

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function throwIfSupabaseError(context: string, error: { message: string } | null) {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

/**
 * NEMESIS tools: MDS pairing / matching (Bangladesh scope only).
 */
export function registerNemesisTools(server: McpServer, supabase: SupabaseClient): void {
  server.registerTool(
    'get_available_mds',
    {
      description:
        'List MDS candidates available for a shift date (Bangladesh data only). Stub: reads nemesis_mds_availability.',
      inputSchema: {
        shift_date: z.string().describe('Shift date as ISO yyyy-mm-dd'),
      },
    },
    async ({ shift_date }) => {
      const q = scopeBangladesh(
        supabase.from(T.mdsAvailability).select('*').eq('shift_date', shift_date),
      );
      const { data, error } = await q;
      throwIfSupabaseError('get_available_mds', error);
      const rows = data ?? [];
      console.log('[nemesis.get_available_mds] rowCount=%d keys=%s', rows.length, summarizeKeys(rows));
      return textResult(rows);
    },
  );

  server.registerTool(
    'get_clinician_preferences',
    {
      description:
        'Fetch pairing preferences for a clinician (Bangladesh data only). Stub: reads nemesis_clinician_preferences.',
      inputSchema: {
        clinician_id: z.string().describe('Internal clinician identifier'),
      },
    },
    async ({ clinician_id }) => {
      const q = scopeBangladesh(
        supabase.from(T.clinicianPreferences).select('*').eq('clinician_id', clinician_id),
      );
      const { data, error } = await q;
      throwIfSupabaseError('get_clinician_preferences', error);
      const rows = data ?? [];
      console.log(
        '[nemesis.get_clinician_preferences] rowCount=%d keys=%s',
        rows.length,
        summarizeKeys(rows),
      );
      return textResult(rows);
    },
  );

  server.registerTool(
    'propose_pairing',
    {
      description:
        'Record a proposed MDS pairing for a clinician and shift (Bangladesh only). Stub: inserts into nemesis_pairing_proposals.',
      inputSchema: {
        clinician_id: z.string().describe('Internal clinician identifier'),
        shift_date: z.string().describe('Shift date as ISO yyyy-mm-dd'),
      },
    },
    async ({ clinician_id, shift_date }) => {
      const row = {
        clinician_id,
        shift_date,
        country_code: 'BD',
        status: 'proposed',
        proposed_at: new Date().toISOString(),
      };
      const q = supabase.from(T.pairingProposals).insert(row).select('id,status,shift_date').limit(1);
      const { data, error } = await q;
      throwIfSupabaseError('propose_pairing', error);
      const inserted = data?.[0] ?? null;
      console.log('[nemesis.propose_pairing] inserted=%s', inserted ? 'yes' : 'no');
      return textResult(inserted);
    },
  );
}

/** Logs shape metadata only (no row contents). */
function summarizeKeys(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '[]';
  const keys = Object.keys(rows[0] ?? {}).sort();
  return `[${keys.join(',')}]`;
}
