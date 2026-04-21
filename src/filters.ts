import { z } from 'zod';

export type Region =
  | 'AX-BD-Dhaka'
  | 'AX-IN-Bangalore'
  | 'IN-IDS-Mohali'
  | 'IN-IDS-Noida'
  | 'SL-Medsource-Colombo'
  | 'AX-US-San Francisco';

export const KNOWN_REGIONS: Region[] = [
  'AX-BD-Dhaka',
  'AX-IN-Bangalore',
  'IN-IDS-Mohali',
  'IN-IDS-Noida',
  'SL-Medsource-Colombo',
  'AX-US-San Francisco',
];

export const DEFAULT_REGION: Region =
  (process.env.MCP_DEFAULT_REGION as Region) || 'AX-BD-Dhaka';

// Given an MDS region, return the LIKE pattern for the clinician scribe_partner_site
// that matches that region. E.g. 'AX-BD-Dhaka' -> 'AX-BD-%', 'IN-IDS-Mohali' -> 'IN-IDS-%'.
export function getClinicianSitePattern(region: Region): string {
  if (region.startsWith('AX-BD')) return 'AX-BD-%';
  if (region.startsWith('AX-IN')) return 'AX-IN-%';
  if (region.startsWith('IN-IDS')) return 'IN-IDS-%';
  if (region.startsWith('SL-')) return 'SL-%';
  if (region.startsWith('AX-US')) return 'AX-US-%';
  return `${region}-%`;
}

export function resolveRegion(input: string | undefined): Region {
  const s = typeof input === 'string' ? input.trim() : '';
  let result: Region;
  if (!s) {
    result = DEFAULT_REGION;
  } else if (!KNOWN_REGIONS.includes(s as Region)) {
    throw new Error(`Unknown region "${input}". Allowed: ${KNOWN_REGIONS.join(', ')}`);
  } else {
    result = s as Region;
  }
  return result;
}

/** Shared optional `region` field for MCP tool input schemas. */
export const toolRegionOptional = z.string().optional().describe(
  'MDS region. Defaults to AX-BD-Dhaka. Allowed: AX-BD-Dhaka, AX-IN-Bangalore, IN-IDS-Mohali, IN-IDS-Noida, SL-Medsource-Colombo, AX-US-San Francisco',
);

/**
 * MCP `@modelcontextprotocol/sdk` merges `inputSchema` with Zod; a plain
 * `{ field: z... }` record can fail `normalizeObjectSchema`'s raw-shape heuristic
 * so optional fields (e.g. `region`) never enter the parsed args. Always wrap
 * tool args in `z.object` via this helper.
 */
export function toolInputSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape);
}
