import { AGENT_TYPES } from '@/types';
import { Card } from '@/components/ui/card';

const info = AGENT_TYPES.crypto;

export default function CryptoPage() {
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
          Cross-exchange crypto arbitrage spreads are typically 0.1–0.3% in 2025, and they&apos;re
          captured by bots in milliseconds. Manual arbitrage at human speed is no longer viable
          for retail traders — the math doesn&apos;t work after withdrawal fees, transfer times,
          and slippage.
        </p>
        <p className="text-sm text-[var(--text-tertiary)] leading-relaxed">
          If DeFi bridge arbitrage or cross-chain opportunities become practical at human
          timescales, this agent will be activated.
        </p>
      </Card>
      <span className="inline-block text-xs text-[var(--text-tertiary)] uppercase tracking-wider px-3 py-1 rounded-full border border-[var(--border-subtle)]">
        Coming Soon
      </span>
    </div>
  );
}
