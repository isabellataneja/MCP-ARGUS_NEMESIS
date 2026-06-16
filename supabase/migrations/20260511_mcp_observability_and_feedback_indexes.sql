-- 20260511_mcp_observability_and_feedback_indexes.sql
--
-- Idempotent. Safe to re-run. Non-destructive (no DROPs, no DELETEs).
--
-- What this does
-- --------------
-- 1. Creates the `mcp` schema + `mcp.agent_runs` and `mcp.audit_log` tables
--    that the MCP server (instrument.ts, propose_pairing, record_pairing_feedback,
--    resolve_coverage_gap) writes to on every tool call. Until this is applied,
--    those writes silently fail in the MCP server's try/catch — telemetry +
--    write audit log are simply empty.
--
-- 2. Exposes the `mcp` schema to PostgREST so the Supabase JS client
--    (`db: { schema: 'mcp' }`) can reach the new tables.
--
-- 3. Adds two columns that NEMESIS code uses but were never in a numbered
--    migration: `feedback_log.non_data_override` (boolean) and the
--    `nemesis_config` singleton table.
--
-- 4. Idempotently re-applies migration 009's `override_reason_category` column
--    on feedback_log and pairing_history. Safe even if you already ran it.
--
-- 5. Adds covering indexes for the heavy reads `get_feedback_signals` does:
--    feedback_log (clinician_id, feedback_rating, created_at) and
--    pairing_history (clinician_id, feedback_rating, recommendation_date).
--    These match the exact WHERE / ORDER BY of `buildFeedbackModifier`.
--
-- Grants assume the standard Supabase role layout: `service_role` is the
-- server-side bypass-RLS role used by the MCP server.
--
-- Verified against the live Supabase via scripts/verify-mcp-schema.mjs
-- (NEMESIS repo) on 2026-05-11. Findings drove sections 2, 3a, 3b.

-- =============================================================================
-- 1. The `mcp` schema and observability tables
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mcp;

-- Per-tool-call telemetry. instrument.ts writes one row per call.
CREATE TABLE IF NOT EXISTS mcp.agent_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  agent           text        NOT NULL,
  tool_name       text        NOT NULL,
  input_shape     jsonb,
  output_summary  jsonb,
  success         boolean     NOT NULL,
  error_message   text,
  latency_ms      integer,
  caller          text
);

CREATE INDEX IF NOT EXISTS agent_runs_created_at_idx
  ON mcp.agent_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_tool_name_created_at_idx
  ON mcp.agent_runs (tool_name, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_success_created_at_idx
  ON mcp.agent_runs (success, created_at DESC)
  WHERE success = false;

CREATE INDEX IF NOT EXISTS agent_runs_caller_created_at_idx
  ON mcp.agent_runs (caller, created_at DESC)
  WHERE caller IS NOT NULL;


-- Per-write audit record. Tools that mutate (propose_pairing,
-- record_pairing_feedback, resolve_coverage_gap, propose_backup_pairing)
-- write a single row here. No PII — just action + structured details.
CREATE TABLE IF NOT EXISTS mcp.audit_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  action      text        NOT NULL,
  details     jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
  ON mcp.audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_action_created_at_idx
  ON mcp.audit_log (action, created_at DESC);


-- Service-role can use the schema and read/write its tables.
-- Postgres GRANTs are idempotent.
GRANT USAGE ON SCHEMA mcp TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mcp TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mcp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;


-- =============================================================================
-- 2. Expose the `mcp` schema to PostgREST
--    Without this, `mcpDb.from('agent_runs').insert(...)` returns PGRST106
--    even though the table exists.
--    `authenticator` is the Supabase role PostgREST connects as.
-- =============================================================================

ALTER ROLE authenticator SET pgrst.db_schemas = 'public, mcp';
NOTIFY pgrst, 'reload config';


-- =============================================================================
-- 3a. NEMESIS code expects these but they were never in a numbered migration
-- =============================================================================

-- feedback_log.non_data_override — defined in schema.sql but missing from
-- live Supabase per the 2026-05-11 probe. Used by feedback-filter.ts to
-- weight manager/team-preference overrides at 0.5× vs data-driven overrides.
ALTER TABLE feedback_log
  ADD COLUMN IF NOT EXISTS non_data_override boolean NOT NULL DEFAULT false;

-- nemesis_config singleton: holds admin-overridden NemesisRules JSONB.
-- Defined in schema.sql but missing from live Supabase per the probe.
-- Without this table, get_nemesis_rules silently falls back to defaults
-- and the admin "save rules" panel errors.
CREATE TABLE IF NOT EXISTS nemesis_config (
  id          text        PRIMARY KEY DEFAULT 'singleton',
  config      jsonb       NOT NULL,
  updated_at  timestamptz DEFAULT now(),
  updated_by  text
);

ALTER TABLE nemesis_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'nemesis_config'
      AND policyname = 'Allow all for service role'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for service role" ON nemesis_config FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END $$;


-- =============================================================================
-- 3b. Re-apply migration 009 idempotently
--    (override_reason_category column on feedback_log + pairing_history)
-- =============================================================================

ALTER TABLE feedback_log
  ADD COLUMN IF NOT EXISTS override_reason_category text;

ALTER TABLE pairing_history
  ADD COLUMN IF NOT EXISTS override_reason_category text;

CREATE INDEX IF NOT EXISTS feedback_log_category_idx
  ON feedback_log (override_reason_category)
  WHERE override_reason_category IS NOT NULL;

CREATE INDEX IF NOT EXISTS pairing_history_category_idx
  ON pairing_history (override_reason_category)
  WHERE override_reason_category IS NOT NULL;


-- =============================================================================
-- 4. Indexes for the new feedback-modifier reads (Phase 2a)
--    Match the exact WHERE / ORDER BY shapes in src/feedback/modifier.ts.
-- =============================================================================

-- buildFeedbackModifier: direct feedback_log query
-- WHERE clinician_id = $1 AND feedback_rating IN ('Rejected','Partially Accepted')
-- ORDER BY created_at DESC LIMIT 500
CREATE INDEX IF NOT EXISTS feedback_log_clinician_rating_created_idx
  ON feedback_log (clinician_id, feedback_rating, created_at DESC);

-- buildFeedbackModifier: global baseline feedback_log query
-- WHERE clinician_id <> $1 AND feedback_rating IN ('Rejected','Partially Accepted')
-- ORDER BY created_at DESC LIMIT 1000
CREATE INDEX IF NOT EXISTS feedback_log_rating_created_idx
  ON feedback_log (feedback_rating, created_at DESC);

-- buildFeedbackModifier: pairing_history direct
-- WHERE clinician_id = $1 AND feedback_rating IN ('Rejected','Partially Accepted')
-- ORDER BY recommendation_date DESC NULLS LAST LIMIT 500
CREATE INDEX IF NOT EXISTS pairing_history_clinician_rating_recdate_idx
  ON pairing_history (clinician_id, feedback_rating, recommendation_date DESC NULLS LAST);

-- buildFeedbackModifier: outcomes query
-- WHERE clinician_id = $1 SELECT outcome_30d, outcome_60d, outcome_90d
CREATE INDEX IF NOT EXISTS pairing_history_clinician_outcomes_idx
  ON pairing_history (clinician_id)
  WHERE outcome_30d IS NOT NULL OR outcome_60d IS NOT NULL OR outcome_90d IS NOT NULL;

-- getRecentOverrides: feedback_log free-text prose
-- WHERE clinician_id = $1 AND feedback_rating IN (...) AND override_reason IS NOT NULL
-- ORDER BY created_at DESC
-- (covered by feedback_log_clinician_rating_created_idx; this is the partial
-- variant that helps when override_reason filtering is the selective predicate)
CREATE INDEX IF NOT EXISTS feedback_log_clinician_override_created_idx
  ON feedback_log (clinician_id, created_at DESC)
  WHERE override_reason IS NOT NULL;


-- =============================================================================
-- 5. Reload the PostgREST schema cache so the new schema + columns
--    are visible immediately (otherwise can take up to 10 minutes).
-- =============================================================================

NOTIFY pgrst, 'reload schema';


-- =============================================================================
-- 6. Verification queries (uncomment and run as SELECTs to confirm)
-- =============================================================================

-- SELECT schemaname FROM pg_catalog.pg_namespace WHERE nspname = 'mcp';
-- SELECT tablename FROM pg_tables WHERE schemaname = 'mcp';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'mcp' AND table_name = 'agent_runs';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'feedback_log'
--     AND column_name = 'override_reason_category';
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'mcp';
-- SELECT indexname FROM pg_indexes
--   WHERE schemaname = 'public' AND indexname LIKE 'feedback_log_%';
