import type { SupabaseClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { scopeBangladesh } from '../queryScope.js';

/** Placeholder tables — replace with your real ARGUS schema in Supabase. */
const T = {
  leaveForecast: 'argus_mds_leave_forecasts',
  leaveHistory: 'argus_mds_leave_history',
  absenceRisk: 'argus_mds_absence_risk',
} as const;

const dateRangeSchema = z.object({
  start: z.string().describe('Range start as ISO yyyy-mm-dd'),
  end: z.string().describe('Range end as ISO yyyy-mm-dd'),
});

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
 * ARGUS tools: leave probability and absence risk (Bangladesh scope on MDS-backed rows).
 */
export function registerArgusTools(server: McpServer, supabase: SupabaseClient): void {
  server.registerTool(
    'get_leave_probability',
    {
      description:
        'Estimated leave probability for an MDS over a date range (Bangladesh data only). Stub: argus_mds_leave_forecasts.',
      inputSchema: {
        mds_id: z.string().describe('Internal MDS identifier'),
        date_range: dateRangeSchema.describe('Inclusive forecast window'),
      },
    },
    async ({ mds_id, date_range }) => {
      const q = scopeBangladesh(
        supabase
          .from(T.leaveForecast)
          .select('*')
          .eq('mds_id', mds_id)
          .gte('period_start', date_range.start)
          .lte('period_end', date_range.end),
      );
      const { data, error } = await q;
      throwIfSupabaseError('get_leave_probability', error);
      const rows = data ?? [];
      console.log('[argus.get_leave_probability] rowCount=%d keys=%s', rows.length, summarizeKeys(rows));
      return textResult(rows);
    },
  );

  server.registerTool(
    'get_historical_leave_patterns',
    {
      description:
        'Historical leave pattern aggregates for an MDS (Bangladesh data only). Stub: argus_mds_leave_history.',
      inputSchema: {
        mds_id: z.string().describe('Internal MDS identifier'),
      },
    },
    async ({ mds_id }) => {
      const q = scopeBangladesh(supabase.from(T.leaveHistory).select('*').eq('mds_id', mds_id));
      const { data, error } = await q;
      throwIfSupabaseError('get_historical_leave_patterns', error);
      const rows = data ?? [];
      console.log(
        '[argus.get_historical_leave_patterns] rowCount=%d keys=%s',
        rows.length,
        summarizeKeys(rows),
      );
      return textResult(rows);
    },
  );

  server.registerTool(
    'flag_high_risk_absences',
    {
      description:
        'List high-risk absence flags for a shift date (Bangladesh data only). Stub: argus_mds_absence_risk.',
      inputSchema: {
        shift_date: z.string().describe('Shift date as ISO yyyy-mm-dd'),
      },
    },
    async ({ shift_date }) => {
      const q = scopeBangladesh(
        supabase
          .from(T.absenceRisk)
          .select('*')
          .eq('shift_date', shift_date)
          .eq('risk_tier', 'high'),
      );
      const { data, error } = await q;
      throwIfSupabaseError('flag_high_risk_absences', error);
      const rows = data ?? [];
      console.log(
        '[argus.flag_high_risk_absences] rowCount=%d keys=%s',
        rows.length,
        summarizeKeys(rows),
      );
      return textResult(rows);
    },
  );
}

function summarizeKeys(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '[]';
  const keys = Object.keys(rows[0] ?? {}).sort();
  return `[${keys.join(',')}]`;
}
