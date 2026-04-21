import { getRequestAgent } from './context.js';
import { mcpDb } from './supabase.js';

export type AgentKind = 'nemesis' | 'argus' | 'forecaster' | 'integrity';

/**
 * Per-field value kinds for `agent_runs.input_shape`. No key whitelist.
 * `input` is the same object reference passed to the tool handler (i.e. MCP
 * `validateToolInput` / Zod output). We walk **all own keys** via `Reflect.ownKeys`
 * (string keys; symbol keys skipped for JSON-safe column storage).
 */
function describeShape(input: unknown): Record<string, string> {
  if (input === null || input === undefined) return { _keys: '' };
  if (typeof input !== 'object') return { _keys: '', _nonObject: typeof input };
  const obj = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(obj)
    .filter((k): k is string => typeof k === 'string')
    .sort();
  const out: Record<string, string> = { _keys: keys.join(',') };
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) out[k] = `array[${v.length}]`;
    else if (v === null) out[k] = 'null';
    else if (v === undefined) out[k] = 'undefined';
    else out[k] = typeof v;
  }
  return out;
}

export function asMcpTextContent(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

/**
 * Wraps a tool handler with `mcp.agent_runs` logging (shapes only, no PII).
 * Caller name is taken from `X-Agent-Name` via request context when present.
 */
export function instrumented<TIn, TOut>(
  agent: AgentKind,
  toolName: string,
  handler: (input: TIn) => Promise<TOut>,
  summarize: (output: TOut) => Record<string, unknown> = () => ({}),
): (input: TIn) => Promise<TOut> {
  return async (input: TIn): Promise<TOut> => {
    const started = Date.now();
    let success = false;
    let errorMessage: string | null = null;
    let output: TOut | undefined;

    try {
      output = await handler(input);
      success = true;
      return output;
    } catch (e: unknown) {
      errorMessage = e instanceof Error ? e.message : 'unknown';
      throw e;
    } finally {
      const caller = getRequestAgent()?.agentName ?? null;
      const row = {
        agent,
        tool_name: toolName,
        input_shape: describeShape(input),
        output_summary: success && output ? summarize(output) : {},
        success,
        error_message: errorMessage,
        latency_ms: Date.now() - started,
        caller: caller ?? null,
      };
      void mcpDb
        .from('agent_runs')
        .insert(row)
        .then(
          ({ error }) => {
            if (error) {
              console.error('[instrument] agent_runs write failed:', {
                tool: toolName,
                code: error.code,
                message: error.message,
                hint: error.hint,
                details: error.details,
              });
            }
          },
          (err) => {
            console.error(
              '[instrument] agent_runs write threw:',
              (err as { message?: string } | undefined)?.message ?? String(err),
            );
          },
        );
    }
  };
}
