# CHANGES

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
