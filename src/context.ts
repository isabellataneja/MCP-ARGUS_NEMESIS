import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestAgentContext = {
  agentName: string | null;
};

export const requestAgentStore = new AsyncLocalStorage<RequestAgentContext>();

export function getRequestAgent(): RequestAgentContext | undefined {
  return requestAgentStore.getStore();
}
