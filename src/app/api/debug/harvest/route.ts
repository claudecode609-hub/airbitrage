/**
 * GET /api/debug/harvest — diagnostic endpoint that runs ONLY the harvester
 * and returns raw results. No Tavily or Claude costs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { harvestBuyIntents } from '@/agents/buyer-intent/harvester';

export async function GET(request: NextRequest) {
  const password = request.nextUrl.searchParams.get('p');
  const sitePassword = process.env.SITE_PASSWORD;
  if (sitePassword && password !== sitePassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const start = Date.now();
    const result = await harvestBuyIntents();
    const elapsed = Date.now() - start;

    const pricedIntents = result.intents.filter(i => i.hasStatedPrice);
    const pricelessIntents = result.intents.filter(i => !i.hasStatedPrice);

    return NextResponse.json({
      elapsed: `${elapsed}ms`,
      totalIntents: result.intents.length,
      pricedCount: pricedIntents.length,
      pricelessCount: pricelessIntents.length,
      diagnostics: result.diagnostics,
      // Show first 10 priced intents
      topPriced: pricedIntents.slice(0, 10).map(i => ({
        item: i.itemWanted,
        price: `$${(i.maxPrice / 100).toFixed(0)}`,
        source: i.source,
        buyer: i.buyerUsername,
        trades: i.buyerTradeCount,
        age: `${i.postAge}h`,
      })),
      // Show first 10 priceless intents
      topPriceless: pricelessIntents.slice(0, 10).map(i => ({
        item: i.itemWanted,
        source: i.source,
        buyer: i.buyerUsername,
        trades: i.buyerTradeCount,
        age: `${i.postAge}h`,
      })),
    });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }, { status: 500 });
  }
}
