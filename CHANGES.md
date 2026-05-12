# CHANGES

## 2026-05-12 — Cron decision lock-in + dormant wire-up (Phase 1.6)

**Decision artifact + plumbing only. Still no sync logic. Cron stays off by default.**

Locks the cron-hosting decision deferred at the end of Phase 1.5 and wires
the registration dormant. With `QUALITY_VARIANCE_CRON_ENABLED=false`
(default), nothing fires and the stub is never invoked. Phase 2 flips the
flag once `syncQualityVariance()` does real work.

### Decision
- **Option (a) `node-cron` inside `src/index.ts` — locked.** Rationale unchanged
  from the Phase 1.5 README: simplest, single deploy target, observable in
  Railway logs alongside the rest of the MCP service. Options (b) Railway
  native cron service and (c) Vercel proxy remain documented as alternatives.

### Added
- `node-cron` (^4.2.0) to `package.json` dependencies.
- `@types/node-cron` (^3.0.11) to devDependencies.
- `services/**/*.ts` to `tsconfig.json` include — the stub is now statically
  importable from `src/`. Phase 1.5 had deliberately deferred this
  "inclusion strategy"; Phase 1.6 picks the simplest path (single tsc pass,
  full type-checking).
- `registerQualityVarianceCron()` in `src/index.ts`, called after
  `app.listen()`. Logs `[cron] … registered` or `[cron] … skipped` depending
  on the flag. Errors from `syncQualityVariance()` are caught + logged at the
  cron boundary so a failed fire never crashes the server.
- `QUALITY_VARIANCE_CRON_ENABLED` in `.env.example`, defaulting `false` with
  a comment explaining the Phase 2 dependency.

### Changed
- `tsconfig.json`: `rootDir` moved from `"src"` to `"."` so `services/` can
  sit alongside `src/` under the same compile root. Compiled output now
  lives at `dist/src/...` (and `dist/services/...` when included).
- `package.json` `start` script: `node dist/index.js` → `node dist/src/index.js`
  to match the new dist layout. Railway's `npm start` picks this up
  automatically; no `railway.json` change needed.

### Safety properties
- Default-off: setting nothing keeps behaviour identical to Phase 1.5.
- Loud-fail: if the flag is flipped on before Phase 2 ships, the stub
  throws `Not implemented`; the error is logged with type + message and
  the server stays up. No silent no-op write path.
- Idempotent re-run: schedule is `0 4 * * * UTC`. If a fire crashes
  partway, the next night's run reconciles (matches the Phase 1 audit
  design — upsert on `(sf_id, mds_uid, window_end_date)`).

### Not added (deliberate, still gated on creds)
- No mssql / pg driver deps — Phase 2.
- No Supabase migration `011_pairing_quality_variance.sql` — owned by the
  NEMESIS repo per the spec; Phase 2 lands it there.
- No `RETOOL_DB_CONNECTION_STRING` / `WAREHOUSE_MSSQL_*` plumbing —
  Phase 2, blocked on creds from Moontasir + Bella.

### Cross-references
- Phase 1 audit: `~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md`
- Decision detail: `services/quality-variance-sync/README.md` (cron section,
  updated to reflect the lock-in)

## 2026-05-11 — Quality Variance Sync scaffolding (Phase 1.5)

**Scaffolding only. Phase 2 starts when warehouse creds land.**

Adds the home for the upcoming nightly quality-variance sync job + the
documentation that locks the hosting decision (this MCP service, not a new
Railway service). No SQL, no variance compute, no Supabase migration, no
scoring changes — those are Phase 2+ and gated on credentials.

### Added
- `services/quality-variance-sync/README.md` — decision artifact, env var
  contract (no real values), cron-options doc, and Phase-by-Phase status.
- `services/quality-variance-sync/index.ts` — stub `syncQualityVariance()`
  that throws "Not implemented". Phase 2 replaces the throw with the real
  impl per the spec.
- `services/quality-variance-sync/types.ts` — TypeScript shapes for the
  future `public.pairing_quality_variance` row + intermediate matrix-map /
  variance-pivot rows. Forward-compat scaffolding only.

### Not added (deliberate)
- No cron registration in `src/index.ts`. Probe found no cron infrastructure
  exists on this service yet; per audit instruction "do not invent one,"
  the README documents three options (node-cron / Railway native cron /
  Vercel proxy) and recommends node-cron when Phase 2 starts.
- No mssql / pg driver dep added to `package.json`. Those land with the
  Phase 2 sync logic.
- No tsconfig change. `services/` is outside the current `src/` include
  scope so the stub is invisible to `tsc`. Intentional: keeps the
  scaffolding isolated until the Phase 2 implementer picks an inclusion
  strategy.

### Cross-references
- Spec: 2026-05-11 meeting with Lisa Ly
- Phase 1 audit (lives in the NEMESIS Next.js repo):
  `~/Desktop/Cursor/NEMESIS/docs/quality-variance-integration-audit.md`
- Forward-compatible UI: `~/Desktop/Cursor/NEMESIS/app/past-analyses/[id]/page.tsx`
  already renders the variance shape with a "wired but waiting on data"
  banner; flips to live data the moment the first row writes.
