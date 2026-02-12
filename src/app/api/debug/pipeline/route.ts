/**
 * GET /api/debug/pipeline — runs the full buyer-intent pipeline with step-by-step
 * timing and returns JSON results. Use this to diagnose Vercel deployment issues.
 *
 * Add ?p=YOUR_PASSWORD to authenticate.
 * Add ?dryrun=1 to skip Tavily/Claude calls (harvest only).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getApiKeys } from '@/lib/api-keys';
import { harvestBuyIntents } from '@/agents/buyer-intent/harvester';
import { findSourcesForIntents } from '@/agents/buyer-intent/sourcer';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const password = request.nextUrl.searchParams.get('p');
  const sitePassword = process.env.SITE_PASSWORD;
  const dryrun = request.nextUrl.searchParams.get('dryrun') === '1';

  if (sitePassword && password !== sitePassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const steps: Array<{ step: string; elapsed: number; detail: string }> = [];
  const overallStart = Date.now();

  try {
    // Step 1: Check API keys
    const keysStart = Date.now();
    const keys = await getApiKeys();
    steps.push({
      step: 'api-keys',
      elapsed: Date.now() - keysStart,
      detail: `anthropic=${keys.anthropicApiKey ? 'set' : 'MISSING'}, tavily=${keys.tavilyApiKey ? 'set' : 'MISSING'}`,
    });

    if (!keys.anthropicApiKey || !keys.tavilyApiKey) {
      return NextResponse.json({
        error: 'API keys missing',
        steps,
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'missing',
          AIRBITRAGE_ANTHROPIC_KEY: process.env.AIRBITRAGE_ANTHROPIC_KEY ? 'set' : 'missing',
          TAVILY_API_KEY: process.env.TAVILY_API_KEY ? 'set' : 'missing',
          NODE_ENV: process.env.NODE_ENV,
        },
      });
    }

    // Step 2: Harvest from Reddit
    const harvestStart = Date.now();
    const harvest = await harvestBuyIntents();
    const priced = harvest.intents.filter(i => i.hasStatedPrice);
    const priceless = harvest.intents.filter(i => !i.hasStatedPrice);
    steps.push({
      step: 'harvest',
      elapsed: Date.now() - harvestStart,
      detail: `${harvest.intents.length} intents (${priced.length} priced, ${priceless.length} priceless)`,
    });

    if (dryrun || harvest.intents.length === 0) {
      return NextResponse.json({
        dryrun,
        totalElapsed: Date.now() - overallStart,
        steps,
        diagnostics: harvest.diagnostics,
        sampleIntents: harvest.intents.slice(0, 5).map(i => ({
          item: i.itemWanted,
          price: i.maxPrice,
          priced: i.hasStatedPrice,
          source: i.source,
          age: `${i.postAge}h`,
        })),
      });
    }

    // Step 3: Source via Tavily (limited to 3 searches in debug mode)
    const sourceStart = Date.now();
    const limitedIntents = harvest.intents.slice(0, 3); // Only 3 in debug mode
    const sourceResult = await findSourcesForIntents(
      limitedIntents,
      keys.tavilyApiKey,
    );
    steps.push({
      step: 'source',
      elapsed: Date.now() - sourceStart,
      detail: `${sourceResult.tavilyCallCount} Tavily calls, ${sourceResult.matched.length} matches`,
    });

    return NextResponse.json({
      totalElapsed: Date.now() - overallStart,
      steps,
      harvestDiagnostics: harvest.diagnostics,
      sourceDiagnostics: sourceResult.diagnostics,
      matches: sourceResult.matched.map(m => ({
        buyerItem: m.buyIntent.itemWanted,
        buyerPrice: m.buyIntent.maxPrice,
        sourceTitle: m.sourceListing.title,
        sourcePrice: m.sourceListing.price,
        marketplace: m.sourceListing.marketplace,
        profit: m.estimatedProfit,
      })),
    });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      totalElapsed: Date.now() - overallStart,
      steps,
    }, { status: 500 });
  }
}
