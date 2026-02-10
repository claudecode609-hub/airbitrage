/**
 * GET /api/budget — Get current daily token budget status.
 * PUT /api/budget — Update budget config.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  checkBudget,
  getDailyUsage,
  loadBudgetConfig,
  saveBudgetConfig,
  estimateCost,
  BudgetConfig,
} from '@/lib/budget';

export async function GET() {
  try {
    const config = await loadBudgetConfig();
    const budget = await checkBudget(config);
    const usage = await getDailyUsage();
    const cost = estimateCost(usage.totalInputTokens, usage.totalOutputTokens);

    return NextResponse.json({
      config,
      status: {
        allowed: budget.allowed,
        used: budget.used,
        remaining: budget.remaining,
        limit: budget.limit,
        runsToday: budget.runsToday,
        estimatedCostToday: cost,
      },
      usage: {
        date: usage.date,
        totalTokens: usage.totalTokens,
        totalInputTokens: usage.totalInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        runs: usage.runs,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const config: Partial<BudgetConfig> = {};

    if (typeof body.dailyTokenLimit === 'number') config.dailyTokenLimit = body.dailyTokenLimit;
    if (typeof body.perRunTokenLimit === 'number') config.perRunTokenLimit = body.perRunTokenLimit;
    if (typeof body.perRunToolCallLimit === 'number') config.perRunToolCallLimit = body.perRunToolCallLimit;

    const current = await loadBudgetConfig();
    const updated = { ...current, ...config };
    await saveBudgetConfig(updated);

    return NextResponse.json({ success: true, config: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
