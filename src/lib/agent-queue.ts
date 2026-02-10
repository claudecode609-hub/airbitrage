/**
 * Agent run queue — limits how many agents can run concurrently.
 *
 * Problem: Running all 7 agents at once creates 350+ concurrent HTTP requests
 * (Tavily searches, resale lookups, crypto APIs, RSS feeds, Claude calls),
 * which overwhelms the Node.js process and crashes the server.
 *
 * Solution: Queue agent runs and execute at most 2 concurrently.
 * The remaining agents wait in a FIFO queue and start automatically
 * as slots free up.
 */

import { AgentType } from '@/types';

interface QueuedRun {
  agentType: AgentType;
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

const MAX_CONCURRENT = 2;
const activeRuns = new Map<string, AgentType>();
const queue: QueuedRun[] = [];

let runIdCounter = 0;

/** Get current queue status */
export function getQueueStatus() {
  return {
    active: [...activeRuns.values()],
    queued: queue.map(q => q.agentType),
    activeCount: activeRuns.size,
    queuedCount: queue.length,
  };
}

/** Check if a specific agent is currently running */
export function isAgentRunning(agentType: AgentType): boolean {
  return [...activeRuns.values()].includes(agentType);
}

/**
 * Enqueue an agent run. Returns a promise that resolves when the run
 * actually starts (not when it finishes). The execute callback does
 * the real work.
 *
 * Returns: { position, started } where position is 0 if starting immediately
 */
export function enqueueAgentRun(
  agentType: AgentType,
  execute: () => Promise<void>,
): { position: number; started: Promise<void> } {
  // If already running this agent, reject
  if (isAgentRunning(agentType)) {
    return {
      position: -1,
      started: Promise.reject(new Error(`${agentType} agent is already running`)),
    };
  }

  // Also remove any existing queued run for this agent type
  const existingIdx = queue.findIndex(q => q.agentType === agentType);
  if (existingIdx >= 0) {
    const removed = queue.splice(existingIdx, 1)[0];
    removed.reject(new Error('Replaced by new run'));
  }

  // Can we start immediately?
  if (activeRuns.size < MAX_CONCURRENT) {
    const runId = `run_${++runIdCounter}`;
    activeRuns.set(runId, agentType);

    const wrappedExecute = execute().finally(() => {
      activeRuns.delete(runId);
      processQueue();
    });

    return { position: 0, started: Promise.resolve() };
  }

  // Otherwise, queue it
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const started = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  queue.push({ agentType, execute, resolve, reject });

  return { position: queue.length, started };
}

/** Process the queue — start next run if there's a free slot */
function processQueue() {
  while (activeRuns.size < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift()!;
    const runId = `run_${++runIdCounter}`;
    activeRuns.set(runId, next.agentType);

    next.resolve(); // Signal that this run has started

    next.execute().finally(() => {
      activeRuns.delete(runId);
      processQueue();
    });
  }
}
