import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerArgusEvaluateLeaveTool } from './tools/argusEvaluateLeave.js';
import { registerArgusTools } from './tools/argus.js';
import { registerContextTools } from './tools/context.js';
import { registerCronusTools } from './tools/cronus.js';
import { registerDirectoryTools } from './tools/directory.js';
import { registerFeedbackTools } from './tools/feedback.js';
import { registerNemesisTools } from './tools/nemesis.js';
import { registerOrchestrationTools } from './tools/orchestration.js';

export function registerAllTools(server: McpServer): void {
  registerDirectoryTools(server);
  registerNemesisTools(server);
  registerFeedbackTools(server);
  registerContextTools(server);
  registerArgusTools(server);
  registerArgusEvaluateLeaveTool(server);
  registerOrchestrationTools(server);
  registerCronusTools(server);
}
