/**
 * Price-check sanity filter — programmatic spread detection.
 * Takes raw scout leads and filters to only those with likely profitable spreads.
 * No Claude tokens spent.
 */

import { ScoutLead, CryptoPrice, DealFeedItem, extractAllPrices, extractPrice, isListingUrl, cleanTitleForSearch, BookLead } from './sources';

// ─── Types ───────────────────────────────────────────────────────────

export interface QualifiedLead {
  title: string;
  description: string;
  buyPrice: number;        // cents
  buySource: string;
  buyUrl: string;
  sellPriceEstimate: number; // cents — our best guess
  sellSource: string;
  sellUrl: string;          // may be a search URL if no exact match
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

  for (const lead of leads) {
    if (!lead.priceFound || lead.priceFound <= 0) continue;

    // Check if we have resale data for this lead
    const resale = resalePriceData.get(lead.url) || resalePriceData.get(lead.title);
    if (!resale || !resale.estimatedPrice) continue;

    const spread = resale.estimatedPrice - lead.priceFound;
    const spreadPercent = (spread / lead.priceFound) * 100;

    // Apply sanity filters
    if (spread < minProfitCents) continue;       // Not enough raw spread
    if (spreadPercent < minSpreadPercent) continue; // Spread too thin (fees will eat it)

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
      estimatedSpread: spread,
      spreadPercent,
      confidence,
      category: lead.category,
      raw: lead,
    });
  }

  // Sort by spread descending
  return qualified.sort((a, b) => b.estimatedSpread - a.estimatedSpread);
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
          estimatedSpread: regularPrice - dealPrice,
          spreadPercent: discount,
          confidence: discount > 70 ? 'high' : 'medium',
          category: item.source,
          raw: item,
        });
      }
      continue;
    }

    // Fallback: exactly 2 prices in the TITLE ONLY — use lower as deal, higher as regular
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
            estimatedSpread: regularPrice - dealPrice,
            spreadPercent: discount,
            confidence: 'medium',
            category: item.source,
            raw: item,
          });
        }
      }
    }
    // If no structured pattern AND not exactly 2 title prices → skip item entirely
    // (better to miss a deal than fabricate a false spread)
  }

  return qualified.sort((a, b) => b.estimatedSpread - a.estimatedSpread);
}

// ─── Resale Price Lookup (Tavily-powered, no Claude) ─────────────────

export interface ResalePriceInfo {
  estimatedPrice: number;  // cents
  platform: string;
  url: string;
  dataPoints: number;       // how many price data points we found
  listingDataPoints?: number; // how many came from actual listing URLs (higher quality)
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
  for (let i = 0; i < sortedLeads.length && i < cap; i++) {
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

      if (!response.ok) continue;

      const data = await response.json();
      const results = (data.results || []) as Array<{ url: string; title?: string; content?: string }>;

      // Extract prices PER-RESULT with source-quality weighting
      const weightedPrices: Array<{ value: number; weight: number }> = [];
      let listingDataPoints = 0;

      // Process Tavily's answer field (medium weight)
      if (data.answer) {
        for (const price of extractAllPrices(data.answer)) {
          // Anchor: skip prices wildly outside expected range
          if (price < buyPriceCents * 0.2 || price > buyPriceCents * 10) continue;
          weightedPrices.push({ value: price, weight: 2 });
        }
      }

      // Process each search result individually
      for (const result of results) {
        const resultText = (result.title || '') + ' ' + (result.content || '');
        const resultPrices = extractAllPrices(resultText);
        const isListing = isListingUrl(result.url);
        const weight = isListing ? 3 : 1;

        for (const price of resultPrices) {
          // Anchor: skip prices wildly outside expected range
          if (price < buyPriceCents * 0.2 || price > buyPriceCents * 10) continue;
          weightedPrices.push({ value: price, weight });
          if (isListing) listingDataPoints++;
        }
      }

      if (weightedPrices.length > 0) {
        const median = weightedMedian(weightedPrices);

        // Find the best URL — strongly prefer actual listing pages
        const listingResult = results.find((r) => isListingUrl(r.url));
        const marketplaceResult = results.find((r) =>
          r.url.includes('ebay.com') || r.url.includes('amazon.com'),
        );
        const bestResult = listingResult || marketplaceResult || results[0];

        const platform = bestResult?.url?.includes('ebay') ? 'eBay'
          : bestResult?.url?.includes('amazon') ? 'Amazon'
          : bestResult?.url?.includes('stockx') ? 'StockX'
          : bestResult?.url?.includes('mercari') ? 'Mercari'
          : 'Marketplace';

        const info: ResalePriceInfo = {
          estimatedPrice: median,
          platform,
          url: bestResult?.url || '',
          dataPoints: weightedPrices.length,
          listingDataPoints,
        };

        resaleMap.set(lead.url, info);
        resaleMap.set(lead.title, info); // fallback matching by title
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
