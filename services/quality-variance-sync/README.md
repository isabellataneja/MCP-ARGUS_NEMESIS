# quality-variance-sync

Nightly job that pulls quality-variance data from the Commure Ambient Quality
warehouse + the `retool_db` coverage table, computes 11 per-pair variance
flags (mirroring the Retool dashboard's `variancePivot` transformer), and
upserts the results into Supabase `public.pairing_quality_variance` so NEMESIS
scoring can factor objective quality metrics into pairing decisions.

> **Scaffolding only — no sync logic in this file tree yet.** Phase 2 of the
> Quality Variance Integration is blocked on warehouse credentials. See the
> Phase 1 audit at `~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md`
> for the full plan, the credential dependency, and the discovered gaps.

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Audit + hosting decision | ✅ Done — hosting locked to this MCP service (extend, not split) |
| 1.5 | Scaffolding (this directory) + cron-options doc | ✅ Done — see below |
| 2 | Schema migration + variance compute (+ unit tests against Retool parity) | ⏸ Blocked on creds |
| 3 | Sync job wiring + reconciliation report | ⏸ Blocked on creds + cron decision |
| 4 | NEMESIS scoring integration (penalty / bonus / flag) | ⏸ Depends on Phase 3 |
| 5 | Outcome review removal + cron writer | ⏸ Depends on Phase 4 |

## What this job will do (Phase 2 onward)

```
04:00 UTC nightly  ─►  pull 4 SQL queries from ax_ai_augbidw
                  ─►  pull 1 query from retool_db (coverage)
                  ─►  join via matrix-map (sf_id, mds_uid)
                  ─►  run variancePivot transformer port (TypeScript)
                  ─►  upsert into public.pairing_quality_variance
                       on conflict (sf_id, mds_uid, window_end_date)
                  ─►  audit row in mcp.audit_log
```

## Environment contract

All values live in Railway env vars on the `nemesis-argus-mcp` service.
**Never commit real values.** Placeholders below are documentation only.

### New env vars (Phase 2 prerequisite)

| Var | Purpose | Source |
|---|---|---|
| `WAREHOUSE_MSSQL_HOST` | MS SQL Server host for `ax_ai_augbidw` | Moontasir |
| `WAREHOUSE_MSSQL_PORT` | Default `1433` if standard | Moontasir |
| `WAREHOUSE_MSSQL_DATABASE` | Expected `ax_ai_augbidw` | Moontasir |
| `WAREHOUSE_MSSQL_USER` | Read-only role scoped to the 5 tables in the spec | Moontasir |
| `WAREHOUSE_MSSQL_PASSWORD` | — | Moontasir |
| `WAREHOUSE_MSSQL_ENCRYPT` | Default `true`; Azure SQL requires it | Moontasir |
| `RETOOL_DB_CONNECTION_STRING` | Postgres URI for `retool_db` (UUID `61109227-…`) — read-only on `ambient_mds_coverage_tracker` | Bella |
| `QUALITY_VARIANCE_CRON_ENABLED` | `true` to arm the cron once Phase 3 ships. Default `false` so partial config can't trigger writes. | Set in Railway |

### Reused env vars (already on Railway)

| Var | How this job uses it |
|---|---|
| `SUPABASE_URL` | Upsert `pairing_quality_variance` + write `mcp.audit_log` rows |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role client for the above |
| `MCP_DEFAULT_REGION` | Default `AX-BD-Dhaka` — used if a windowed pull needs to scope by region |

## Cron — three options, decision deferred to Phase 2

**Probe finding (2026-05-11):** the MCP service has no cron infrastructure
today. No `node-cron`, no Railway cron config in `railway.json`, no
`setInterval`-based scheduler. Per Phase 1 audit instruction "do not invent a
cron registry" — this scaffold registers nothing. The Phase 2 implementer
picks one of these and wires it then.

### (a) `node-cron` inside `src/index.ts` (recommended)

```ts
// in src/index.ts main(), AFTER app.listen():
import cron from 'node-cron';
import { syncQualityVariance } from '../services/quality-variance-sync/index.js';

if (process.env.QUALITY_VARIANCE_CRON_ENABLED === 'true') {
  cron.schedule('0 4 * * *', () => {
    syncQualityVariance().catch((err) => {
      console.error('[cron] quality-variance-sync failed', err);
    });
  }, { timezone: 'UTC' });
  console.log('[cron] quality-variance-sync registered (04:00 UTC nightly)');
} else {
  console.log('[cron] quality-variance-sync skipped (QUALITY_VARIANCE_CRON_ENABLED=false)');
}
```

- **Pros:** simplest, ~10 KB dep, single deploy target, observable in Railway logs alongside everything else.
- **Cons:** dies on server restart mid-run. Idempotent re-run next night fixes it.

### (b) Railway native cron service

Stand up a second Railway service of type "Cron job", scheduled `0 4 * * *`, whose only command is `curl -X POST https://YOUR-MCP/jobs/quality-variance-sync -H "Authorization: Bearer $MCP_BEARER_TOKEN"`. The MCP server exposes a new `/jobs/quality-variance-sync` route guarded by `requireBearer`.

- **Pros:** scheduling decoupled from app process; survives restarts; trivially re-runnable manually with the same curl.
- **Cons:** second Railway service to manage; one more secret-rotation path; cost bump (negligible).

### (c) Vercel cron pointing at NEMESIS proxying to MCP — DO NOT USE

Defeats the point of hosting the sync on Railway, adds a third secret-rotation path. Listed only so it's explicitly ruled out.

**Recommendation when Phase 2 starts: (a).**

## Files in this directory

| File | Purpose |
|---|---|
| `README.md` | This file. Decision artifact + env contract + cron options. |
| `index.ts` | Stub `syncQualityVariance()` that throws "Not implemented". Phase 2 fills this in. |
| `types.ts` | TypeScript interfaces matching the future `public.pairing_quality_variance` schema. Forward-compat scaffolding only; no logic. |

## What lives where (Phase 2 onward)

When Phase 2 starts, the layout will become:

```
services/quality-variance-sync/
  README.md                 (this file, updated with run-book + reconciliation results)
  index.ts                  syncQualityVariance() main entry, called by cron
  types.ts                  shapes for VarianceRow, MatrixMapRow, etc.
  sources/
    warehouse.ts            mssql connection + the 4 source queries
    retool.ts               pg connection + the 1 coverage query
  compute/
    variance-pivot.ts       TS port of the Retool variancePivot transformer
    constants.ts            5 magic numbers from the spec (frozen)
    __fixtures__/           golden fixtures from a real (clinician, MDS) pair
    __tests__/              parity tests against Retool dashboard output
  upsert.ts                 Supabase upsert + mcp.audit_log write
```

The Supabase migration for `public.pairing_quality_variance` lives in the
NEMESIS repo at `supabase/migrations/011_pairing_quality_variance.sql`
(per the spec). This MCP service consumes that table; it does not own the
schema.

## Cross-references

- Spec: meeting notes from 2026-05-11 with Lisa Ly
- Audit: `~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md`
- Schema target: `public.pairing_quality_variance` (Phase 2)
- Detail UI: `~/Desktop/Cursor/NEMESIS/app/past-analyses/[id]/page.tsx` — already
  renders the variance shape with a "wired but waiting on data" banner; flips
  to live data the moment the first row writes.
