/**
 * services/quality-variance-sync/index.ts
 *
 * Stub for the nightly job that syncs per-pair quality-variance data from
 * `ax_ai_augbidw` + `retool_db` into Supabase `public.pairing_quality_variance`.
 *
 * Phase 1 scaffolding only — see ./README.md and the Phase 1 audit at
 * `~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md`.
 *
 * Phase 2 implements:
 *   1. mssql + pg connection wiring (sources/warehouse.ts, sources/retool.ts)
 *   2. variancePivot port (compute/variance-pivot.ts) with parity unit tests
 *   3. matrix-map join + upsert into pairing_quality_variance
 *   4. mcp.audit_log row { action, target_table, actor, actor_type, diff }
 *
 * Cron registration is NOT wired in src/index.ts today — the MCP service has
 * no cron infrastructure yet. See ./README.md "Cron — three options" for the
 * Phase 2 decision (recommendation: node-cron, gated on
 * QUALITY_VARIANCE_CRON_ENABLED).
 */

import type { QualityVarianceSyncInput, QualityVarianceSyncResult } from './types.js';

/**
 * Stub. Throws so any accidental import-then-call fails loudly instead of
 * silently writing nothing. Phase 2 replaces the throw with the real
 * implementation per the spec.
 */
export async function syncQualityVariance(
  _input?: QualityVarianceSyncInput,
): Promise<QualityVarianceSyncResult> {
  void _input;
  throw new Error(
    'quality-variance-sync: Not implemented. ' +
      'Phase 2 is blocked on warehouse credentials. ' +
      'See services/quality-variance-sync/README.md and ' +
      '~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md',
  );
}

export type { QualityVarianceSyncInput, QualityVarianceSyncResult } from './types.js';
