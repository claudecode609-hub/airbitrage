'use client';

import { AgentRunContext, useAgentRunStore } from '@/hooks/useAgentRun';

export function AgentRunProvider({ children }: { children: React.ReactNode }) {
  const store = useAgentRunStore();

  return (
    <AgentRunContext.Provider value={store}>
      {children}
    </AgentRunContext.Provider>
  );
}
