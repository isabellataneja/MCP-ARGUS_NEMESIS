# MCP ARGUS / NEMESIS bridge

Remote [Model Context Protocol](https://modelcontextprotocol.io) server on **Node 20+** and **TypeScript** (ES modules). It exposes HTTP Streamable MCP at `POST /mcp` for agents hosted on Vercel, with tools that read/write **Supabase** using the **service role** key on the server only.

**Region scoping** — Every NEMESIS / ARGUS tool accepts an optional `region` argument and resolves it via `src/filters.ts`. Default is `AX-BD-Dhaka` (override with `MCP_DEFAULT_REGION`). Allowed regions: `AX-BD-Dhaka`, `AX-IN-Bangalore`, `IN-IDS-Mohali`, `IN-IDS-Noida`, `SL-Medsource-Colombo`, `AX-US-San Francisco`. Filtering uses region-prefix matching on `clinician_profile_info.scribe_partner_site` (e.g. `AX-BD-%`) and exact match on `mds_profile_info.service_provider`.

## Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only; full DB access — never expose to browsers or MCP clients |
| `MCP_BEARER_TOKEN` | Shared secret; clients send `Authorization: Bearer <token>` |
| `PORT` | Listen port (Railway injects `PORT` automatically) |

The process **exits on startup** if any of `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or `MCP_BEARER_TOKEN` is missing.

## Local development

```bash
npm install
cp .env.example .env
# edit .env
npm run dev
```

- Health: `GET http://localhost:8080/health` → `{ "ok": true }`
- MCP: `POST http://localhost:8080/mcp` with `Authorization: Bearer …` and a Streamable HTTP MCP body.

## Build & run (production)

```bash
npm run build
npm start
```

## Deploy on Railway

1. Create a new Railway service from this repository (or connect the GitHub repo).
2. Under **Variables**, add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `MCP_BEARER_TOKEN` (same semantics as above).
3. **Generate domain** (or attach a custom domain) for the service so you have a public `https://…` base URL.
4. Deploy. `railway.json` sets:
   - **NIXPACKS** builder
   - **Start command** `npm start`
   - **Health check** path `/health`
   - **Restart policy** `ON_FAILURE`

Railway runs `npm install` and `npm run build` via Nixpacks; the `build` script must succeed (TypeScript → `dist/`).

## Supabase schema

Tools target tables in the shared `public` schema:

| Domain | Tables read | Tables written |
|---|---|---|
| Directory (`src/tools/directory.ts`) | `mds_profile_info`, `clinician_profile_info`, regional holiday tables | — |
| NEMESIS pairing (`src/tools/nemesis.ts`) | `mds_profile_info`, `clinician_profile_info`, `clinician_mds_pairings`, `pairing_history`, `nemesis_note_log` | `feedback_log` (proposals + ratings) |
| NEMESIS feedback (`src/tools/feedback.ts`) | `feedback_log`, `pairing_history` | — |
| ARGUS leave/coverage (`src/tools/argus.ts`) | `mds_availability`, `argus_leave_entries`, `argus_coverage_gaps`, `daily_coverage_plan` | `argus_daily_coverage_forecast`, `argus_coverage_gaps` |
| Observability (`src/instrument.ts`) | — | `mcp.agent_runs`, `mcp.audit_log` |

`feedback_log` and `pairing_history` need `override_reason_category` (migration 009+) for category-aware learning; the categorizer falls back to free-text parsing on rows without it.

## Vercel / agent client configuration

Point your MCP client at the Railway URL and send the bearer token on every MCP request (not in the tool payload):

```json
{
  "mcpServers": {
    "nemesis-argus": {
      "url": "https://YOUR-RAILWAY-DOMAIN/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

Exact client shape depends on your MCP library; the requirement is an **`Authorization: Bearer`** header matching `MCP_BEARER_TOKEN`.

## Security notes

- **Service role** bypasses Row Level Security — keep the key server-side only.
- Tool handlers **throw** on Supabase errors; they **do not** log row contents (only counts / column key names).
- **Rate limiting** for `POST /mcp` is prepared but commented in `src/index.ts` (`express-rate-limit`); tune limits before enabling.

## Scripts

| Script | Command |
|--------|---------|
| `dev` | `tsx watch src/index.ts` |
| `build` | `tsc` → `dist/` |
| `start` | `node dist/index.js` |
