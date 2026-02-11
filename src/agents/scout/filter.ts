/**
 * Price-check sanity filter — programmatic spread detection.
 * Takes raw scout leads and filters to only those with likely profitable spreads.
 * No Claude tokens spent.
 */

import { ScoutLead, CryptoPrice, DealFeedItem, CollectibleLead, extractAllPrices, extractPrice, isListingUrl, cleanTitleForSearch, BookLead } from './sources';
import type { SellPriceType } from '@/agents/base-agent';

// ─── Types ───────────────────────────────────────────────────────────

export interface QualifiedLead {
  title: string;
  description: string;
  buyPrice: number;        // cents
  buySource: string;
  buyUrl: string;
  sellPriceEstimate: number; // cents — our best guess (0 if unknown)
  sellSource: string;
  sellUrl: string;          // may be a search URL if no exact match
  sellPriceType: SellPriceType; // how reliable the sell price is
  estimatedSpread: number;   // cents (sell - buy, before fees)
  spreadPercent: number;     // percentage
  confidence: 'high' | 'medium' | 'low';
  category: string;
  raw: ScoutLead | DealFeedItem | CryptoPrice;
}

export interface CryptoSpread {
  pair: string;
  buyExchange: string;
  buyPrice: number;
  buyUrl: string;
  sellExchange: string;
  sellPrice: number;
  sellUrl: string;
  spreadPercent: number;
  spreadAmount: number;     // in USD
}

// ─── Crypto Spread Detection ─────────────────────────────────────────

export function findCryptoSpreads(
  prices: CryptoPrice[],
  minSpreadPercent = 0.3,
): CryptoSpread[] {
  const spreads: CryptoSpread[] = [];

  // Group by pair
  const byPair = new Map<string, CryptoPrice[]>();
  for (const p of prices) {
    const existing = byPair.get(p.pair) || [];
    existing.push(p);
    byPair.set(p.pair, existing);
  }

  // Find spreads between exchanges for each pair
  for (const [pair, exchangePrices] of byPair) {
    if (exchangePrices.length < 2) continue;

    for (let i = 0; i < exchangePrices.length; i++) {
      for (let j = i + 1; j < exchangePrices.length; j++) {
        const a = exchangePrices[i];
        const b = exchangePrices[j];

        const low = a.price < b.price ? a : b;
        const high = a.price < b.price ? b : a;

        const spreadPercent = ((high.price - low.price) / low.price) * 100;

        if (spreadPercent >= minSpreadPercent) {
          spreads.push({
            pair,
            buyExchange: low.exchange,
            buyPrice: low.price,
            buyUrl: low.url,
            sellExchange: high.exchange,
            sellPrice: high.price,
            sellUrl: high.url,
            spreadPercent,
            spreadAmount: high.price - low.price,
          });
        }
      }
    }
  }

  // Sort by spread percentage descending
  return spreads.sort((a, b) => b.spreadPercent - a.spreadPercent);
}

// ─── Listing/Retail Lead Filtering ───────────────────────────────────

/**
 * Takes raw scout leads and their corresponding resale price data,
 * returns only leads that pass the sanity check.
 */
export function filterLeadsWithPriceData(
  leads: ScoutLead[],
  resalePriceData: Map<string, ResalePriceInfo>,
  minProfitCents = 2000,
  minSpreadPercent = 25,
): QualifiedLead[] {
  const qualified: QualifiedLead[] = [];
  const unresearched: QualifiedLead[] = []; // Leads Claude should research
  let noPrice = 0, noResale = 0, lowSpread = 0, lowPercent = 0, needsResearch = 0;

  for (const lead of leads) {
    if (!lead.priceFound || lead.priceFound <= 0) { noPrice++; continue; }

    // Check if we have resale data for this lead
    const resale = resalePriceData.get(lead.url) || resalePriceData.get(lead.title);
    if (!resale) { noResale++; continue; }

    // If resale lookup found no listing prices, pass to Claude as "research_needed"
    if (resale.estimatedPrice === 0 || resale.priceType === 'research_needed') {
      needsResearch++;
      unresearched.push({
        title: lead.title,
        description: lead.snippet,
        buyPrice: lead.priceFound,
        buySource: lead.source,
        buyUrl: lead.url,
        sellPriceEstimate: 0,
        sellSource: 'Unknown',
        sellUrl: resale.url || `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanTitleForSearch(lead.title))}&LH_Sold=1&LH_Complete=1`,
        sellPriceType: 'research_needed',
        estimatedSpread: 0,
        spreadPercent: 0,
        confidence: 'low',
        category: lead.category,
        raw: lead,
      });
      continue;
    }

    const spread = resale.estimatedPrice - lead.priceFound;
    const spreadPercent = (spread / lead.priceFound) * 100;

    // Apply sanity filters
    if (spread < minProfitCents) { lowSpread++; continue; }
    if (spreadPercent < minSpreadPercent) { lowPercent++; continue; }

    // Estimate confidence — listing-URL data points are much stronger signal
    let confidence: 'high' | 'medium' | 'low' = 'low';
    const listingPts = resale.listingDataPoints || 0;
    if ((listingPts >= 2 || resale.dataPoints >= 5) && spreadPercent > 50) {
      confidence = 'high';
    } else if ((listingPts >= 1 || resale.dataPoints >= 3) && spreadPercent > 30) {
      confidence = 'medium';
    }

    qualified.push({
      title: lead.title,
      description: lead.snippet,
      buyPrice: lead.priceFound,
      buySource: lead.source,
      buyUrl: lead.url,
      sellPriceEstimate: resale.estimatedPrice,
      sellSource: resale.platform,
      sellUrl: resale.url || `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanTitleForSearch(lead.title))}&LH_Sold=1&LH_Complete=1`,
      sellPriceType: resale.priceType,
      estimatedSpread: spread,
      spreadPercent,
      confidence,
      category: lead.category,
      raw: lead,
    });
  }

  console.log(`[filterLeads] ${leads.length} leads → ${qualified.length} qualified, ${unresearched.length} needs research | Rejected: ${noPrice} no price, ${noResale} no resale data, ${lowSpread} low spread (<$${(minProfitCents/100).toFixed(0)}), ${lowPercent} low percent (<${minSpreadPercent}%)`);

  // Append up to 5 unresearched leads for Claude to investigate
  const result = [...qualified.sort((a, b) => b.estimatedSpread - a.estimatedSpread), ...unresearched.slice(0, 5)];
  return result;
}

/**
 * Extract a deal-price / regular-price pair from text using structured patterns.
 * Returns null if no recognizable deal pattern is found — avoids guessing.
 */
export function extractDealPricePair(
  text: string,
): { dealPrice: number; regularPrice: number } | null {
  // Helper: parse dollar amount to cents
  const parseDollar = (s: string): number => {
    const num = parseFloat(s.replace(/,/g, ''));
    return num > 0 && num < 1000000 ? Math.round(num * 100) : 0;
  };

  // Pattern 1: $DEAL (XX% off $REGULAR) — e.g. "$44.99 (55% off $100)"
  const pctOffMatch = text.match(
    /\$\s?([\d,]+(?:\.\d{2})?)\s*\(\s*\d+%\s*off\s*\$\s?([\d,]+(?:\.\d{2})?)\s*\)/i,
  );
  if (pctOffMatch) {
    const deal = parseDollar(pctOffMatch[1]);
    const regular = parseDollar(pctOffMatch[2]);
    if (deal > 0 && regular > deal) return { dealPrice: deal, regularPrice: regular };
  }

  // Pattern 2: $DEAL (was/reg/originally/MSRP/regular price/retail $REGULAR)
  const wasMatch = text.match(
    /\$\s?([\d,]+(?:\.\d{2})?)\s*\(\s*(?:was|reg\.?|originally|msrp|regular\s*(?:price)?|retail)\s*\$?\s?([\d,]+(?:\.\d{2})?)\s*\)/i,
  );
  if (wasMatch) {
    const deal = parseDollar(wasMatch[1]);
    const regular = parseDollar(wasMatch[2]);
    if (deal > 0 && regular > deal) return { dealPrice: deal, regularPrice: regular };
  }

  // Pattern 3: was $REGULAR, now $DEAL / from $REGULAR to $DEAL
  const wasNowMatch = text.match(
    /(?:was|from)\s*\$\s?([\d,]+(?:\.\d{2})?)\s*[,.]?\s*(?:now|to|→|->)\s*\$\s?([\d,]+(?:\.\d{2})?)/i,
  );
  if (wasNowMatch) {
    const regular = parseDollar(wasNowMatch[1]);
    const deal = parseDollar(wasNowMatch[2]);
    if (deal > 0 && regular > deal) return { dealPrice: deal, regularPrice: regular };
  }

  // Pattern 4: $DEAL, regularly/normally $REGULAR
  const regMatch = text.match(
    /\$\s?([\d,]+(?:\.\d{2})?)\s*[,.]?\s*(?:regularly|normally|usually|list(?:ed)?(?:\s+at)?)\s*\$?\s?([\d,]+(?:\.\d{2})?)/i,
  );
  if (regMatch) {
    const deal = parseDollar(regMatch[1]);
    const regular = parseDollar(regMatch[2]);
    if (deal > 0 && regular > deal) return { dealPrice: deal, regularPrice: regular };
  }

  return null;
}

/**
 * Filter deal feed items for arbitrage potential.
 * Uses structured price-pair extraction to avoid false positives from stray prices.
 */
export function filterDealFeedItems(
  items: DealFeedItem[],
  minDiscountPercent = 50,
): QualifiedLead[] {
  const qualified: QualifiedLead[] = [];

  for (const item of items) {
    // Try structured extraction on title first (most reliable), then title+description
    const pricePair =
      extractDealPricePair(item.title) ||
      extractDealPricePair(item.title + ' ' + item.description);

    if (pricePair) {
      const { dealPrice, regularPrice } = pricePair;
      const discount = ((regularPrice - dealPrice) / regularPrice) * 100;

      if (discount >= minDiscountPercent) {
        const cleanedTitle = cleanTitleForSearch(item.title);
        qualified.push({
          title: item.title,
          description: item.description,
          buyPrice: dealPrice,
          buySource: item.source,
          buyUrl: item.url,
          sellPriceEstimate: regularPrice,
          sellSource: 'Amazon/eBay',
          sellUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanedTitle)}&LH_Sold=1&LH_Complete=1`,
          sellPriceType: 'estimated',
          estimatedSpread: regularPrice - dealPrice,
          spreadPercent: discount,
          confidence: discount > 70 ? 'high' : 'medium',
          category: item.source,
          raw: item,
        });
      }
      continue;
    }

    // Fallback 1: exactly 2 prices in the TITLE ONLY — use lower as deal, higher as regular
    const titlePrices = extractAllPrices(item.title);
    if (titlePrices.length === 2) {
      const sorted = [...titlePrices].sort((a, b) => a - b);
      const dealPrice = sorted[0];
      const regularPrice = sorted[1];

      if (regularPrice > dealPrice && dealPrice > 0) {
        const discount = ((regularPrice - dealPrice) / regularPrice) * 100;

        if (discount >= minDiscountPercent) {
          const cleanedTitle = cleanTitleForSearch(item.title);
          qualified.push({
            title: item.title,
            description: item.description,
            buyPrice: dealPrice,
            buySource: item.source,
            buyUrl: item.url,
            sellPriceEstimate: regularPrice,
            sellSource: 'Amazon/eBay',
            sellUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanedTitle)}&LH_Sold=1&LH_Complete=1`,
            sellPriceType: 'estimated',
            estimatedSpread: regularPrice - dealPrice,
            spreadPercent: discount,
            confidence: 'medium',
            category: item.source,
            raw: item,
          });
          continue;
        }
      }
    }

    // Fallback 2: one price in title + explicit percentage: "$50 (60% off)" or "60% off — $50"
    const fullText = item.title + ' ' + item.description;
    const pctMatch = fullText.match(/(\d+)%\s*off/i);
    const singlePrice = extractAllPrices(item.title);
    if (pctMatch && singlePrice.length === 1) {
      const pctOff = parseInt(pctMatch[1], 10);
      if (pctOff >= minDiscountPercent && pctOff < 95) {
        const dealPrice = singlePrice[0];
        // Back-calculate regular price: dealPrice = regularPrice * (1 - pctOff/100)
        const regularPrice = Math.round(dealPrice / (1 - pctOff / 100));

        if (regularPrice > dealPrice && dealPrice > 0) {
          const cleanedTitle = cleanTitleForSearch(item.title);
          qualified.push({
            title: item.title,
            description: item.description,
            buyPrice: dealPrice,
            buySource: item.source,
            buyUrl: item.url,
            sellPriceEstimate: regularPrice,
            sellSource: 'Amazon/eBay',
            sellUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanedTitle)}&LH_Sold=1&LH_Complete=1`,
            sellPriceType: 'estimated',
            estimatedSpread: regularPrice - dealPrice,
            spreadPercent: pctOff,
            confidence: 'low',
            category: item.source,
            raw: item,
          });
          continue;
        }
      }
    }

    // Fallback 3: two prices anywhere in title+description (title has 1, desc has more)
    const allTextPrices = extractAllPrices(fullText);
    if (allTextPrices.length >= 2 && singlePrice.length >= 1) {
      const dealPrice = singlePrice[0];
      const otherPrices = allTextPrices.filter(p => p !== dealPrice && p > dealPrice);
      if (otherPrices.length > 0) {
        const sorted = otherPrices.sort((a, b) => a - b);
        const regularPrice = sorted[Math.floor(sorted.length / 2)];
        const discount = ((regularPrice - dealPrice) / regularPrice) * 100;

        if (discount >= minDiscountPercent && dealPrice > 0) {
          const cleanedTitle = cleanTitleForSearch(item.title);
          qualified.push({
            title: item.title,
            description: item.description,
            buyPrice: dealPrice,
            buySource: item.source,
            buyUrl: item.url,
            sellPriceEstimate: regularPrice,
            sellSource: 'Amazon/eBay',
            sellUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanedTitle)}&LH_Sold=1&LH_Complete=1`,
            sellPriceType: 'estimated',
            estimatedSpread: regularPrice - dealPrice,
            spreadPercent: discount,
            confidence: 'low',
            category: item.source,
            raw: item,
          });
        }
      }
    }
  }

  return qualified.sort((a, b) => b.estimatedSpread - a.estimatedSpread);
}

// ─── Resale Price Lookup (Tavily-powered, no Claude) ─────────────────

export interface ResalePriceInfo {
  estimatedPrice: number;  // cents (0 if no listing-verified price found)
  platform: string;
  url: string;
  dataPoints: number;       // how many price data points we found
  listingDataPoints?: number; // how many came from actual listing URLs (higher quality)
  priceType: SellPriceType;  // 'verified' if from real listings, 'estimated' otherwise
}

/**
 * Compute weighted median from an array of { value, weight } entries.
 */
function weightedMedian(entries: Array<{ value: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  if (entries.length === 1) return entries[0].value;

  // Sort by value
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, e) => sum + e.weight, 0);
  const halfWeight = totalWeight / 2;

  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= halfWeight) return entry.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * For a batch of leads, look up resale prices on eBay/Amazon via Tavily.
 * Uses per-result price extraction with buy-price anchoring to avoid noise.
 */
export async function batchResaleLookup(
  leads: ScoutLead[],
  tavilyApiKey: string,
): Promise<Map<string, ResalePriceInfo>> {
  const resaleMap = new Map<string, ResalePriceInfo>();

  // Only look up leads that have a price
  const leadsWithPrices = leads.filter(l => l.priceFound && l.priceFound > 0);

  console.log(`[batchResaleLookup] Starting: ${leadsWithPrices.length} leads with prices`);

  // Sort by source quality before capping (listing URLs first, then Craigslist, etc.)
  const sortedLeads = [...leadsWithPrices].sort((a, b) => {
    const scoreSource = (l: ScoutLead) => {
      if (l.source.startsWith('craigslist')) return 3;
      if (isListingUrl(l.url)) return 3;
      if (l.source === 'Discogs' || l.source === 'StockX') return 2;
      if (l.source === 'eBay') return 2;
      return 1;
    };
    return scoreSource(b) - scoreSource(a);
  });

  // Look up resale prices for up to 25 leads (raised from 15)
  const cap = 25;
  let consecutiveErrors = 0;

  for (let i = 0; i < sortedLeads.length && i < cap; i++) {
    // If we've hit 3+ consecutive rate-limit errors, stop wasting credits
    if (consecutiveErrors >= 3) {
      console.log(`[batchResaleLookup] Stopping early: ${consecutiveErrors} consecutive Tavily errors (rate limited). Processed ${i}/${Math.min(sortedLeads.length, cap)} leads.`);
      break;
    }

    const lead = sortedLeads[i];
    const buyPriceCents = lead.priceFound!;

    // Use cleanTitleForSearch for the query
    const cleanTitle = cleanTitleForSearch(lead.title);
    if (cleanTitle.length < 5) continue;

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query: `"${cleanTitle}" sold price ebay amazon`,
          max_results: 5,
          include_answer: true,
        }),
      });

      if (!response.ok) {
        console.log(`[batchResaleLookup] Tavily returned ${response.status} for "${cleanTitle.slice(0, 40)}"`);
        if (response.status === 429 || response.status === 433 || response.status >= 500) {
          consecutiveErrors++;
        }
        continue;
      }
      consecutiveErrors = 0; // Reset on success

      const data = await response.json();
      const results = (data.results || []) as Array<{ url: string; title?: string; content?: string }>;

      console.log(`[batchResaleLookup] "${cleanTitle.slice(0, 40)}" → ${results.length} results, buy=$${(buyPriceCents / 100).toFixed(2)}`);

      // ONLY extract prices from real listing URLs — skip blogs, reviews, aggregators
      const listingPrices: number[] = [];
      let listingDataPoints = 0;
      let bestListingUrl = '';
      let bestListingPlatform = '';

      for (const result of results) {
        if (!isListingUrl(result.url)) continue; // Skip non-listing pages entirely

        const resultText = (result.title || '') + ' ' + (result.content || '');
        const resultPrices = extractAllPrices(resultText);

        for (const price of resultPrices) {
          // Anchor: skip prices wildly outside expected range
          if (price < buyPriceCents * 0.1 || price > buyPriceCents * 20) continue;
          // Skip prices too close to buy price (not useful for spread)
          if (Math.abs(price - buyPriceCents) < buyPriceCents * 0.05) continue;
          listingPrices.push(price);
          listingDataPoints++;
        }

        // Track the best listing URL
        if (!bestListingUrl && resultPrices.length > 0) {
          bestListingUrl = result.url;
          bestListingPlatform = result.url.includes('ebay') ? 'eBay'
            : result.url.includes('amazon') ? 'Amazon'
            : result.url.includes('stockx') ? 'StockX'
            : result.url.includes('mercari') ? 'Mercari'
            : 'Marketplace';
        }
      }

      console.log(`[batchResaleLookup]   ${listingPrices.length} prices from ${listingDataPoints} listing data points. ${listingPrices.length > 0 ? `Range: $${(Math.min(...listingPrices) / 100).toFixed(2)} – $${(Math.max(...listingPrices) / 100).toFixed(2)}` : 'NO LISTING PRICES'}`);

      // Determine price type: 'verified' needs 2+ listing data points
      const priceType: SellPriceType = listingDataPoints >= 2 ? 'verified' : 'estimated';

      if (listingPrices.length > 0) {
        // Use median of listing prices only
        const sorted = [...listingPrices].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];

        const info: ResalePriceInfo = {
          estimatedPrice: median,
          platform: bestListingPlatform || 'Marketplace',
          url: bestListingUrl,
          dataPoints: listingPrices.length,
          listingDataPoints,
          priceType,
        };

        resaleMap.set(lead.url, info);
        resaleMap.set(lead.title, info);
      } else {
        // No listing prices found — store as "no data" so we can pass to Claude
        const searchUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanTitle)}&LH_Sold=1&LH_Complete=1`;
        const info: ResalePriceInfo = {
          estimatedPrice: 0,
          platform: 'eBay',
          url: searchUrl,
          dataPoints: 0,
          listingDataPoints: 0,
          priceType: 'research_needed',
        };
        resaleMap.set(lead.url, info);
        resaleMap.set(lead.title, info);
      }
    } catch {
      // Skip failed lookups
    }

    // Small delay between Tavily calls
    if (i < sortedLeads.length - 1 && i < cap - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return resaleMap;
}

// ─── Book-Specific Resale Lookup ──────────────────────────────────────

/**
 * For books from Open Library (which have no priceFound), do ISBN-based resale lookups.
 * Books are a special case: buy at thrift stores/library sales ($1-5), sell on Amazon/eBay ($10-80+).
 * Since we can't know the actual buy price in advance, we estimate a thrift-store buy price
 * and look up the resale value via ISBN.
 */
export async function batchBookResaleLookup(
  books: BookLead[],
  tavilyApiKey: string,
  minProfitCents = 800,
): Promise<QualifiedLead[]> {
  const qualified: QualifiedLead[] = [];

  // Cap at 15 book lookups
  const booksToCheck = books.slice(0, 15);

  for (let i = 0; i < booksToCheck.length; i++) {
    const book = booksToCheck[i];

    // Build the best possible search query
    let query: string;
    if (book.isbn) {
      // ISBN-based lookup is much more precise
      query = `"${book.isbn}" price amazon ebay used book`;
    } else {
      // Fallback to title+author
      const cleanTitle = cleanTitleForSearch(book.title);
      if (cleanTitle.length < 5) continue;
      query = `"${cleanTitle}" used book price amazon ebay`;
    }

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query,
          max_results: 5,
          include_answer: true,
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const results = (data.results || []) as Array<{ url: string; title?: string; content?: string }>;

      // Extract prices from results
      const prices: number[] = [];
      for (const result of results) {
        const resultText = (result.title || '') + ' ' + (result.content || '');
        for (const price of extractAllPrices(resultText)) {
          // Books typically sell for $5-$500 — filter out noise
          if (price >= 500 && price <= 50000) {
            prices.push(price);
          }
        }
      }

      // Also check the Tavily answer
      if (data.answer) {
        for (const price of extractAllPrices(data.answer)) {
          if (price >= 500 && price <= 50000) {
            prices.push(price);
          }
        }
      }

      if (prices.length === 0) continue;

      // Use median as sell price estimate
      const sorted = [...prices].sort((a, b) => a - b);
      const sellEstimate = sorted[Math.floor(sorted.length / 2)];

      // Estimate buy price: thrift store/library sale ($1-$3 for most books)
      const estimatedBuyPrice = 200; // $2.00 — typical thrift store book price

      const spread = sellEstimate - estimatedBuyPrice;

      if (spread < minProfitCents) continue;

      // Find best URL
      const listingResult = results.find((r) => isListingUrl(r.url));
      const marketplaceResult = results.find((r) =>
        r.url.includes('ebay.com') || r.url.includes('amazon.com'),
      );
      const bestResult = listingResult || marketplaceResult || results[0];

      const platform = bestResult?.url?.includes('ebay') ? 'eBay'
        : bestResult?.url?.includes('amazon') ? 'Amazon'
        : 'Marketplace';

      // Determine if sell price is from a real listing
      const hasListingUrl = listingResult !== undefined;
      const bookSellPriceType: SellPriceType = hasListingUrl && prices.length >= 2 ? 'verified' : 'estimated';

      qualified.push({
        title: book.title,
        description: `${book.snippet} — Estimated resale: $${(sellEstimate / 100).toFixed(2)} on ${platform}. Buy at thrift stores/library sales for ~$2.`,
        buyPrice: estimatedBuyPrice,
        buySource: 'Thrift/Library Sale',
        buyUrl: book.url,
        sellPriceEstimate: sellEstimate,
        sellSource: platform,
        sellUrl: bestResult?.url || (book.isbn
          ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(book.isbn)}&LH_Sold=1&LH_Complete=1`
          : `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanTitleForSearch(book.title))}&LH_Sold=1&LH_Complete=1`),
        sellPriceType: bookSellPriceType,
        estimatedSpread: spread,
        spreadPercent: (spread / estimatedBuyPrice) * 100,
        confidence: book.isbn && prices.length >= 3 ? 'high' : prices.length >= 2 ? 'medium' : 'low',
        category: 'books',
        raw: book,
      });
    } catch {
      // Skip failed lookups
    }

    // Small delay between Tavily calls
    if (i < booksToCheck.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return qualified.sort((a, b) => b.estimatedSpread - a.estimatedSpread);
}

// ─── Collectibles Direct Qualification ───────────────────────────────

/**
 * For collectible leads from Discogs/StockX that already have marketplace prices,
 * estimate resale potential without needing Tavily.
 *
 * Discogs lowest_price = what you can buy it for on Discogs.
 * eBay typically sells for 1.3-2x the Discogs lowest because eBay has a much larger audience.
 * StockX market price = real-time, but you can sometimes find cheaper on eBay/Mercari.
 */
export function qualifyCollectiblesDirectly(
  leads: ScoutLead[],
  minProfitCents = 1000,
): QualifiedLead[] {
  const qualified: QualifiedLead[] = [];

  for (const lead of leads) {
    if (!lead.priceFound || lead.priceFound <= 0) continue;

    const collectible = lead as CollectibleLead;
    const buyPrice = lead.priceFound;

    let sellEstimate: number;
    let sellSource: string;
    let sellUrl: string;
    let confidence: 'high' | 'medium' | 'low';
    let sellPriceType: SellPriceType = 'estimated';

    if (lead.source === 'Discogs') {
      sellEstimate = Math.round(buyPrice * 1.5);
      sellSource = 'eBay';
      sellUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanTitleForSearch(lead.title) + ' vinyl')}&LH_Sold=1&LH_Complete=1`;
      confidence = 'medium';
      sellPriceType = 'estimated';
    } else if (lead.source === 'StockX') {
      const marketPrice = collectible.marketAvg || buyPrice;
      if (marketPrice > buyPrice * 1.2) {
        sellEstimate = marketPrice;
        sellSource = 'StockX/GOAT';
        sellUrl = lead.url;
        confidence = 'high';
        sellPriceType = 'verified'; // StockX market price is real
      } else {
        continue;
      }
    } else {
      sellEstimate = Math.round(buyPrice * 1.3);
      sellSource = 'eBay';
      sellUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(cleanTitleForSearch(lead.title))}&LH_Sold=1&LH_Complete=1`;
      confidence = 'low';
    }

    const feeRate = sellSource === 'StockX/GOAT' ? 0.095 : 0.1313;
    const fees = Math.round(sellEstimate * feeRate);
    const shipping = sellSource === 'StockX/GOAT' ? 0 : 800;
    const netSpread = sellEstimate - buyPrice - fees - shipping;

    if (netSpread < minProfitCents) continue;

    const spreadPercent = (netSpread / buyPrice) * 100;

    qualified.push({
      title: lead.title,
      description: `${lead.snippet} — Buy on ${lead.source} for $${(buyPrice/100).toFixed(2)}, estimated resale $${(sellEstimate/100).toFixed(2)} on ${sellSource} (after ~$${(fees/100).toFixed(2)} fees).`,
      buyPrice,
      buySource: lead.source,
      buyUrl: lead.url,
      sellPriceEstimate: sellEstimate,
      sellSource,
      sellUrl,
      sellPriceType,
      estimatedSpread: netSpread,
      spreadPercent,
      confidence,
      category: lead.category,
      raw: lead,
    });
  }

  console.log(`[qualifyCollectibles] ${leads.length} leads → ${qualified.length} qualified directly (no Tavily needed)`);
  return qualified.sort((a, b) => b.estimatedSpread - a.estimatedSpread);
}
