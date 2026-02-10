import { cn } from '@/lib/utils';
import { AgentStatus } from '@/types';

interface StatusDotProps {
  status: AgentStatus;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full',
        status === 'running' && 'bg-[var(--color-accent)] animate-pulse-dot',
        status === 'queued' && 'bg-[var(--color-warning)] animate-pulse-dot',
        status === 'idle' && 'bg-[var(--text-tertiary)]',
        status === 'error' && 'bg-[var(--color-danger)]',
        className,
      )}
    />
  );
}
