import { createClient } from '@supabase/supabase-js';

const opts = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const supabaseUrl = requireEnv('SUPABASE_URL');
const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/** Production `public` schema (MDS/clinician/ARGUS/NEMESIS tables). */
export const db = createClient(supabaseUrl, supabaseServiceRoleKey, {
  ...opts,
  db: { schema: 'public' },
});

/** Observability `mcp` schema (`agent_runs`, `audit_log`). */
export const mcpDb = createClient(supabaseUrl, supabaseServiceRoleKey, {
  ...opts,
  db: { schema: 'mcp' },
});
