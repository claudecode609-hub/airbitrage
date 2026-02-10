export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // TODO: Fetch real opportunity from database by id
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center space-y-2">
        <p className="text-sm text-[var(--text-tertiary)]">Opportunity &quot;{id}&quot; not found.</p>
        <p className="text-xs text-[var(--text-tertiary)]">Run an agent to discover opportunities, then view them here.</p>
      </div>
    </div>
  );
}
