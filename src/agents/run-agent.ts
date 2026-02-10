/**
 * Unified agent runner — dispatches to the scout-then-snipe system.
 * All agents now use the same pattern:
 *   1. Scout: free APIs + Tavily batch search (no Claude)
 *   2. Filter: programmatic price-spread detection
 *   3. Snipe: single Claude call on pre-qualified leads only
 */

import { AgentType } from '@/types';
import { AgentProgressEvent } from './base-agent';
import { runScoutThenSnipe, ScoutSnipeResult } from './scout/runner';

// Re-export for compatibility with existing stream API
export type { AgentProgressEvent };

export interface RunAgentParams {
  agentType: AgentType;
  apiKey: string;
  tavilyApiKey: string;
  config: {
    categories?: string[];
    minProfitCents?: number;
    region?: string;
    pairs?: string[];
    minSpreadPercent?: number;
    eventTypes?: string[];
  };
}

export async function dispatchAgentRun(
  params: RunAgentParams,
  onProgress?: (event: AgentProgressEvent) => void,
): Promise<ScoutSnipeResult> {
  const { agentType, apiKey, tavilyApiKey, config } = params;

  return runScoutThenSnipe(
    { agentType, apiKey, tavilyApiKey },
    config,
    onProgress,
  );
}
