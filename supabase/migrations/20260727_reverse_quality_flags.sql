-- 20260727_reverse_quality_flags.sql
--
-- Reverse Quality Check: NEMESIS re-scores existing, currently-active
-- clinician<->MDS pairings and flags the ones it would NOT recommend today
-- (hard-blocked by the decision tree, or scoring at/below the configured
-- best_effort_score_cap). Flags carry a human-resolution lifecycle mirroring
-- public.argus_alerts_live (resolved / resolved_by / resolved_at /
-- resolution_notes) and surface in OLYMPUS.
--
-- WRITERS: only the NEMESIS app's service role (batch job at
--   POST /api/reverse-quality/run, plus its resolve endpoint). RLS is enabled
--   with no policies, so anon/authenticated have zero direct access.
-- READERS: OLYMPUS, via the SECURITY DEFINER RPCs below. Per the security
--   model established in 018_olympus_nemesis_rpcs.sql, those RPCs return ONLY
--   de-identified fields — never clinician/MDS names, ids, or emails, and
--   never the alternatives payload (it contains MDS identities). The opaque
--   flag_id is the handle OLYMPUS uses to acknowledge/resolve/dismiss through
--   the NEMESIS proxy endpoint.
--
-- Applied to project aknjdhjdatkizumzpwgc via the Supabase MCP. Idempotent.

create table if not exists mcp.reverse_quality_flags (
  flag_id             uuid primary key default gen_random_uuid(),
  clinician_id        text not null,
  clinician_name      text,
  mds_id              text not null,
  mds_name            text,
  mds_email           text,
  shift_date          date not null,
  pairing_source      text not null default 'mds_availability_daily'
                      check (pairing_source in ('mds_availability_daily','clinician_mds_pairings')),
  nemesis_score       numeric,
  recommend_threshold numeric,
  score_gap           numeric,
  would_recommend     boolean not null default false,
  hard_blocked        boolean not null default false,
  hard_block_reasons  text[] not null default '{}',
  decision_flags      text[] not null default '{}',
  better_alternatives jsonb not null default '[]'::jsonb,
  quality_signals     jsonb not null default '{}'::jsonb,
  rationale           text,
  severity            text not null default 'medium'
                      check (severity in ('high','medium','low')),
  model_version       text,
  run_id              uuid,
  status              text not null default 'open'
                      check (status in ('open','acknowledged','resolved','dismissed')),
  acknowledged        boolean not null default false,
  resolved            boolean not null default false,
  resolved_by         text,
  resolved_at         timestamptz,
  resolution_notes    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (clinician_id, mds_id, shift_date)
);

alter table mcp.reverse_quality_flags enable row level security;

create index if not exists idx_rqf_open
  on mcp.reverse_quality_flags (severity, created_at desc)
  where status in ('open','acknowledged');
create index if not exists idx_rqf_created_at
  on mcp.reverse_quality_flags (created_at desc);
create index if not exists idx_rqf_run_id
  on mcp.reverse_quality_flags (run_id);

-- ---------------------------------------------------------------------------
-- OLYMPUS read RPCs (de-identified; anon EXECUTE, matching olympus_* posture)
-- ---------------------------------------------------------------------------

-- 1) Headline summary — one aggregate row.
create or replace function public.olympus_rqf_summary()
returns table (
  open_count bigint, acknowledged_count bigint,
  resolved_7d bigint, dismissed_7d bigint,
  high_open bigint, medium_open bigint, low_open bigint,
  latest_shift_date date, last_run_epoch_ms bigint, last_run_success boolean
)
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*) from mcp.reverse_quality_flags where status = 'open'),
    (select count(*) from mcp.reverse_quality_flags where status = 'acknowledged'),
    (select count(*) from mcp.reverse_quality_flags
       where status = 'resolved' and resolved_at >= now() - interval '7 days'),
    (select count(*) from mcp.reverse_quality_flags
       where status = 'dismissed' and resolved_at >= now() - interval '7 days'),
    (select count(*) from mcp.reverse_quality_flags
       where status in ('open','acknowledged') and severity = 'high'),
    (select count(*) from mcp.reverse_quality_flags
       where status in ('open','acknowledged') and severity = 'medium'),
    (select count(*) from mcp.reverse_quality_flags
       where status in ('open','acknowledged') and severity = 'low'),
    (select max(shift_date) from mcp.reverse_quality_flags),
    (select (extract(epoch from max(created_at)) * 1000)::bigint
       from mcp.agent_runs where tool_name = 'reverse_quality_check'),
    (select success from mcp.agent_runs
       where tool_name = 'reverse_quality_check'
       order by created_at desc limit 1);
$$;

-- 2) De-identified flag rows. No names, ids, emails, or alternatives payload:
--    alternatives are reduced to a count + best alternative score, and the
--    rationale column is written name-free by the job (identities live only in
--    dedicated columns, which this RPC never selects).
create or replace function public.olympus_rqf_list(
  p_status text default null,
  p_limit int default 50
)
returns table (
  flag_id uuid, shift_date date, pairing_source text,
  nemesis_score numeric, recommend_threshold numeric, score_gap numeric,
  hard_blocked boolean, hard_block_reasons text[], decision_flags text[],
  alternatives_count integer, best_alternative_score numeric,
  quality_signals jsonb, rationale text, severity text, status text,
  resolved_by text, resolved_at timestamptz, resolution_notes text,
  created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select
    f.flag_id, f.shift_date, f.pairing_source,
    f.nemesis_score, f.recommend_threshold, f.score_gap,
    f.hard_blocked, f.hard_block_reasons, f.decision_flags,
    coalesce(jsonb_array_length(f.better_alternatives), 0)::integer,
    (select max((alt->>'score')::numeric)
       from jsonb_array_elements(f.better_alternatives) alt
      where alt ? 'score'),
    f.quality_signals, f.rationale, f.severity, f.status,
    f.resolved_by, f.resolved_at, f.resolution_notes,
    f.created_at, f.updated_at
  from mcp.reverse_quality_flags f
  where (p_status is null and f.status in ('open','acknowledged'))
     or f.status = p_status
  order by
    case f.severity when 'high' then 0 when 'medium' then 1 else 2 end,
    f.score_gap desc nulls last,
    f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

grant execute on function public.olympus_rqf_summary()          to anon, authenticated;
grant execute on function public.olympus_rqf_list(text, int)    to anon, authenticated;
