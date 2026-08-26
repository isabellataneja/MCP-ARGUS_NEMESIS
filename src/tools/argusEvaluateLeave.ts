import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { asMcpTextContent, instrumented } from '../instrument.js';
import { db } from '../supabase.js';
import {
  evaluateLeaveBatch,
  evaluateLeaveRequestSchema,
  type EvaluateLeaveRequest,
} from '../evaluateLeave.js';

/**
 * `argus_evaluate_leave` — contract v1 batched leave-probability evaluation
 * for the NEMESIS adhoc coverage-pairing flow. Ported from
 * getathelas/MCP-ARGUS_NEMESIS (feat/argus-evaluate-leave) so it lives on the
 * hub alongside the rest of the fleet tools. This is the ONLY tool exposed to
 * callers presenting ARGUS_EVAL_TOKEN (see auth.ts requireMcpBearer).
 */
export function registerArgusEvaluateLeaveTool(server: McpServer): void {
  const runEvaluateLeave = instrumented(
    'argus',
    'argus_evaluate_leave',
    async (input: EvaluateLeaveRequest) => evaluateLeaveBatch(db, input),
    (out) => ({ results: out.results.length }),
  );

  server.registerTool(
    'argus_evaluate_leave',
    {
      description:
        'Contract v1: batched leave-probability evaluation (1-10 pairings) for NEMESIS adhoc ' +
        'coverage pairing. Echoes request_id; per-pairing leave_probability 0-100 with ' +
        'confidence/reasoning/evidence. Approved leave on the coverage date returns >= 99.5.',
      inputSchema: {
        contract_version: z.literal('1'),
        request_id: z.uuid(),
        coverage_datetime: z.string(),
        pairings: z
          .array(
            z.object({
              pairing_id: z.uuid(),
              candidate_mds_id: z.string(),
              clinician_uid: z.string(),
            }),
          )
          .min(1)
          .max(10),
      },
    },
    async (input) => {
      const parsed = evaluateLeaveRequestSchema.safeParse(input);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Invalid argus_evaluate_leave request: ${parsed.error.message}`,
            },
          ],
        };
      }
      try {
        return asMcpTextContent(await runEvaluateLeave(parsed.data));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: message }],
        };
      }
    },
  );
}
