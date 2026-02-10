import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/dashboard/stat-card';
import { EmptyState } from '@/components/shared/empty-state';
import { AGENT_TYPES, AgentType } from '@/types';

export default function AnalyticsPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Analytics</h1>
        <p className="text-sm text-[var(--text-tertiary)]">Performance across all agents</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Est. Profit" value="$0" accentColor="var(--color-profit)" />
        <StatCard label="Opportunities" value="0" accentColor="var(--color-accent)" />
        <StatCard label="Total Runs" value="0" />
        <StatCard label="Avg Confidence" value="—" />
      </div>

      {/* Profit by Agent */}
      <Card className="space-y-4">
        <h2 className="text-sm font-medium text-[var(--text-secondary)] uppercase tracking-wider">Profit by Agent</h2>
        <EmptyState
          icon="📊"
          title="No data yet"
          description="Run your agents to see profit breakdowns by agent type."
        />
      </Card>

      {/* Agent Costs */}
      <Card className="space-y-4">
        <h2 className="text-sm font-medium text-[var(--text-secondary)] uppercase tracking-wider">Agent Costs</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(Object.keys(AGENT_TYPES) as AgentType[]).map((type) => {
            const info = AGENT_TYPES[type];
            return (
              <div key={type} className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-surface)]">
                <span className="text-lg">{info.icon}</span>
                <div className="flex-1">
                  <div className="text-xs text-[var(--text-primary)]">{info.shortName}</div>
                  <div className="text-[10px] text-[var(--text-tertiary)]">
                    0 tokens · $0.000
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono-numbers text-xs text-[var(--text-primary)]">0 runs</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
