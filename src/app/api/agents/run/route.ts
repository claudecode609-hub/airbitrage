/**
 * POST /api/agents/run — Trigger an agent run.
 *
 * Body: { agentType: string, config?: object }
 * Returns: { runId, opportunities, stats }
 */

import { NextRequest, NextResponse } from 'next/server';
import { dispatchAgentRun } from '@/agents/run-agent';
import { getApiKeys } from '@/lib/api-keys';
import { checkBudget, loadBudgetConfig } from '@/lib/budget';
import { AgentType } from '@/types';

const VALID_AGENTS: AgentType[] = ['listings', 'auctions', 'crypto', 'retail', 'tickets', 'collectibles', 'books'];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentType, config = {} } = body;

    // Validate agent type
    if (!VALID_AGENTS.includes(agentType)) {
      return NextResponse.json(
        { error: `Invalid agent type: ${agentType}` },
        { status: 400 },
      );
    }

    // Check API keys
    const keys = await getApiKeys();
    if (!keys.anthropicApiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured. Set ANTHROPIC_API_KEY in your .env file or update it in Settings.' },
        { status: 400 },
      );
    }
    if (!keys.tavilyApiKey) {
      return NextResponse.json(
        { error: 'Tavily API key not configured. Set TAVILY_API_KEY in your .env file or update it in Settings.' },
        { status: 400 },
      );
    }

    // Check budget
    const budgetConfig = await loadBudgetConfig();
    const budget = await checkBudget(budgetConfig);
    if (!budget.allowed) {
      return NextResponse.json(
        {
          error: 'Daily token limit reached',
          used: budget.used,
          limit: budget.limit,
          runsToday: budget.runsToday,
        },
        { status: 429 },
      );
    }

    // Run the agent
    const result = await dispatchAgentRun(
      {
        agentType: agentType as AgentType,
        apiKey: keys.anthropicApiKey,
        tavilyApiKey: keys.tavilyApiKey,
        config,
      },
    );

    return NextResponse.json({
      success: result.success,
      opportunities: result.opportunities,
      stats: {
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
        totalToolCalls: result.totalToolCalls,
        estimatedCost: result.estimatedCost,
      },
      error: result.error,
      abortReason: result.abortReason,
    });
  } catch (err) {
    console.error('Agent run error:', err);
    return NextResponse.json(
      { error: `Agent run failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
