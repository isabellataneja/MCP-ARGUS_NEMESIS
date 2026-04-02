import { config } from 'dotenv'
config({ path: '.env.local' })

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import http from 'http'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

const server = new McpServer({
  name: 'nemesis-argus-bridge',
  version: '1.0.0'
})

// Tool 1 — NEMESIS calls this before every recommendation
server.tool(
  'check_mds_availability',
  { mds_id: z.string() },
  async ({ mds_id }) => {
    const { data, error } = await supabase
      .from('mds_availability')
      .select('*')
      .eq('mds_id', mds_id)
      .single()
    if (error) return { isError: true, content: [{ type: 'text', text: error.message }] }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

// Tool 2 — ARGUS calls this to flag someone unavailable
server.tool(
  'flag_unavailable',
  { mds_id: z.string(), reason: z.string(), expected_return: z.string().optional() },
  async ({ mds_id, reason, expected_return }) => {
    const { error } = await supabase
      .from('mds_availability')
      .update({ is_available: false, leave_reason: reason, expected_return_date: expected_return ?? null })
      .eq('mds_id', mds_id)
    if (error) return { isError: true, content: [{ type: 'text', text: error.message }] }
    return { content: [{ type: 'text', text: 'Updated' }] }
  }
)

// Tool 3 — Both agents call this
server.tool(
  'get_upcoming_holidays',
  { window_days: z.number().default(30) },
  async ({ window_days }) => {
    const future = new Date()
    future.setDate(future.getDate() + window_days)
    const { data, error } = await supabase
      .from('bd_holidays')
      .select('*')
      .gte('holiday_date', new Date().toISOString())
      .lte('holiday_date', future.toISOString())
    if (error) return { isError: true, content: [{ type: 'text', text: error.message }] }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

// HTTP server
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  await transport.handleRequest(req, res)
})

await server.connect(transport)
httpServer.listen(3001, () => console.log('MCP running on port 3001'))