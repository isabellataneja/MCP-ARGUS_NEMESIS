import type { RequestHandler } from 'express';
import { z } from 'zod';
import { mcpDb } from './supabase.js';

/**
 * Fleet run-report ingest. Lets non-native agents (cronus, ehr-inbox,
 * hephaestus, …) record a run into `mcp.agent_runs` without holding any DB
 * credentials — they POST here with the shared MCP bearer token, exactly like
 * the EHR Inbox agent already POSTs to the EHR Hub.
 *
 * Native NEMESIS/ARGUS tool calls are logged separately by instrument.ts; this
 * endpoint is for everyone else. Rows are stored with agent='external' and the
 * caller's real slug in agent_slug, so per-native-agent summaries stay clean.
 *
 * Telemetry must be PII-free: send shapes/counts, never patient/clinician
 * content. The endpoint does not inspect payloads, so the caller is responsible.
 */

const jsonRecord = z.record(z.string(), z.unknown());

const ReportSchema = z.object({
  agent: z.string().min(1).max(64), // registry slug: cronus | ehr-inbox | hephaestus | ...
  tool_name: z.string().min(1).max(128),
  success: z.boolean(),
  latency_ms: z.number().int().nonnegative().max(3_600_000).optional(),
  error_message: z.string().max(2000).nullish(),
  input_shape: jsonRecord.optional(),
  output_summary: jsonRecord.optional(),
  source_project: z.string().max(128).optional(),
  caller: z.string().max(128).optional(),
  run_id: z.string().uuid().optional(),
});

export const reportHandler: RequestHandler = async (req, res) => {
  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_report', issues: parsed.error.issues });
    return;
  }
  const b = parsed.data;

  const row: Record<string, unknown> = {
    agent: 'external',
    agent_slug: b.agent,
    tool_name: b.tool_name,
    input_shape: b.input_shape ?? {},
    output_summary: b.output_summary ?? {},
    success: b.success,
    error_message: b.error_message ?? null,
    latency_ms: b.latency_ms ?? null,
    caller: b.caller ?? b.agent,
    source_project: b.source_project ?? null,
  };
  if (b.run_id) row.run_id = b.run_id;

  const { error } = await mcpDb.from('agent_runs').insert(row);
  if (error) {
    console.error('[report] agent_runs insert failed slug=%s code=%s', b.agent, error.code ?? 'n/a');
    res.status(502).json({ error: 'insert_failed' });
    return;
  }

  // Best-effort: mark the registered agent as live + freshen last_seen. If the
  // slug isn't registered this updates 0 rows — the run is still logged.
  void mcpDb
    .from('agents')
    .update({ last_seen: new Date().toISOString(), status: 'live' })
    .eq('slug', b.agent)
    .then(({ error: uErr }) => {
      if (uErr) console.error('[report] agents last_seen update failed slug=%s code=%s', b.agent, uErr.code ?? 'n/a');
    });

  res.status(202).json({ ok: true });
};
