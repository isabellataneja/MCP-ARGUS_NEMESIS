import 'dotenv/config';

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { requireBearer } from './auth.js';
import { createSupabase } from './supabase.js';
import { registerArgusTools } from './tools/argus.js';
import { registerNemesisTools } from './tools/nemesis.js';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function loadConfig() {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  requireEnv('MCP_BEARER_TOKEN');

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    port: Number(process.env.PORT) || 8080,
  };
}

function createMcpServer(supabase: ReturnType<typeof createSupabase>): McpServer {
  const server = new McpServer(
    {
      name: 'nemesis-argus-bridge',
      version: '1.0.0',
    },
    {
      instructions:
        'Remote MCP bridge for NEMESIS (MDS pairing) and ARGUS (leave prediction). All MDS workforce queries are restricted to Bangladesh (country_code=BD) at the database layer.',
    },
  );
  registerNemesisTools(server, supabase);
  registerArgusTools(server, supabase);
  return server;
}

function main() {
  const config = loadConfig();

  const supabase = createSupabase(config.supabaseUrl, config.supabaseServiceRoleKey);
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // TODO: enable rate limiting for /mcp once limits are tuned for Vercel agent traffic
  // import rateLimit from 'express-rate-limit';
  // const mcpRateLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
  // app.post('/mcp', mcpRateLimiter, requireBearer, handler);

  app.post('/mcp', requireBearer, async (req, res) => {
    const server = createMcpServer(supabase);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      console.error('[mcp] request_failed type=%s', err instanceof Error ? err.name : typeof err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log('[server] listening host=0.0.0.0 port=%d', config.port);
  });
}

main();
