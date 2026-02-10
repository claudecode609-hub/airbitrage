/**
 * Token budget system — prevents runaway API costs.
 *
 * Tracks token usage in a JSON file (upgradeable to DB later).
 * Enforces:
 *   - Global daily token limit (across all agents)
 *   - Per-run token limit (per individual agent execution)
 *
 * Usage is reset at midnight UTC each day.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), '.airbitrage');
const BUDGET_FILE = path.join(DATA_DIR, 'token-usage.json');

export interface BudgetConfig {
  dailyTokenLimit: number;     // Max tokens per day across all agents (default: 500,000)
  perRunTokenLimit: number;    // Max tokens per single agent run (default: 50,000)
  perRunToolCallLimit: number; // Max tool calls per single agent run (default: 25)
}

export interface TokenUsageEntry {
  date: string;         // YYYY-MM-DD (UTC)
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  runs: RunUsageEntry[];
}

export interface RunUsageEntry {
  agentType: string;
  startedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyTokenLimit: 500_000,
  perRunTokenLimit: 50_000,
  perRunToolCallLimit: 25,
};

function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Already exists
  }
}

async function readUsage(): Promise<TokenUsageEntry> {
  await ensureDataDir();
  const today = todayUTC();

  try {
    const data = await readFile(BUDGET_FILE, 'utf-8');
    const usage: TokenUsageEntry = JSON.parse(data);

    // Reset if it's a new day
    if (usage.date !== today) {
      return { date: today, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, runs: [] };
    }

    return usage;
  } catch {
    // File doesn't exist or is corrupted
    return { date: today, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, runs: [] };
  }
}

async function writeUsage(usage: TokenUsageEntry): Promise<void> {
  await ensureDataDir();
  await writeFile(BUDGET_FILE, JSON.stringify(usage, null, 2));
}

/**
 * Check if there's enough budget remaining for a new agent run.
 * Returns { allowed, remaining, used, limit }
 */
export async function checkBudget(
  config: BudgetConfig = DEFAULT_BUDGET,
): Promise<{
  allowed: boolean;
  remaining: number;
  used: number;
  limit: number;
  runsToday: number;
}> {
  const usage = await readUsage();

  return {
    allowed: usage.totalTokens < config.dailyTokenLimit,
    remaining: Math.max(0, config.dailyTokenLimit - usage.totalTokens),
    used: usage.totalTokens,
    limit: config.dailyTokenLimit,
    runsToday: usage.runs.length,
  };
}

/**
 * Record token usage from a completed (or in-progress) agent run.
 * Called after each Claude API call within a run.
 */
export async function recordUsage(
  agentType: string,
  inputTokens: number,
  outputTokens: number,
  toolCalls: number,
): Promise<void> {
  const usage = await readUsage();
  const totalTokens = inputTokens + outputTokens;

  usage.totalTokens += totalTokens;
  usage.totalInputTokens += inputTokens;
  usage.totalOutputTokens += outputTokens;

  usage.runs.push({
    agentType,
    startedAt: new Date().toISOString(),
    inputTokens,
    outputTokens,
    totalTokens,
    toolCalls,
  });

  await writeUsage(usage);
}

/**
 * Get today's usage summary.
 */
export async function getDailyUsage(): Promise<TokenUsageEntry> {
  return readUsage();
}

/**
 * Estimate cost from token usage (rough estimate based on Claude Sonnet pricing).
 * Input: $3/M tokens, Output: $15/M tokens
 */
export function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
}

/**
 * Load budget config from the data directory, or return defaults.
 */
export async function loadBudgetConfig(): Promise<BudgetConfig> {
  const configFile = path.join(DATA_DIR, 'budget-config.json');
  try {
    const data = await readFile(configFile, 'utf-8');
    return { ...DEFAULT_BUDGET, ...JSON.parse(data) };
  } catch {
    return DEFAULT_BUDGET;
  }
}

/**
 * Save budget config.
 */
export async function saveBudgetConfig(config: BudgetConfig): Promise<void> {
  await ensureDataDir();
  const configFile = path.join(DATA_DIR, 'budget-config.json');
  await writeFile(configFile, JSON.stringify(config, null, 2));
}
