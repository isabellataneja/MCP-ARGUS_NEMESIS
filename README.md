# MCP ARGUS / NEMESIS bridge

Remote [Model Context Protocol](https://modelcontextprotocol.io) server on **Node 20+** and **TypeScript** (ES modules). It exposes HTTP Streamable MCP at `POST /mcp` for agents hosted on Vercel, with tools that read/write **Supabase** using the **service role** key on the server only. **Bangladesh (`country_code = BD`)** is enforced on every MDS-related select via the query layer.

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

## Supabase schema (stubs)

Tools target placeholder tables; create them (or change the table names in `src/tools/nemesis.ts` and `src/tools/argus.ts`) to match your schema. Every **read** that goes through `scopeBangladesh()` must include a `country_code` column compatible with value `BD`.

| Tool | Stub table |
|------|------------|
| `get_available_mds` | `nemesis_mds_availability` |
| `get_clinician_preferences` | `nemesis_clinician_preferences` |
| `propose_pairing` | `nemesis_pairing_proposals` |
| `get_leave_probability` | `argus_mds_leave_forecasts` |
| `get_historical_leave_patterns` | `argus_mds_leave_history` |
| `flag_high_risk_absences` | `argus_mds_absence_risk` |

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
