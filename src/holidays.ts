import type { Region } from './filters.js';

/**
 * Maps an MCP region to a Supabase holidays table, when one exists.
 */
export function getHolidayTable(region: Region): string | null {
  if (region === 'AX-BD-Dhaka') return 'bd_holidays';
  if (region.startsWith('AX-IN') || region.startsWith('IN-IDS')) return 'in_holidays';
  return null;
}
