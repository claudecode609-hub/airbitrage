'use client';

/**
 * Agent run state management — uses useSyncExternalStore for performance.
 *
 * Key performance decisions:
 * - Store lives in a ref (not useState) — updates don't re-render the provider
 * - Each useAgentRun(type) subscribes only to its own agent's state slice
 * - Progress array is capped at 10 entries (UI only shows last 5)
 * - Subscribers are notified per-agent, not globally
 */

import { createContext, useContext, useCallback, useRef, useSyncExternalStore } from 'react';
import { AgentType, ACTIVE_AGENTS } from '@/types';
import { ParsedOpportunity } from '@/agents/base-agent';

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentRunState {
  status: 'idle' | 'queued' | 'running' | 'completed' | 'error';
  progress: ProgressEvent[];
  opportunities: ParsedOpportunity[];
  stats: RunStats | null;
  error: string | null;
}

interface ProgressEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

interface RunStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  estimatedCost: number;
}

const MAX_PROGRESS = 10;

const INITIAL_STATE: AgentRunState = {
  status: 'idle',
  progress: [],
  opportunities: [],
  stats: null,
  error: null,
};

// ─── External Store ──────────────────────────────────────────────────

/** Only create store slots for active agents */
const ALL_AGENTS: AgentType[] = ACTIVE_AGENTS;

type AgentRunStore = Record<AgentType, AgentRunState>;
type Listener = () => void;

type GlobalSnapshot = Array<{ type: AgentType; state: AgentRunState }>;

function createStore() {
  const store: AgentRunStore = {} as AgentRunStore;
  for (const t of ALL_AGENTS) {
    store[t] = { ...INITIAL_STATE };
  }

  // Per-agent listener sets — only notify subscribers of the changed agent
  const listeners: Record<string, Set<Listener>> = {};
  for (const t of ALL_AGENTS) {
    listeners[t] = new Set();
  }
  // Global listeners (for dashboard summary)
  listeners['__global__'] = new Set();

  // Cached global snapshot — rebuilt only when an agent is updated.
  // useSyncExternalStore compares snapshots by reference equality,
  // so we MUST return the same object if nothing changed.
  let globalSnapshot: GlobalSnapshot = ALL_AGENTS.map(t => ({ type: t, state: store[t] }));

  function rebuildGlobalSnapshot() {
    globalSnapshot = ALL_AGENTS.map(t => ({ type: t, state: store[t] }));
  }

  function getAgentState(agentType: AgentType): AgentRunState {
    return store[agentType];
  }

  function getGlobalSnapshot(): GlobalSnapshot {
    return globalSnapshot;
  }

  function updateAgent(agentType: AgentType, updater: (prev: AgentRunState) => AgentRunState) {
    store[agentType] = updater(store[agentType]);
    // Rebuild cached global snapshot so useSyncExternalStore detects the change
    rebuildGlobalSnapshot();
    // Notify per-agent listeners
    listeners[agentType]?.forEach(l => l());
    // Notify global listeners
    listeners['__global__']?.forEach(l => l());
  }

  function subscribeAgent(agentType: AgentType, listener: Listener) {
    listeners[agentType]?.add(listener);
    return () => { listeners[agentType]?.delete(listener); };
  }

  function subscribeGlobal(listener: Listener) {
    listeners['__global__']?.add(listener);
    return () => { listeners['__global__']?.delete(listener); };
  }

  return { getAgentState, getGlobalSnapshot, updateAgent, subscribeAgent, subscribeGlobal };
}

// ─── Context ─────────────────────────────────────────────────────────

interface AgentRunContextValue {
  store: ReturnType<typeof createStore>;
  runAgent: (agentType: AgentType, config?: Record<string, unknown>) => void;
  reset: (agentType: AgentType) => void;
}

export const AgentRunContext = createContext<AgentRunContextValue | null>(null);

/**
 * Provider hook — creates the store and SSE connection management.
 * Mount once in dashboard layout via AgentRunProvider.
 */
export function useAgentRunStore() {
  const storeRef = useRef<ReturnType<typeof createStore> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore();
  }
  const externalStore = storeRef.current;

  const eventSourcesRef = useRef<Partial<Record<AgentType, EventSource>>>({});

  const runAgent = useCallback((agentType: AgentType, config?: Record<string, unknown>) => {
    const existing = eventSourcesRef.current[agentType];
    if (existing) existing.close();

    externalStore.updateAgent(agentType, () => ({
      status: 'running',
      progress: [],
      opportunities: [],
      stats: null,
      error: null,
    }));

    try {
      const params = new URLSearchParams({ agentType });
      if (config) params.set('config', JSON.stringify(config));

      const eventSource = new EventSource(`/api/stream?${params}`);
      eventSourcesRef.current[agentType] = eventSource;

      eventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        externalStore.updateAgent(agentType, (prev) => ({
          ...prev,
          status: data.type === 'queued' ? 'queued'
            : data.type === 'started' ? 'running'
            : prev.status,
          // Cap progress array to prevent unbounded growth
          progress: [...prev.progress, { ...data, timestamp: Date.now() }].slice(-MAX_PROGRESS),
        }));
      });

      eventSource.addEventListener('result', (e) => {
        const data = JSON.parse(e.data);
        externalStore.updateAgent(agentType, (prev) => ({
          ...prev,
          opportunities: data.opportunities || [],
          stats: data.stats || null,
          error: data.error || data.abortReason || null,
        }));
      });

      eventSource.addEventListener('done', () => {
        externalStore.updateAgent(agentType, (prev) => ({
          ...prev,
          status: prev.error ? 'error' : 'completed',
        }));
        eventSource.close();
        delete eventSourcesRef.current[agentType];
      });

      eventSource.addEventListener('error', () => {
        if (eventSource.readyState === EventSource.CLOSED) {
          externalStore.updateAgent(agentType, (prev) => ({
            ...prev,
            status: prev.opportunities.length > 0 ? 'completed' : 'error',
            error: prev.error || null,
          }));
        } else {
          externalStore.updateAgent(agentType, (prev) => ({
            ...prev,
            status: 'error',
            error: 'Connection to agent stream lost',
          }));
          eventSource.close();
        }
        delete eventSourcesRef.current[agentType];
      });
    } catch (err) {
      externalStore.updateAgent(agentType, (prev) => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [externalStore]);

  const reset = useCallback((agentType: AgentType) => {
    externalStore.updateAgent(agentType, () => ({ ...INITIAL_STATE }));
  }, [externalStore]);

  return { store: externalStore, runAgent, reset };
}

/**
 * Hook for individual agent tabs — subscribes only to one agent's state.
 * When agent X updates, only components using useAgentRun('X') re-render.
 */
export function useAgentRun(agentType: AgentType) {
  const ctx = useContext(AgentRunContext);
  if (!ctx) {
    throw new Error('useAgentRun must be used within AgentRunProvider');
  }

  const { store, runAgent, reset } = ctx;

  const subscribe = useCallback(
    (listener: () => void) => store.subscribeAgent(agentType, listener),
    [store, agentType],
  );

  const getSnapshot = useCallback(
    () => store.getAgentState(agentType),
    [store, agentType],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const boundRunAgent = useCallback(
    (config?: Record<string, unknown>) => runAgent(agentType, config),
    [runAgent, agentType],
  );

  const boundReset = useCallback(
    () => reset(agentType),
    [reset, agentType],
  );

  return {
    ...state,
    runAgent: boundRunAgent,
    reset: boundReset,
  };
}

/**
 * Hook for dashboard — subscribes to ALL agents but only re-renders
 * when the summary data actually changes (counts, not progress text).
 */
export function useDashboardSummary() {
  const ctx = useContext(AgentRunContext);
  if (!ctx) {
    throw new Error('useDashboardSummary must be used within AgentRunProvider');
  }

  const { store, runAgent } = ctx;

  const subscribe = useCallback(
    (listener: () => void) => store.subscribeGlobal(listener),
    [store],
  );

  // Returns the cached snapshot — same reference until updateAgent() rebuilds it.
  // This is critical: useSyncExternalStore uses Object.is() to compare snapshots,
  // so we must return a stable reference when nothing has changed.
  const getSnapshot = useCallback(
    () => store.getGlobalSnapshot(),
    [store],
  );

  const agentStates = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    agentStates,
    runAgent,
  };
}
