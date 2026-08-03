import { Pool } from 'pg';

/**
 * Read-only Postgres pool for the `normandy` source database — used only by
 * the CRONUS note tools (src/tools/cronus.ts). Credentials must be a
 * read-only role: every query these tools run is a SELECT, and the note-cache
 * spec (MCP_TOOLS_TO_ADD.md) requires read-only access to the listed sources.
 *
 * Lazy-initialized so the server still boots (NEMESIS/ARGUS tools unaffected)
 * when NORMANDY_DATABASE_URL is not configured; the cronus tools then fail
 * per-call with a clear error instead of taking the whole process down.
 */
let pool: Pool | null = null;

export function normandyDb(): Pool {
  if (!pool) {
    const url = process.env.NORMANDY_DATABASE_URL?.trim();
    if (!url) {
      throw new Error('Missing required environment variable: NORMANDY_DATABASE_URL');
    }
    pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      // Bounded so a runaway change-index scan cannot hold a production
      // connection open indefinitely; the sync client's per-call timeout is
      // 60s, so give the server a little headroom past that.
      statement_timeout: 90_000,
      ssl: url.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
      application_name: 'mcp-argus-nemesis',
    });
    pool.on('error', (err) => {
      console.error('[normandyDb] idle client error type=%s', err.name);
    });
  }
  return pool;
}
