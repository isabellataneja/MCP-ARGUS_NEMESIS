import 'dotenv/config';

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { requireBearer } from './auth.js';
import { requestAgentStore } from './context.js';
import { registerAllTools } from './register.js';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function loadConfig() {
  requireEnv('MCP_BEARER_TOKEN');
  return {
    port: Number(process.env.PORT) || 8080,
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'nemesis-argus-bridge',
      version: '1.0.0',
    },
    {
      instructions:
        'Remote MCP bridge for NEMESIS (MDS pairing) and ARGUS (coverage / leave). Tools scope MDS rows by service_provider and clinicians by derived scribe_partner_site pattern; optional `region` on each tool (default MCP_DEFAULT_REGION). Invalid explicit `region` values throw. Holiday listing uses get_regional_holidays; get_bd_holidays is a BD-only alias. Set MCP_HOLIDAYS_HAVE_REGION=true after adding holidays.region in SQL. Use get_mds_profile with the correct region for pairing flows.',
    },
  );
  registerAllTools(server);
  return server;
}

function main() {
  const config = loadConfig();

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
    const raw = req.headers['x-agent-name'];
    const agentName = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;

    await requestAgentStore.run({ agentName }, async () => {
      const server = createMcpServer();
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
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log('[server] listening host=0.0.0.0 port=%d', config.port);
  });
}

main();
