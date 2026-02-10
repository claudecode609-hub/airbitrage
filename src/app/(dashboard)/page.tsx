'use client';

import { useMemo, useCallback, memo } from 'react';
import { StatCard } from '@/components/dashboard/stat-card';
import { AgentCard } from '@/components/agents/agent-card';
import { OpportunityCard } from '@/components/opportunities/opportunity-card';
import { EmptyState } from '@/components/shared/empty-state';
import { formatCents } from '@/lib/utils';
import { useDashboardSummary } from '@/hooks/useAgentRun';
import { AGENT_TYPES, ACTIVE_AGENTS, AgentType, Opportunity } from '@/types';

/**
 * Dashboard home — subscribes to ALL agents via useDashboardSummary().
 * Heavy computations are memoized to avoid recomputing on every progress tick.
 */
export default function DashboardHome() {
  const { agentStates, runAgent } = useDashboardSummary();

  // Collect all opportunities across all agents
  const allOpportunities = useMemo<Opportunity[]>(() =>
    agentStates.flatMap(({ type, state }) =>
      state.opportunities.map((o, i) => ({
        id: `live-${type}-${i}`,
        agentRunId: 'live',
        agentType: type,
        userId: 'user',
        title: o.title,
        description: o.description,
        buyPrice: o.buyPrice,
        buySource: o.buySource,
        buyUrl: o.buyUrl,
        sellPrice: o.sellPrice,
        sellSource: o.sellSource,
        sellUrl: o.sellUrl,
        estimatedProfit: o.estimatedProfit,
        fees: o.fees,
        confidence: o.confidence,
        riskNotes: o.riskNotes,
        reasoning: o.reasoning,
        status: 'new' as const,
        actualBuyPrice: null,
        actualSellPrice: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      }))
    ),
    [agentStates],
  );

  const totalProfit = useMemo(
    () => allOpportunities.reduce((sum, o) => sum + o.estimatedProfit, 0),
    [allOpportunities],
  );

  const agentsRunning = useMemo(
    () => agentStates.filter(a => a.state.status === 'running').length,
    [agentStates],
  );

  const agentsQueued = useMemo(
    () => agentStates.filter(a => a.state.status === 'queued').length,
    [agentStates],
  );

  const topOpp = useMemo(
    () => [...allOpportunities].sort((a, b) => b.estimatedProfit - a.estimatedProfit)[0] ?? null,
    [allOpportunities],
  );

  const recentOpps = useMemo(
    () => [...allOpportunities].sort((a, b) => b.confidence - a.confidence).slice(0, 8),
    [allOpportunities],
  );

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Dashboard</h1>
        <p className="text-sm text-[var(--text-tertiary)]">
          {ACTIVE_AGENTS.length} agents ready
          {agentsRunning > 0 && ` · ${agentsRunning} running`}
          {agentsQueued > 0 && ` · ${agentsQueued} queued`}
          {allOpportunities.length > 0 && ` · ${allOpportunities.length} opportunities found`}
          {agentsRunning === 0 && agentsQueued === 0 && allOpportunities.length === 0 && ' · Run an agent to start finding opportunities'}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="New Opportunities"
          value={allOpportunities.length.toString()}
          accentColor="var(--color-accent)"
        />
        <StatCard
          label="Est. Total Profit"
          value={totalProfit > 0 ? formatCents(totalProfit) : '$0'}
          accentColor="var(--color-profit)"
        />
        <StatCard
          label="Agents Running"
          value={`${agentsRunning + agentsQueued} / ${ACTIVE_AGENTS.length}`}
          detail={agentsQueued > 0 ? `${agentsQueued} queued` : undefined}
        />
        <StatCard
          label="Top Opportunity"
          value={topOpp ? formatCents(topOpp.estimatedProfit) : '—'}
          detail={topOpp ? topOpp.title.slice(0, 40) : 'Run agents to find opportunities'}
        />
      </div>

      {/* Agent Grid */}
      <div>
        <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-3 uppercase tracking-wider">Your Agents</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {agentStates.map(({ type, state }) => (
            <DashboardAgentCard
              key={type}
              agentType={type}
              liveStatus={state.status}
              liveOpportunities={state.opportunities.length}
              runAgent={runAgent}
            />
          ))}
        </div>
      </div>

      {/* Recent Opportunities */}
      <div>
        <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-3 uppercase tracking-wider">
          Recent Opportunities {allOpportunities.length > 0 && `(${allOpportunities.length})`}
        </h2>
        {recentOpps.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="No opportunities yet"
            description="Run your agents to start discovering arbitrage opportunities across different markets."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {recentOpps.map((opp) => (
              <OpportunityCard key={opp.id} opportunity={opp} showAgentType />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Wrapper that creates a stable onRun callback per agent type.
 * Without this, every AgentCard would get a new onRun function on every render.
 */
const DashboardAgentCard = memo(function DashboardAgentCard({
  agentType,
  liveStatus,
  liveOpportunities,
  runAgent,
}: {
  agentType: AgentType;
  liveStatus: 'idle' | 'queued' | 'running' | 'completed' | 'error';
  liveOpportunities: number;
  runAgent: (agentType: AgentType) => void;
}) {
  const handleRun = useCallback(() => runAgent(agentType), [runAgent, agentType]);

  return (
    <AgentCard
      agentType={agentType}
      liveStatus={liveStatus}
      liveOpportunities={liveOpportunities}
      onRun={handleRun}
    />
  );
});
