/**
 * Claude API client — raw fetch, no SDK.
 * Handles messages, tool use, streaming, and token counting.
 */

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ClaudeResponse {
  id: string;
  type: string;
  role: 'assistant';
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: ClaudeUsage;
}

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const API_VERSION = '2023-06-01';

export async function callClaude(
  request: ClaudeRequest,
  apiKey: string,
): Promise<ClaudeResponse> {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: request.model || CLAUDE_MODEL,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  return response.json();
}

/**
 * Extract text content from a Claude response
 */
export function extractText(response: ClaudeResponse): string {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/**
 * Extract tool use blocks from a Claude response
 */
export function extractToolUses(response: ClaudeResponse): ClaudeContentBlock[] {
  return response.content.filter((block) => block.type === 'tool_use');
}

/**
 * Check if the response wants to use tools
 */
export function wantsToolUse(response: ClaudeResponse): boolean {
  return response.stop_reason === 'tool_use';
}
