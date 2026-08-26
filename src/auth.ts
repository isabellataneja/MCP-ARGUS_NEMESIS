import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'crypto';

const BEARER_PREFIX = 'Bearer ';

function presentedToken(header: unknown): string | null {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null;
  const t = header.slice(BEARER_PREFIX.length);
  return t.length > 0 ? t : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validates `Authorization: Bearer <token>` against MCP_BEARER_TOKEN.
 * Use on POST /mcp only; keep /health unauthenticated for platform probes.
 */
export const requireBearer: RequestHandler = (req, res, next) => {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = header.slice(BEARER_PREFIX.length);
  if (token.length === 0 || token !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
};

/**
 * Scope granted to the presented /mcp bearer. `full` (MCP_BEARER_TOKEN) sees
 * every tool; `argus_eval` (ARGUS_EVAL_TOKEN, held by NEMESIS adhoc) sees only
 * `argus_evaluate_leave` — same least-privilege idea as MCP_REPORT_TOKEN.
 */
export type McpScope = 'full' | 'argus_eval';

/**
 * Auth for POST /mcp. Accepts MCP_BEARER_TOKEN (full toolset) or
 * ARGUS_EVAL_TOKEN (argus_evaluate_leave only); sets res.locals.mcpScope so
 * the handler can register the matching toolset. Constant-time; fail-closed.
 */
export const requireMcpBearer: RequestHandler = (req, res, next) => {
  const fullToken = process.env.MCP_BEARER_TOKEN;
  const evalToken = process.env.ARGUS_EVAL_TOKEN;
  if (!fullToken) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  const token = presentedToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (constantTimeEquals(token, fullToken)) {
    res.locals.mcpScope = 'full' satisfies McpScope;
    next();
    return;
  }
  if (evalToken && constantTimeEquals(token, evalToken)) {
    res.locals.mcpScope = 'argus_eval' satisfies McpScope;
    next();
    return;
  }

  res.status(401).json({ error: 'unauthorized' });
};

/**
 * Auth for POST /report only. Accepts a dedicated least-privilege
 * MCP_REPORT_TOKEN (what the fleet agents hold) OR the full MCP_BEARER_TOKEN
 * (admin). This lets cronus / ehr-inbox / hephaestus write telemetry WITHOUT a
 * token that can also invoke the NEMESIS/ARGUS tools on /mcp — smaller blast
 * radius if any agent's env leaks. Constant-time comparison; fail-closed.
 */
export const requireReportBearer: RequestHandler = (req, res, next) => {
  const reportToken = process.env.MCP_REPORT_TOKEN;
  const fullToken = process.env.MCP_BEARER_TOKEN;
  if (!reportToken && !fullToken) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  const token = presentedToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const ok =
    (!!reportToken && constantTimeEquals(token, reportToken)) ||
    (!!fullToken && constantTimeEquals(token, fullToken));
  if (!ok) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
};
