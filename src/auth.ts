import type { RequestHandler } from 'express';

const BEARER_PREFIX = 'Bearer ';

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
