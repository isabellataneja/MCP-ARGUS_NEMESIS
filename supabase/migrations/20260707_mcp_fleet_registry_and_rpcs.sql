-- 20260707_mcp_fleet_registry_and_rpcs.sql
--
-- Idempotent. Safe to re-run. Non-destructive (no DROPs, no DELETEs, no data loss).
--
-- Purpose
-- -------
-- Turn the MCP data plane on the NEMESIS project into a real *fleet* model and
-- capture the read contract OLYMPUS depends on as versioned SQL. Until now:
--   * mcp.agent_runs only knew the 4 native tool-domain agents (enum agent_name)
--     and had no registry, so it could not represent CRONUS / EHR-Inbox /
--     Forecasting / Hephaestus.
--   * The two RPCs OLYMPUS calls (olympus_mcp_summary, olympus_metric_count)
--     existed ONLY in the live database — in no migration file. This file makes
--     them source-controlled.
--
-- What this does
--   1. mcp.audit_log — idempotent safety net (live already has these columns;
--      the ADD COLUMN IF NOT EXISTS calls no-op there, and self-heal any env
--      still on the stale 20260511 shape).
--   2. mcp.agents — new fleet registry (every agent in the suite).
--   3. mcp.agent_runs — additive columns agent_slug + source_project so non-enum
--      agents can report and every row joins to the registry uniformly.
--   4. Capture olympus_mcp_summary + olympus_metric_count as versioned DDL, and
--      widen olympus_mcp_summary to match any registered agent_slug.
--   5. New olympus_mcp_fleet() RPC — one de-identified row per registered agent
--      (registry LEFT JOIN runs), the single query the OLYMPUS /mcp page renders.
--
-- Security posture (matches existing NEMESIS RPCs):
--   * Aggregates only, no PII leaves the boundary.
--   * SECURITY DEFINER with `SET search_path TO ''` and fully-qualified names.
--   * anon/authenticated get EXECUTE on the RPCs only — never direct table access.
--   * service_role (the MCP server) keeps full table access; RLS stays enabled.

-- =============================================================================
-- 0. agent_name enum — add an 'external' member so non-native agents
--    (cronus, ehr-inbox, hephaestus) can report via POST /report. Their real
--    identity lives in agent_runs.agent_slug; `agent` = 'external' keeps the
--    per-native-agent summaries (which filter on agent::text) uncontaminated.
--    NOTE: ALTER TYPE ... ADD VALUE must not be used in the same transaction it
--    is added in, and cannot run inside an explicit BEGIN/COMMIT on some PG
--    versions — apply this statement on its own if your runner wraps the file.
-- =============================================================================

ALTER TYPE mcp.agent_name ADD VALUE IF NOT EXISTS 'external';

-- =============================================================================
-- 1. mcp.audit_log — idempotent alignment (live already satisfies this)
-- =============================================================================

ALTER TABLE mcp.audit_log
  ADD COLUMN IF NOT EXISTS target_table text,
  ADD COLUMN IF NOT EXISTS target_id    uuid,
  ADD COLUMN IF NOT EXISTS actor        text,
  ADD COLUMN IF NOT EXISTS actor_type   text,
  ADD COLUMN IF NOT EXISTS diff         jsonb;

-- =============================================================================
-- 2. mcp.agents — fleet registry
--    Keyed on the same identifier space as agent_runs.agent_slug so the fleet
--    RPC can LEFT JOIN registry -> runs. RLS on; reached only via SECURITY
--    DEFINER RPCs (anon) or service_role (the MCP server).
-- =============================================================================

CREATE TABLE IF NOT EXISTS mcp.agents (
  slug          text        PRIMARY KEY,
  display_name  text        NOT NULL,
  category      text        NOT NULL DEFAULT 'operations',  -- infrastructure|quality|bi|operations
  project       text,                                        -- home repo / Supabase project
  transport     text        NOT NULL DEFAULT 'none',         -- mcp-tools|http-report|none
  status        text        NOT NULL DEFAULT 'planned',      -- mirrors OLYMPUS AgentStatus: live|in_build|planned|paused|deprecated
  sort_order    int         NOT NULL DEFAULT 100,
  first_seen    timestamptz,
  last_seen     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mcp.agents ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA mcp TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.agents TO service_role;

-- Seed the whole fleet. Descriptive fields refresh on re-run; runtime state
-- (status, first_seen, last_seen) is set once and then left to the writer.
INSERT INTO mcp.agents (slug, display_name, category, project, transport, status, sort_order) VALUES
  ('nemesis',    'Nemesis · MDS↔Clinician Matcher', 'operations',     'NEMESIS',            'mcp-tools',   'live',  10),
  ('argus',      'Argus · Coverage & Alerts',       'operations',     'NEMESIS',            'mcp-tools',   'live',  20),
  ('forecaster', 'Forecaster · Leave Prediction',   'bi',             'Forecasting',        'mcp-tools',   'live',  30),
  ('integrity',  'Integrity · Data Integrity',      'quality',        'NEMESIS',            'mcp-tools',   'live',  40),
  ('cronus',     'Cronus · Quality Audit',          'quality',        'cronus-qa-agents',   'http-report', 'in_build', 50),
  ('ehr-inbox',  'EHR Inbox Agent',                 'operations',     'ehr-inbox-agent',    'http-report', 'in_build', 60),
  ('hephaestus', 'Hephaestus · Template Feedback',  'quality',        'hephaestus',         'http-report', 'in_build', 70)
ON CONFLICT (slug) DO UPDATE SET
  display_name = excluded.display_name,
  category     = excluded.category,
  project      = excluded.project,
  transport    = excluded.transport,
  sort_order   = excluded.sort_order;

-- =============================================================================
-- 3. mcp.agent_runs — additive columns for fleet-wide reporting
--    (run_id already exists as the PK; agent is enum agent_name — untouched.)
-- =============================================================================

ALTER TABLE mcp.agent_runs
  ADD COLUMN IF NOT EXISTS agent_slug     text,
  ADD COLUMN IF NOT EXISTS source_project text;

-- Backfill existing rows so the registry join is uniform for native agents.
UPDATE mcp.agent_runs SET agent_slug = agent::text WHERE agent_slug IS NULL;

CREATE INDEX IF NOT EXISTS agent_runs_agent_slug_created_at_idx
  ON mcp.agent_runs (agent_slug, created_at DESC);

-- =============================================================================
-- 4. Captured + widened read RPCs (source of truth for OLYMPUS's read contract)
-- =============================================================================

-- Per-agent (or fleet-wide with '*') run-health aggregate. Widened so p_agent
-- matches the enum `agent` OR the new `agent_slug`, letting registered non-enum
-- agents (cronus, ehr-inbox, hephaestus) be queried individually too.
CREATE OR REPLACE FUNCTION public.olympus_mcp_summary(p_agent text DEFAULT '*')
  RETURNS TABLE(total_runs bigint, success_rate numeric, avg_duration_ms numeric, last_run_epoch_ms bigint)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $function$
  select
    count(*)::bigint,
    coalesce(round(100.0 * sum(case when success then 1 else 0 end) / nullif(count(*),0), 1), 0),
    coalesce(round(avg(latency_ms)), 0),
    coalesce((extract(epoch from max(created_at)) * 1000)::bigint, 0)
  from mcp.agent_runs
  where p_agent = '*'
     or agent::text = p_agent
     or agent_slug = p_agent;
$function$;

-- Simple count metric for the OLYMPUS agent-detail KPIs. Captured verbatim from
-- the live definition so it is now source-controlled.
CREATE OR REPLACE FUNCTION public.olympus_metric_count(p_key text)
  RETURNS bigint
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $function$
  select case p_key
    when 'nemesis_matches'     then (select count(*) from public.pairing_history)
    when 'argus_alerts'        then (select count(*) from public.argus_alerts)
    when 'argus_coverage_gaps' then (select count(*) from public.coverage_gaps)
    else null
  end::bigint;
$function$;

-- =============================================================================
-- 5. olympus_mcp_fleet() — one de-identified row per registered agent
--    (registry LEFT JOIN runs; unwired agents come back with zeros).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.olympus_mcp_fleet()
  RETURNS TABLE(
    slug              text,
    display_name      text,
    category          text,
    project           text,
    transport         text,
    status            text,
    total_runs        bigint,
    success_rate      numeric,
    avg_duration_ms   numeric,
    last_run_epoch_ms bigint
  )
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $function$
  select
    a.slug,
    a.display_name,
    a.category,
    a.project,
    a.transport,
    a.status,
    count(r.run_id)::bigint,
    coalesce(round(100.0 * sum(case when r.success then 1 else 0 end) / nullif(count(r.run_id),0), 1), 0),
    coalesce(round(avg(r.latency_ms)), 0),
    coalesce((extract(epoch from max(r.created_at)) * 1000)::bigint, 0)
  from mcp.agents a
  left join mcp.agent_runs r
    on coalesce(r.agent_slug, r.agent::text) = a.slug
  group by a.slug, a.display_name, a.category, a.project, a.transport, a.status, a.sort_order
  order by a.sort_order, a.slug;
$function$;

-- Read access: RPCs only, for the least-privilege anon key OLYMPUS uses.
GRANT EXECUTE ON FUNCTION public.olympus_mcp_summary(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.olympus_metric_count(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.olympus_mcp_fleet()        TO anon, authenticated;

-- =============================================================================
-- 6. Reload PostgREST so the new columns / registry / RPCs are visible now.
-- =============================================================================

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verification (run as SELECTs after applying)
-- =============================================================================
-- select * from mcp.agents order by sort_order;
-- select column_name from information_schema.columns
--   where table_schema='mcp' and table_name='agent_runs' order by ordinal_position;
-- select * from public.olympus_mcp_fleet();
-- select * from public.olympus_mcp_summary('*');
-- select * from public.olympus_mcp_summary('integrity');
