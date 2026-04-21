import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  getClinicianSitePattern,
  resolveRegion,
  toolInputSchema,
  toolRegionOptional,
  type Region,
} from '../filters.js';
import { getHolidayTable } from '../holidays.js';
import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';

const REGION_DESC_PREFIX = 'Region-scoped. Defaults to AX-BD-Dhaka if region not passed. ';

const BD_HOLIDAY_REGION: Region = 'AX-BD-Dhaka';

function throwIfError(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function holidaysTableHasRegionColumn(): boolean {
  return process.env.MCP_HOLIDAYS_HAVE_REGION === 'true';
}

async function queryHolidaysForRegion(start_date: string, end_date: string, region: Region): Promise<unknown[]> {
  const table = getHolidayTable(region);
  if (!table) return [];
  let q = db.from(table).select('*').gte('date', start_date).lte('date', end_date);
  if (holidaysTableHasRegionColumn()) q = q.eq('region', region);
  const { data, error } = await q.order('date', { ascending: true });
  throwIfError('queryHolidaysForRegion', error);
  return data ?? [];
}

const getMdsProfileInputSchema = toolInputSchema({
  mds_id: z.string().describe('The MDS ID'),
  region: toolRegionOptional,
});

export function registerDirectoryTools(server: McpServer): void {
  const runGetMdsProfile = instrumented(
    'integrity',
    'get_mds_profile',
    async (input: { mds_id: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const { data, error } = await db
        .from('mds_profile_info')
        .select('*')
        .eq('mds_id', input.mds_id)
        .eq('service_provider', region)
        .maybeSingle();
      throwIfError('get_mds_profile', error);
      return data;
    },
    (out) => ({ found: out !== null }),
  );

  server.registerTool(
    'get_mds_profile',
    {
      description:
        REGION_DESC_PREFIX + 'Get full MDS profile for a single MDS by ID, scoped to service_provider for the given region.',
      inputSchema: getMdsProfileInputSchema,
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
      region?: string;
    }) => {
      const region = resolveRegion(filters.region);
      let q = db.from('mds_profile_info').select('*').eq('service_provider', region);
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
      description:
        REGION_DESC_PREFIX + 'Search MDS directory with optional filters, scoped to the given region service_provider.',
      inputSchema: toolInputSchema({
        specialty: z.string().optional(),
        is_available: z.boolean().optional(),
        hot_list: z.boolean().optional(),
        coverage_mds: z.boolean().optional(),
        employment_status: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runSearchMds(input)),
  );

  const runGetClinicianProfile = instrumented(
    'integrity',
    'get_clinician_profile',
    async (input: { clinician_id: string; region?: string }) => {
      const region = resolveRegion(input.region);
      const clinicianPattern = getClinicianSitePattern(region);
      const { data, error } = await db
        .from('clinician_profile_info')
        .select('*')
        .eq('clinician_id', input.clinician_id)
        .like('scribe_partner_site', clinicianPattern)
        .maybeSingle();
      throwIfError('get_clinician_profile', error);
      return data;
    },
    (out) => ({ found: out !== null }),
  );

  server.registerTool(
    'get_clinician_profile',
    {
      description:
        REGION_DESC_PREFIX +
        'Get full clinician profile for a clinician whose site pattern matches the given MDS region.',
      inputSchema: toolInputSchema({
        clinician_id: z.string().describe('Clinician ID'),
        region: toolRegionOptional,
      }),
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
      region?: string;
    }) => {
      const region = resolveRegion(filters.region);
      const clinicianPattern = getClinicianSitePattern(region);
      let q = db.from('clinician_profile_info').select('*').like('scribe_partner_site', clinicianPattern);
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
      description:
        REGION_DESC_PREFIX +
        'Search clinicians whose scribe_partner_site matches the given MDS region pattern.',
      inputSchema: toolInputSchema({
        specialty: z.string().optional(),
        product_line: z.string().optional(),
        ehr_system: z.string().optional(),
        is_ramp_up: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runSearchClinicians(input)),
  );

  const runGetRegionalHolidays = instrumented(
    'integrity',
    'get_regional_holidays',
    async (input: { start_date: string; end_date: string; region?: string }) => {
      const region = resolveRegion(input.region);
      return queryHolidaysForRegion(input.start_date, input.end_date, region);
    },
    (out) => ({ count: Array.isArray(out) ? out.length : 0 }),
  );

  server.registerTool(
    'get_regional_holidays',
    {
      description:
        REGION_DESC_PREFIX +
        'List holidays for an MCP region in a date range (bd_holidays vs in_holidays). When MCP_HOLIDAYS_HAVE_REGION=true, filters by holidays.region. Returns [] when the region has no holiday table.',
      inputSchema: toolInputSchema({
        start_date: z.string(),
        end_date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetRegionalHolidays(input)),
  );

  const runGetHolidays = instrumented(
    'integrity',
    'get_holidays',
    async (input: { start_date: string; end_date: string; region?: string }) => {
      const region = resolveRegion(input.region);
      return queryHolidaysForRegion(input.start_date, input.end_date, region);
    },
    (out) => ({ count: Array.isArray(out) ? out.length : 0 }),
  );

  server.registerTool(
    'get_holidays',
    {
      description:
        REGION_DESC_PREFIX +
        'Same behavior as get_regional_holidays. Prefer get_regional_holidays for new integrations.',
      inputSchema: toolInputSchema({
        start_date: z.string(),
        end_date: z.string(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetHolidays(input)),
  );

  const runGetBdHolidays = instrumented(
    'integrity',
    'get_bd_holidays',
    async (input: { start_date: string; end_date: string }) =>
      queryHolidaysForRegion(input.start_date, input.end_date, BD_HOLIDAY_REGION),
    (out) => ({ count: Array.isArray(out) ? out.length : 0 }),
  );

  server.registerTool(
    'get_bd_holidays',
    {
      description:
        '[DEPRECATED] Alias for get_regional_holidays with region locked to AX-BD-Dhaka. Prefer get_regional_holidays.',
      inputSchema: toolInputSchema({
        start_date: z.string().describe('Range start yyyy-mm-dd'),
        end_date: z.string().describe('Range end yyyy-mm-dd'),
      }),
    },
    async (input) => asMcpTextContent(await runGetBdHolidays(input)),
  );

  const runGetLeaveEntitlements = instrumented(
    'integrity',
    'get_leave_entitlements',
    async ({ leave_type, region }: { leave_type?: string; region?: string }) => {
      resolveRegion(region);
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
      description:
        REGION_DESC_PREFIX +
        'List leave entitlement rows, optionally filtered by leave type. `region` is accepted for schema consistency only.',
      inputSchema: toolInputSchema({
        leave_type: z.string().optional(),
        region: toolRegionOptional,
      }),
    },
    async (input) => asMcpTextContent(await runGetLeaveEntitlements(input)),
  );
}
