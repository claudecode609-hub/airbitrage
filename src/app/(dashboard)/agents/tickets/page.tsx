import { AGENT_TYPES } from '@/types';
import { Card } from '@/components/ui/card';

const info = AGENT_TYPES.tickets;

export default function TicketsPage() {
  return (
    <div className="max-w-2xl mx-auto py-16 text-center space-y-6">
      <span
        className="inline-flex h-16 w-16 items-center justify-center rounded-2xl text-3xl"
        style={{ background: info.color + '18' }}
      >
        {info.icon}
      </span>
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">{info.name}</h1>
      <Card className="space-y-3 text-left">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">Why this agent is paused</h2>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
          Ticket resale platforms have sophisticated anti-bot protections and dynamic pricing
          that makes automated price comparison unreliable. Primary platforms like Ticketmaster
          use queue systems and CAPTCHA that prevent automated access.
        </p>
        <p className="text-sm text-[var(--text-tertiary)] leading-relaxed">
          If reliable ticket APIs become available, this agent will be activated.
        </p>
      </Card>
      <span className="inline-block text-xs text-[var(--text-tertiary)] uppercase tracking-wider px-3 py-1 rounded-full border border-[var(--border-subtle)]">
        Coming Soon
      </span>
    </div>
  );
}
