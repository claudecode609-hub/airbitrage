'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/dashboard/stat-card';
import { StatusDot } from '@/components/shared/status-dot';
import { OpportunityCard } from '@/components/opportunities/opportunity-card';
import { EmptyState } from '@/components/shared/empty-state';
import { formatCents, timeAgo } from '@/lib/utils';
import { useAgentRun } from '@/hooks/useAgentRun';
import { Agent, Opportunity, AgentRun, AGENT_TYPES, AgentType } from '@/types';
import { ErrorBoundary } from '@/components/shared/error-boundary';

interface AgentTabViewProps {
  agentType: AgentType;
  agent: Agent | undefined;
  opportunities: Opportunity[];
  runs: AgentRun[];
}

type SubTab = 'feed' | 'controls' | 'history';

export function AgentTabView(props: AgentTabViewProps) {
  return (
    <ErrorBoundary>
      <AgentTabViewInner {...props} />
    </ErrorBoundary>
  );
}

function AgentTabViewInner({ agentType, agent, opportunities, runs }: AgentTabViewProps) {
  const [activeTab, setActiveTab] = useState<SubTab>('feed');
  const info = AGENT_TYPES[agentType];
  const agentRun = useAgentRun(agentType);

  // Convert live-discovered opportunities into full Opportunity objects
  const liveOpps: Opportunity[] = agentRun.opportunities.map((o, i) => ({
    id: `live-${i}`,
    agentRunId: 'live',
    agentType,
    userId: 'user',
    title: o.title,
    description: o.description,
    buyPrice: o.buyPrice,
    buySource: o.buySource,
    buyUrl: o.buyUrl,
    sellPrice: o.sellPrice,
    sellSource: o.sellSource,
    sellUrl: o.sellUrl,
    sellPriceType: o.sellPriceType || 'estimated',
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
  }));

  const allOpportunities = [...liveOpps, ...opportunities];
  const totalProfit = allOpportunities.reduce((sum, o) => sum + o.estimatedProfit, 0);
  const newOpps = allOpportunities.filter(o => o.status === 'new');
  const avgConfidence = allOpportunities.length > 0
    ? Math.round(allOpportunities.reduce((sum, o) => sum + o.confidence, 0) / allOpportunities.length)
    : 0;

  const isRunning = agentRun.status === 'running';
  const isQueued = agentRun.status === 'queued';
  const isBusy = isRunning || isQueued;

  const handleRun = () => {
    agentRun.runAgent();
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] text-lg"
            style={{ background: info.color + '18' }}
          >
            {info.icon}
          </span>
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{info.name}</h1>
            <p className="text-xs text-[var(--text-tertiary)]">{info.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {(agent || isBusy) && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <StatusDot status={isRunning ? 'running' : isQueued ? 'queued' : (agent?.status || 'idle')} />
              <span className="capitalize">{isQueued ? 'queued' : isRunning ? 'running' : agent?.status}</span>
              {agent?.lastRunAt && !isBusy && <span className="text-[var(--text-tertiary)]">· {timeAgo(agent.lastRunAt)}</span>}
            </div>
          )}
          <Button size="md" disabled={isBusy} onClick={handleRun}>
            {isQueued ? 'Queued…' : isRunning ? 'Running…' : 'Run Now'}
          </Button>
        </div>
      </div>

      {/* Live progress indicator */}
      {isBusy && agentRun.progress.length > 0 && (
        <Card className="space-y-2 border-l-2" style={{ borderLeftColor: info.color }}>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full animate-pulse-dot" style={{ background: info.color }} />
            <span className="text-xs text-[var(--text-secondary)]">
              {agentRun.progress[agentRun.progress.length - 1].message}
            </span>
          </div>
          {agentRun.progress.length > 1 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {agentRun.progress.slice(-5).map((p, i) => (
                <div key={i} className="text-[10px] text-[var(--text-tertiary)] pl-4">
                  {p.message}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Run result summary */}
      {agentRun.status === 'completed' && agentRun.stats && (
        <Card className="flex items-center justify-between border-l-2 border-l-[var(--color-profit)]">
          <div className="text-xs text-[var(--text-secondary)]">
            Found <span className="text-[var(--color-profit)] font-medium">{agentRun.opportunities.length} opportunities</span>
            {' · '}{(agentRun.stats.totalInputTokens + agentRun.stats.totalOutputTokens).toLocaleString()} tokens
            {' · '}{agentRun.stats.totalToolCalls} tool calls
            {' · '}${agentRun.stats.estimatedCost.toFixed(4)} cost
          </div>
          <Button variant="ghost" size="sm" onClick={agentRun.reset}>Dismiss</Button>
        </Card>
      )}

      {/* Run error */}
      {agentRun.status === 'error' && agentRun.error && (
        <Card className="border-l-2 border-l-[var(--color-danger)]">
          <div className="text-xs text-[var(--color-danger)]">{agentRun.error}</div>
          <Button variant="ghost" size="sm" onClick={agentRun.reset} className="mt-2">Dismiss</Button>
        </Card>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Opportunities" value={newOpps.length.toString()} detail={`${allOpportunities.length} total`} accentColor="var(--color-accent)" />
        <StatCard label="Est. Profit" value={formatCents(totalProfit)} accentColor="var(--color-profit)" />
        <StatCard label="Avg Confidence" value={`${avgConfidence}%`} />
        <StatCard label="Runs" value={(agent?.totalRuns ?? 0).toString()} detail={`$${(agent?.lastRunCost ?? 0).toFixed(2)} last cost`} />
      </div>

      {/* Sub Tabs */}
      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {(['feed', 'controls', 'history'] as SubTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm capitalize transition-colors relative cursor-pointer ${
              activeTab === tab
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {tab === 'feed' ? `Feed (${newOpps.length})` : tab}
            {activeTab === tab && (
              <span
                className="absolute bottom-0 left-4 right-4 h-[2px] rounded-full"
                style={{ background: info.color }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'feed' && (
        <div>
          {allOpportunities.length === 0 ? (
            <EmptyState
              icon={info.icon}
              title="No opportunities yet"
              description={`Run the ${info.name} to start finding arbitrage opportunities.`}
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {allOpportunities
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map((opp) => (
                  <OpportunityCard key={opp.id} opportunity={opp} showAgentType={false} />
                ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'controls' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="space-y-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Agent Configuration</h3>
            {agent?.config && (
              <div className="space-y-3">
                <ConfigRow label="Categories" value={agent.config.categories.join(', ')} />
                <ConfigRow label="Min Profit" value={formatCents(agent.config.minProfit)} />
                {agent.config.region && <ConfigRow label="Region" value={agent.config.region as string} />}
                <ConfigRow label="Risk Tolerance" value={agent.config.riskTolerance} />
              </div>
            )}
            <Button variant="secondary" size="sm">Edit Configuration</Button>
          </Card>

          <Card className="space-y-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Schedule</h3>
            {agent?.schedule ? (
              <div className="space-y-3">
                <ConfigRow label="Status" value={agent.schedule.enabled ? 'Active' : 'Paused'} />
                <ConfigRow label="Frequency" value={agent.schedule.interval} />
                {agent.schedule.time && <ConfigRow label="Time" value={agent.schedule.time} />}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-tertiary)]">No schedule configured.</p>
            )}
            <Button variant="secondary" size="sm">Edit Schedule</Button>
          </Card>

          <Card className="lg:col-span-2 space-y-3">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Sources</h3>
            <div className="flex flex-wrap gap-2">
              {info.sources.map((source) => (
                <Badge key={source} variant="default">{source}</Badge>
              ))}
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'history' && (
        <div>
          {runs.length === 0 ? (
            <EmptyState
              icon="📋"
              title="No runs yet"
              description="Run the agent to see execution history here."
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] text-[var(--text-tertiary)]">
                    <th className="text-left font-medium px-4 py-3">Status</th>
                    <th className="text-left font-medium px-4 py-3">Started</th>
                    <th className="text-right font-medium px-4 py-3">Tokens</th>
                    <th className="text-right font-medium px-4 py-3">Tool Calls</th>
                    <th className="text-right font-medium px-4 py-3">Opps Found</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b border-[var(--border-subtle)] last:border-0">
                      <td className="px-4 py-3">
                        <Badge variant={run.status === 'completed' ? 'profit' : run.status === 'running' ? 'accent' : 'danger'}>
                          {run.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">{timeAgo(run.startedAt)}</td>
                      <td className="px-4 py-3 text-right font-mono-numbers text-[var(--text-primary)]">{run.tokensUsed.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-mono-numbers text-[var(--text-primary)]">{run.toolCalls}</td>
                      <td className="px-4 py-3 text-right font-mono-numbers text-[var(--text-primary)]">{run.opportunitiesFound}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-[var(--text-tertiary)]">{label}</span>
      <span className="text-[var(--text-primary)] capitalize">{value}</span>
    </div>
  );
}
