import type { RequestHandler } from 'express';
import { ZodError } from 'zod';

import { runCronusGetNoteContentBulk, runCronusGetUpdatedNotes } from './tools/cronus.js';

/**
 * REST tool endpoint: POST /tools/call with { name, arguments }, responding
 * with the envelope the CRONUS clients expect (MCP_TOOLS_TO_ADD.md):
 *   { ok: true, data } | { ok: false, error: { message, code? } }
 *
 * This is the wire shape lib/mcp/client.ts (Cronus app) and
 * src/notecache/mcpClient.ts (cronus-qa-agents sync) already speak — distinct
 * from the JSON-RPC /mcp endpoint, same bearer token.
 *
 * Status-code contract with those clients: they retry 429/5xx and treat other
 * non-2xx as fatal. So: tool-level failures (unknown tool, invalid arguments,
 * NOT-FOUND-style outcomes) return 200/400 with ok:false (no retry), while
 * unexpected server/database errors return 500 (retryable — a normandy blip
 * should be retried, not cached as a miss).
 *
 * PHI: never log `arguments` or response data — tool name, latency, and error
 * class only.
 */
const TOOL_REGISTRY: Record<string, (args: unknown) => Promise<unknown>> = {
  cronus_getUpdatedNotes: runCronusGetUpdatedNotes,
  cronus_getNoteContentBulk: runCronusGetNoteContentBulk,
};

export const toolsCallHandler: RequestHandler = async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof body.name === 'string' ? body.name : null;

  if (!name || !(name in TOOL_REGISTRY)) {
    res.status(400).json({
      ok: false,
      error: { message: `unknown tool: ${name ?? '(missing name)'}`, code: 'UNKNOWN_TOOL' },
    });
    return;
  }

  const started = Date.now();
  try {
    const data = await TOOL_REGISTRY[name](body.arguments ?? {});
    console.log('[tools/call] tool=%s ok latency_ms=%d', name, Date.now() - started);
    res.json({ ok: true, data });
  } catch (err) {
    const isInputError =
      err instanceof ZodError || (err instanceof Error && err.message.includes('malformed cursor'));
    console.error(
      '[tools/call] tool=%s failed type=%s latency_ms=%d',
      name,
      err instanceof Error ? err.name : typeof err,
      Date.now() - started,
    );
    if (isInputError) {
      res.status(400).json({
        ok: false,
        error: { message: 'invalid arguments', code: 'INVALID_ARGUMENTS' },
      });
      return;
    }
    // Unexpected (likely normandy) failure — 500 so clients retry with backoff.
    // Generic message: no internal details or argument echoes leave the server.
    res.status(500).json({
      ok: false,
      error: { message: 'internal error', code: 'INTERNAL' },
    });
  }
};
