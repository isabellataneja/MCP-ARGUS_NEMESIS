import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerArgusTools } from './tools/argus.js';
import { registerDirectoryTools } from './tools/directory.js';
import { registerNemesisTools } from './tools/nemesis.js';
import { registerOrchestrationTools } from './tools/orchestration.js';

export function registerAllTools(server: McpServer): void {
  registerDirectoryTools(server);
  registerNemesisTools(server);
  registerArgusTools(server);
  registerOrchestrationTools(server);
}
