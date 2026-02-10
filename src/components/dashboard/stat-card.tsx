import { memo } from 'react';
import { Card } from '@/components/ui/card';

interface StatCardProps {
  label: string;
  value: string;
  detail?: string;
  accentColor?: string;
}

export const StatCard = memo(function StatCard({ label, value, detail, accentColor }: StatCardProps) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-[var(--text-tertiary)] uppercase tracking-wider">{label}</span>
      <span
        className="font-mono-numbers text-2xl font-bold"
        style={{ color: accentColor || 'var(--text-primary)' }}
      >
        {value}
      </span>
      {detail && (
        <span className="text-xs text-[var(--text-tertiary)]">{detail}</span>
      )}
    </Card>
  );
});
