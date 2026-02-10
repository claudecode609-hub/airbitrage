import { EmptyState } from '@/components/shared/empty-state';

export default function WatchlistPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Watchlist</h1>
        <p className="text-sm text-[var(--text-tertiary)]">
          Opportunities you&apos;re tracking. Agents will re-check prices periodically.
        </p>
      </div>

      <EmptyState
        icon="👁"
        title="Nothing on your watchlist"
        description="Save opportunities to track price changes and get alerts when spreads widen."
      />
    </div>
  );
}
