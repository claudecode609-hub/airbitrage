/**
 * Base agent — the core tool-use loop that all agents extend.
 *
 * Flow:
 * 1. Check daily budget → abort if exceeded
 * 2. Send system prompt + tools to Claude
 * 3. If Claude wants to use a tool → execute it → send result back
 * 4. Repeat until Claude stops or budget/limits hit
 * 5. Parse structured opportunities from final response
 * 6. Record token usage
 */

import {
  callClaude,
  extractToolUses,
  wantsToolUse,
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeTool,
  ClaudeResponse,
} from '@/lib/claude';
import {
  checkBudget,
  recordUsage,
  loadBudgetConfig,
  estimateCost,
  BudgetConfig,
} from '@/lib/budget';
import { AgentType } from '@/types';

export interface AgentToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentRunConfig {
  agentType: AgentType;
  systemPrompt: string;
  tools: AgentToolHandler[];
  userMessage: string;
  apiKey: string;
  maxTokensPerCall?: number;
  model?: string;
}

export interface AgentRunResult {
  success: boolean;
  opportunities: ParsedOpportunity[];
  reasoning: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  estimatedCost: number;
  error?: string;
  abortReason?: string;
}

export interface ParsedOpportunity {
  title: string;
  description: string;
  buyPrice: number;      // cents
  buySource: string;
  buyUrl: string;
  sellPrice: number;     // cents
  sellSource: string;
  sellUrl: string;
  estimatedProfit: number; // cents
  fees: {
    platformFee?: number;
    shippingCost?: number;
    paymentProcessing?: number;
    other?: number;
    total: number;
  };
  confidence: number;    // 0-100
  riskNotes: string[];
  reasoning: string;
}

// The structured output format we ask Claude to return
const OPPORTUNITY_OUTPUT_SCHEMA = `
Return opportunities as a JSON array wrapped in <opportunities> tags:
<opportunities>
[
  {
    "title": "Short descriptive title",
    "description": "What the item is and why this is an opportunity",
    "buyPrice": 4500,
    "buySource": "Craigslist",
    "buyUrl": "https://...",
    "sellPrice": 18900,
    "sellSource": "eBay",
    "sellUrl": "https://...",
    "estimatedProfit": 10743,
    "fees": {
      "platformFee": 2457,
      "shippingCost": 1200,
      "total": 3657
    },
    "confidence": 85,
    "riskNotes": ["Condition not verified in person", "Listing is 6hrs old"],
    "reasoning": "Found SX-70 listed 6 hours ago for $45. eBay sold listings show 14 sales in last 30 days, avg $189..."
  }
]
</opportunities>

IMPORTANT: All prices must be in CENTS (e.g. $45.00 = 4500). If you find no opportunities, return an empty array.
`;

export async function runAgent(
  config: AgentRunConfig,
  onProgress?: (event: AgentProgressEvent) => void,
): Promise<AgentRunResult> {
  const budgetConfig = await loadBudgetConfig();

  // 1. Check daily budget
  const budget = await checkBudget(budgetConfig);
  if (!budget.allowed) {
    return {
      success: false,
      opportunities: [],
      reasoning: '',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      estimatedCost: 0,
      abortReason: `Daily token limit reached (${budget.used.toLocaleString()} / ${budget.limit.toLocaleString()} tokens used today). Try again tomorrow or increase your daily limit in Settings.`,
    };
  }

  // Convert tool handlers to Claude tool format
  const claudeTools: ClaudeTool[] = config.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  // Build system prompt with output format
  const systemPrompt = `${config.systemPrompt}\n\n${OPPORTUNITY_OUTPUT_SCHEMA}`;

  // Initialize conversation
  const messages: ClaudeMessage[] = [
    { role: 'user', content: config.userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  let loopCount = 0;
  const maxLoops = 15; // Safety: prevent infinite loops
  let lastResponse: ClaudeResponse | null = null;
  let runInputTokens = 0; // track input tokens within the current 60s window
  let windowStart = 0;
  const INPUT_TOKEN_LIMIT_PER_MIN = 28000; // stay under 30k/min limit with buffer
  let lastApiCallTime = 0;
  const MIN_DELAY_MS = 3000; // minimum 3s between calls

  onProgress?.({ type: 'started', message: 'Agent started' });

  try {
    // 2. Tool-use loop
    while (loopCount < maxLoops) {
      loopCount++;

      // Check per-run token budget
      const runTokens = totalInputTokens + totalOutputTokens;
      if (runTokens >= budgetConfig.perRunTokenLimit) {
        onProgress?.({ type: 'budget_warning', message: `Per-run token limit reached (${runTokens.toLocaleString()} tokens)` });
        break;
      }

      // Check per-run tool call limit
      if (totalToolCalls >= budgetConfig.perRunToolCallLimit) {
        onProgress?.({ type: 'budget_warning', message: `Per-run tool call limit reached (${totalToolCalls} calls)` });
        break;
      }

      // Re-check daily budget (another run might have used tokens)
      const currentBudget = await checkBudget(budgetConfig);
      if (!currentBudget.allowed) {
        onProgress?.({ type: 'budget_warning', message: 'Daily token limit reached mid-run' });
        break;
      }

      // Rate limit: enforce minimum delay + token-based cooldown
      const now = Date.now();

      // Reset the per-minute window if >60s have passed
      if (windowStart > 0 && (now - windowStart) >= 60000) {
        runInputTokens = 0;
        windowStart = now;
      }
      if (windowStart === 0) {
        windowStart = now;
      }

      // If we're approaching the input token limit for this minute, wait it out
      if (runInputTokens >= INPUT_TOKEN_LIMIT_PER_MIN) {
        const waitMs = Math.max(0, 60000 - (now - windowStart)) + 2000;
        onProgress?.({
          type: 'calling_claude',
          message: `Rate limit cooldown (${Math.ceil(waitMs / 1000)}s — used ${runInputTokens.toLocaleString()} input tokens this minute)…`,
          data: { loop: loopCount, tokens: runTokens, toolCalls: totalToolCalls },
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        runInputTokens = 0;
        windowStart = Date.now();
      }

      // Minimum delay between calls
      const elapsed = Date.now() - lastApiCallTime;
      if (lastApiCallTime > 0 && elapsed < MIN_DELAY_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS - elapsed));
      }

      onProgress?.({
        type: 'calling_claude',
        message: `Calling Claude (loop ${loopCount})…`,
        data: { loop: loopCount, tokens: runTokens, toolCalls: totalToolCalls },
      });

      // 3. Call Claude
      lastApiCallTime = Date.now();
      const response = await callClaude(
        {
          model: config.model || 'claude-haiku-4-5-20251001',
          max_tokens: config.maxTokensPerCall || 2048,
          system: systemPrompt,
          messages,
          tools: claudeTools.length > 0 ? claudeTools : undefined,
        },
        config.apiKey,
      );

      lastResponse = response;
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      runInputTokens += response.usage.input_tokens; // track for rate limiting

      // Record usage immediately (so daily tracking is accurate)
      await recordUsage(
        config.agentType,
        response.usage.input_tokens,
        response.usage.output_tokens,
        0,
      );

      // 4. If Claude wants tools, execute them
      if (wantsToolUse(response)) {
        const toolUses = extractToolUses(response);

        // Add assistant message with tool use blocks
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: ClaudeContentBlock[] = [];

        for (const toolUse of toolUses) {
          totalToolCalls++;
          const handler = config.tools.find((t) => t.name === toolUse.name);

          onProgress?.({
            type: 'tool_call',
            message: `Using tool: ${toolUse.name}`,
            data: { tool: toolUse.name, input: toolUse.input },
          });

          let resultContent: string;
          let isError = false;

          if (!handler) {
            resultContent = `Error: Unknown tool "${toolUse.name}"`;
            isError = true;
          } else {
            try {
              resultContent = await handler.execute(toolUse.input as Record<string, unknown>);
              // Truncate large tool results to keep context lean (saves input tokens)
              const MAX_TOOL_RESULT_CHARS = 3000;
              if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
                resultContent = resultContent.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[... truncated — result was ' + resultContent.length.toLocaleString() + ' chars]';
              }
            } catch (err) {
              resultContent = `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
            is_error: isError,
          });

          onProgress?.({
            type: 'tool_result',
            message: `Tool ${toolUse.name} ${isError ? 'failed' : 'completed'}`,
            data: { tool: toolUse.name, isError, resultLength: resultContent.length },
          });
        }

        // Add tool results as user message
        messages.push({ role: 'user', content: toolResults });
      } else {
        // Claude is done — no more tool calls
        break;
      }
    }

    // 5. Parse opportunities from the final response
    const opportunities = parseOpportunities(lastResponse);

    const cost = estimateCost(totalInputTokens, totalOutputTokens);

    onProgress?.({
      type: 'completed',
      message: `Found ${opportunities.length} opportunities`,
      data: { opportunities: opportunities.length, tokens: totalInputTokens + totalOutputTokens, cost },
    });

    return {
      success: true,
      opportunities,
      reasoning: extractFullReasoning(lastResponse),
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls,
      estimatedCost: cost,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    onProgress?.({ type: 'error', message: error });

    return {
      success: false,
      opportunities: [],
      reasoning: '',
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls,
      estimatedCost: estimateCost(totalInputTokens, totalOutputTokens),
      error,
    };
  }
}

// --- Helpers ---

function parseOpportunities(response: ClaudeResponse | null): ParsedOpportunity[] {
  if (!response) return [];

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');

  // Extract JSON from <opportunities> tags
  const match = text.match(/<opportunities>\s*([\s\S]*?)\s*<\/opportunities>/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];

    // Validate each opportunity has required fields
    return parsed.filter(
      (o: Record<string, unknown>) =>
        o.title &&
        typeof o.buyPrice === 'number' &&
        typeof o.sellPrice === 'number' &&
        o.buySource &&
        o.sellSource,
    ) as ParsedOpportunity[];
  } catch {
    return [];
  }
}

function extractFullReasoning(response: ClaudeResponse | null): string {
  if (!response) return '';
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

// --- Progress events ---

export interface AgentProgressEvent {
  type:
    | 'started'
    | 'calling_claude'
    | 'tool_call'
    | 'tool_result'
    | 'budget_warning'
    | 'completed'
    | 'error';
  message: string;
  data?: Record<string, unknown>;
}
