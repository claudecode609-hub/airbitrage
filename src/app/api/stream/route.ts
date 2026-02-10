/**
 * GET /api/stream?agentType=listings — SSE endpoint for live agent updates.
 *
 * Streams progress events while an agent is running.
 * Uses a concurrency queue to limit parallel agent runs (max 2 at a time).
 */

import { NextRequest } from 'next/server';
import { dispatchAgentRun } from '@/agents/run-agent';
import { getApiKeys } from '@/lib/api-keys';
import { checkBudget, loadBudgetConfig } from '@/lib/budget';
import { enqueueAgentRun, getQueueStatus, isAgentRunning } from '@/lib/agent-queue';
import { AgentType, ACTIVE_AGENTS } from '@/types';

export async function GET(request: NextRequest) {
  const agentType = request.nextUrl.searchParams.get('agentType') as AgentType;
  const configParam = request.nextUrl.searchParams.get('config');

  if (!agentType || !ACTIVE_AGENTS.includes(agentType)) {
    return new Response('Invalid agent type', { status: 400 });
  }

  // Reject if this agent is already running
  if (isAgentRunning(agentType)) {
    return new Response(`${agentType} agent is already running`, { status: 409 });
  }

  const keys = await getApiKeys();
  if (!keys.anthropicApiKey || !keys.tavilyApiKey) {
    return new Response('API keys not configured', { status: 400 });
  }

  const budgetConfig = await loadBudgetConfig();
  const budget = await checkBudget(budgetConfig);
  if (!budget.allowed) {
    return new Response('Daily token limit reached', { status: 429 });
  }

  const config = configParam ? JSON.parse(configParam) : {};

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      function sendEvent(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream may have been closed by client
          closed = true;
        }
      }

      sendEvent('connected', { agentType, message: 'Stream connected' });

      // Enqueue the run — it may start immediately or wait for a slot
      const { position } = enqueueAgentRun(agentType, async () => {
        // This runs when the agent actually gets a slot
        sendEvent('progress', {
          type: 'started',
          message: 'Agent run starting…',
        });

        try {
          const result = await dispatchAgentRun(
            {
              agentType,
              apiKey: keys.anthropicApiKey,
              tavilyApiKey: keys.tavilyApiKey,
              config,
            },
            (progressEvent) => {
              sendEvent('progress', progressEvent);
            },
          );

          sendEvent('result', {
            success: result.success,
            opportunities: result.opportunities,
            stats: {
              totalInputTokens: result.totalInputTokens,
              totalOutputTokens: result.totalOutputTokens,
              totalToolCalls: result.totalToolCalls,
              estimatedCost: result.estimatedCost,
              scoutStats: 'scoutStats' in result ? (result as unknown as { scoutStats: unknown }).scoutStats : null,
            },
            error: result.error,
            abortReason: result.abortReason,
          });
        } catch (err) {
          sendEvent('error', { message: err instanceof Error ? err.message : String(err) });
        }

        sendEvent('done', { message: 'Agent run complete' });
        if (!closed) {
          try { controller.close(); } catch { /* already closed */ }
        }
        closed = true;
      });

      // If queued, send the position so the client can show "Queued (#N)"
      if (position > 0) {
        const status = getQueueStatus();
        sendEvent('progress', {
          type: 'queued',
          message: `Queued — ${status.activeCount} agent(s) running, you are #${position} in line…`,
          data: { position, active: status.active },
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
