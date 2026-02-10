import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/shared/status-dot';
import { AGENT_TYPES, AgentType, AgentStatus } from '@/types';
import Link from 'next/link';

interface AgentCardProps {
  agentType: AgentType;
  liveStatus: 'idle' | 'queued' | 'running' | 'completed' | 'error';
  liveOpportunities: number;
  onRun: () => void;
}

export const AgentCard = memo(function AgentCard({ agentType, liveStatus, liveOpportunities, onRun }: AgentCardProps) {
  const info = AGENT_TYPES[agentType];

  const isBusy = liveStatus === 'running' || liveStatus === 'queued';
  const displayStatus: AgentStatus = liveStatus === 'running' ? 'running'
    : liveStatus === 'queued' ? 'queued'
    : liveStatus === 'error' ? 'error'
    : 'idle';

  return (
    <Card hover className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-sm"
            style={{ background: info.color + '18' }}
          >
            {info.icon}
          </span>
          <div>
            <div className="text-sm font-medium text-[var(--text-primary)]">{info.name}</div>
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
              <StatusDot status={displayStatus} />
              <span className="capitalize">
                {liveStatus === 'completed' ? `done · ${liveOpportunities} found` : displayStatus}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-[var(--text-tertiary)]">Opportunities</div>
          <div className="font-mono-numbers font-medium text-[var(--text-primary)]">{liveOpportunities}</div>
        </div>
        <div>
          <div className="text-[var(--text-tertiary)]">Sources</div>
          <div className="text-[var(--text-primary)] truncate text-[10px]">
            {info.sources.slice(0, 2).join(', ')}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Link href={`/agents/${agentType}`} className="flex-1">
          <Button variant="secondary" size="sm" className="w-full">
            View
          </Button>
        </Link>
        <Button
          variant={isBusy ? 'ghost' : 'primary'}
          size="sm"
          disabled={isBusy}
          onClick={onRun}
          className="flex-1"
        >
          {liveStatus === 'queued' ? 'Queued…' : liveStatus === 'running' ? 'Running…' : 'Run Now'}
        </Button>
      </div>
    </Card>
  );
});
