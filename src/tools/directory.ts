import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';
import { BD_CLINICIAN_SITE_PATTERN, BD_MDS_FILTER } from '../filters.js';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function holidayInRange(row: Record<string, unknown>, start: string, end: string): boolean {
  const hd = row.holiday_date;
  if (typeof hd === 'string') {
    const d = hd.slice(0, 10);
    return d >= start.slice(0, 10) && d <= end.slice(0, 10);
  }
  const rs = row.start_date;
  const re = row.end_date;
  if (typeof rs === 'string' && typeof re === 'string') {
    const a = rs.slice(0, 10);
    const b = re.slice(0, 10);
    return !(b < start.slice(0, 10) || a > end.slice(0, 10));
  }
  return false;
}

export function registerDirectoryTools(server: McpServer): void {
  const runGetMdsProfile = instrumented(
    'integrity',
    'get_mds_profile',
    async ({ mds_id }: { mds_id: string }) => {
      const { data, error } = await db
        .from('mds_profile_info')
        .select('*')
        .eq('mds_id', mds_id)
        .eq('service_provider', BD_MDS_FILTER.service_provider)
        .maybeSingle();
      throwIfError('get_mds_profile', error);
      return data;
    },
    (out) => ({ found: out !== null }),
  );

  server.registerTool(
    'get_mds_profile',
    {
      description: 'Get full profile for a single BD MDS by ID.',
      inputSchema: { mds_id: z.string().describe('The MDS ID') },
    },
    async (input) => asMcpTextContent(await runGetMdsProfile(input)),
  );

  const runSearchMds = instrumented(
    'integrity',
    'search_mds',
    async (filters: {
      specialty?: string;
      is_available?: boolean;
      hot_list?: boolean;
      coverage_mds?: boolean;
      employment_status?: string;
      limit: number;
    }) => {
      let q = db.from('mds_profile_info').select('*').eq('service_provider', BD_MDS_FILTER.service_provider);
      if (filters.specialty) {
        q = q.ilike('specialty_experience', `%${filters.specialty}%`);
      }
      if (filters.is_available !== undefined) q = q.eq('is_available', filters.is_available);
      if (filters.hot_list !== undefined) q = q.eq('hot_list', filters.hot_list);
      if (filters.coverage_mds !== undefined) q = q.eq('coverage_mds', filters.coverage_mds);
      if (filters.employment_status) q = q.eq('employment_status', filters.employment_status);
      const { data, error } = await q.limit(filters.limit);
      throwIfError('search_mds', error);
      console.log('[directory.search_mds] rowCount=%d', (data ?? []).length);
      return data ?? [];
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'search_mds',
    {
      description: 'Search BD MDS directory with optional filters.',
      inputSchema: {
        specialty: z.string().optional(),
        is_available: z.boolean().optional(),
        hot_list: z.boolean().optional(),
        coverage_mds: z.boolean().optional(),
        employment_status: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async (input) => asMcpTextContent(await runSearchMds(input)),
  );

  const runGetClinicianProfile = instrumented(
    'integrity',
    'get_clinician_profile',
    async ({ clinician_id }: { clinician_id: string }) => {
      const { data, error } = await db
        .from('clinician_profile_info')
        .select('*')
        .eq('clinician_id', clinician_id)
        .like('scribe_partner_site', BD_CLINICIAN_SITE_PATTERN)
        .maybeSingle();
      throwIfError('get_clinician_profile', error);
      return data;
    },
    (out) => ({ found: out !== null }),
  );

  server.registerTool(
    'get_clinician_profile',
    {
      description: 'Get full clinician profile for a Bangladesh-site clinician.',
      inputSchema: { clinician_id: z.string().describe('Clinician ID') },
    },
    async (input) => asMcpTextContent(await runGetClinicianProfile(input)),
  );

  const runSearchClinicians = instrumented(
    'integrity',
    'search_clinicians',
    async (filters: {
      specialty?: string;
      product_line?: string;
      ehr_system?: string;
      is_ramp_up?: boolean;
      limit: number;
    }) => {
      let q = db.from('clinician_profile_info').select('*').like('scribe_partner_site', BD_CLINICIAN_SITE_PATTERN);
      if (filters.specialty) q = q.ilike('specialty', `%${filters.specialty}%`);
      if (filters.product_line) q = q.ilike('product_line', `%${filters.product_line}%`);
      if (filters.ehr_system) q = q.ilike('ehr_system', `%${filters.ehr_system}%`);
      if (filters.is_ramp_up !== undefined) q = q.eq('is_ramp_up', filters.is_ramp_up);
      const { data, error } = await q.limit(filters.limit);
      throwIfError('search_clinicians', error);
      console.log('[directory.search_clinicians] rowCount=%d', (data ?? []).length);
      return data ?? [];
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'search_clinicians',
    {
      description: 'Search Bangladesh-site clinicians with optional filters.',
      inputSchema: {
        specialty: z.string().optional(),
        product_line: z.string().optional(),
        ehr_system: z.string().optional(),
        is_ramp_up: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async (input) => asMcpTextContent(await runSearchClinicians(input)),
  );

  const runGetBdHolidays = instrumented(
    'integrity',
    'get_bd_holidays',
    async ({ start_date, end_date }: { start_date: string; end_date: string }) => {
      const { data, error } = await db.from('bd_holidays').select('*').limit(5000);
      throwIfError('get_bd_holidays', error);
      const rows = (data ?? []).filter((r) => holidayInRange(r as Record<string, unknown>, start_date, end_date));
      console.log('[directory.get_bd_holidays] rowCount=%d', rows.length);
      return rows;
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_bd_holidays',
    {
      description: 'List Bangladesh holidays overlapping a date range.',
      inputSchema: {
        start_date: z.string().describe('Range start yyyy-mm-dd'),
        end_date: z.string().describe('Range end yyyy-mm-dd'),
      },
    },
    async (input) => asMcpTextContent(await runGetBdHolidays(input)),
  );

  const runGetLeaveEntitlements = instrumented(
    'integrity',
    'get_leave_entitlements',
    async ({ leave_type }: { leave_type?: string }) => {
      let q = db.from('leave_entitlements').select('*');
      if (leave_type) q = q.eq('leave_type', leave_type);
      const { data, error } = await q.limit(500);
      throwIfError('get_leave_entitlements', error);
      console.log('[directory.get_leave_entitlements] rowCount=%d', (data ?? []).length);
      return data ?? [];
    },
    (out) => ({ rowCount: (out as unknown[]).length }),
  );

  server.registerTool(
    'get_leave_entitlements',
    {
      description: 'List leave entitlement rows, optionally filtered by leave type.',
      inputSchema: { leave_type: z.string().optional() },
    },
    async (input) => asMcpTextContent(await runGetLeaveEntitlements(input)),
  );
}
