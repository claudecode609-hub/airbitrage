/**
 * Scout data sources — free APIs, RSS feeds, and Tavily batch search.
 * These run WITHOUT Claude to gather raw leads cheaply.
 */

const TAVILY_API_URL = 'https://api.tavily.com/search';

// ─── Diagnostics ────────────────────────────────────────────────────

export interface SourceDiagnostic {
  source: string;
  status: 'success' | 'error' | 'empty' | 'blocked';
  statusCode?: number;
  error?: string;
  itemCount: number;
  durationMs: number;
}

export interface SourceResult<T> {
  leads: T[];
  diagnostics: SourceDiagnostic[];
}

// ─── Types ───────────────────────────────────────────────────────────

export interface ScoutLead {
  title: string;
  url: string;
  snippet: string;
  source: string;
  priceFound: number | null;   // cents, extracted from text
  category: string;
}

export interface CryptoPrice {
  exchange: string;
  pair: string;
  price: number;
  url: string;
  timestamp: number;
}

export interface DealFeedItem {
  title: string;
  url: string;
  description: string;
  source: string;
  pubDate: string;
}

// ─── Tavily Batch Search (no Claude) ─────────────────────────────────

export async function tavilyBatchSearch(
  queries: string[],
  tavilyApiKey: string,
  maxResultsPerQuery = 5,
): Promise<ScoutLead[]> {
  const leads: ScoutLead[] = [];

  // Run searches sequentially with timeouts and delays
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    try {
      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query,
          max_results: maxResultsPerQuery,
          include_raw_content: false,
          include_answer: false,
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();

      for (const r of data.results || []) {
        const snippet = (r.content as string || '').slice(0, 500);
        const url = r.url || '';

        // Score URL quality — prefer actual item/listing pages over search/blog pages
        const urlQuality = scoreUrlQuality(url);
        if (urlQuality === 'skip') continue; // Skip search result pages, aggregator indexes, etc.

        leads.push({
          title: r.title || '',
          url,
          snippet,
          source: extractDomain(url),
          priceFound: extractPrice(r.title + ' ' + snippet),
          category: query,
        });
      }
    } catch {
      // Skip failed/timed-out searches
    }

    // Small delay between queries to avoid Tavily rate limits
    if (qi < queries.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return leads;
}

// ─── Crypto Exchange APIs (all free, no auth) ────────────────────────

export async function fetchCryptoPrices(pairs: string[]): Promise<CryptoPrice[]> {
  const prices: CryptoPrice[] = [];

  // Normalize pairs: "BTC/USD" → { base: "BTC", quote: "USD" }
  const normalizedPairs = pairs.map(p => {
    const [base, quote] = p.split('/');
    return { base: base.toUpperCase(), quote: (quote || 'USD').toUpperCase() };
  });

  // Fetch from all exchanges in parallel
  const results = await Promise.allSettled([
    fetchBinancePrices(normalizedPairs),
    fetchCoinbasePrices(normalizedPairs),
    fetchKrakenPrices(normalizedPairs),
  ]);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      prices.push(...result.value);
    }
  }

  return prices;
}

async function fetchBinancePrices(
  pairs: { base: string; quote: string }[],
): Promise<CryptoPrice[]> {
  const prices: CryptoPrice[] = [];

  try {
    // Binance uses BTCUSDT format
    const response = await fetch('https://api.binance.com/api/v3/ticker/price', {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return prices;

    const data: Array<{ symbol: string; price: string }> = await response.json();
    const priceMap = new Map(data.map(d => [d.symbol, parseFloat(d.price)]));

    for (const { base, quote } of pairs) {
      // Try BTCUSDT, BTCBUSD
      const quoteMap: Record<string, string> = { USD: 'USDT', USDT: 'USDT', BUSD: 'BUSD' };
      const symbol = base + (quoteMap[quote] || quote);
      const price = priceMap.get(symbol);

      if (price) {
        prices.push({
          exchange: 'Binance',
          pair: `${base}/${quote}`,
          price,
          url: `https://www.binance.com/en/trade/${base}_${quoteMap[quote] || quote}`,
          timestamp: Date.now(),
        });
      }
    }
  } catch { /* Binance unavailable */ }

  return prices;
}

async function fetchCoinbasePrices(
  pairs: { base: string; quote: string }[],
): Promise<CryptoPrice[]> {
  const prices: CryptoPrice[] = [];

  for (const { base, quote } of pairs) {
    try {
      // Coinbase uses BTC-USD format
      const response = await fetch(
        `https://api.coinbase.com/v2/prices/${base}-${quote}/spot`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) continue;

      const data = await response.json();
      const price = parseFloat(data.data?.amount);

      if (price) {
        prices.push({
          exchange: 'Coinbase',
          pair: `${base}/${quote}`,
          price,
          url: `https://www.coinbase.com/price/${base.toLowerCase()}`,
          timestamp: Date.now(),
        });
      }
    } catch { /* skip */ }
  }

  return prices;
}

async function fetchKrakenPrices(
  pairs: { base: string; quote: string }[],
): Promise<CryptoPrice[]> {
  const prices: CryptoPrice[] = [];

  // Kraken symbol mapping
  const krakenSymbol: Record<string, string> = {
    BTC: 'XBT', DOGE: 'XDG',
  };

  for (const { base, quote } of pairs) {
    try {
      const kBase = krakenSymbol[base] || base;
      const kQuote = krakenSymbol[quote] || quote;
      const pair = kBase + kQuote;

      const response = await fetch(
        `https://api.kraken.com/0/public/Ticker?pair=${pair}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) continue;

      const data = await response.json();
      if (data.error?.length > 0) continue;

      const result = Object.values(data.result || {})[0] as { c?: string[] } | undefined;
      const price = result?.c?.[0] ? parseFloat(result.c[0]) : null;

      if (price) {
        prices.push({
          exchange: 'Kraken',
          pair: `${base}/${quote}`,
          price,
          url: `https://www.kraken.com/prices/${base.toLowerCase()}`,
          timestamp: Date.now(),
        });
      }
    } catch { /* skip */ }
  }

  return prices;
}

// ─── Craigslist RSS Feeds (free, no auth, structured prices) ─────────

/**
 * Craigslist's native RSS feeds include structured price data.
 * URL format: https://{city}.craigslist.org/search/{category}?query={term}&format=rss
 *
 * Categories: sss (all for sale), ela (electronics), fua (furniture),
 * bia (bikes), msa (musical instruments), tla (tools), bka (books)
 *
 * Prices come from the dc:format tag or the title (e.g. "$45")
 */

export interface CraigslistConfig {
  cities: string[];
  categories: string[];
  queries: string[];
  maxItemsPerFeed?: number;
}

const CRAIGSLIST_CATEGORIES: Record<string, string> = {
  electronics: 'ela',
  furniture: 'fua',
  bikes: 'bia',
  tools: 'tla',
  musical: 'msa',
  books: 'bka',
  appliances: 'ppa',
  sports: 'sga',
  'free': 'zip',
  all: 'sss',
};

const DEFAULT_CITIES = [
  'sfbay', 'losangeles', 'newyork', 'chicago', 'seattle',
  'portland', 'austin', 'denver', 'atlanta', 'boston',
  'dallas', 'houston', 'sandiego', 'miami', 'phoenix',
  'minneapolis', 'detroit', 'philadelphia', 'washingtondc', 'nashville',
];

/** Known high-resale brands for targeted Craigslist searches */
const HIGH_RESALE_BRANDS = [
  // Electronics
  'macbook', 'iphone', 'ipad', 'sonos', 'bose', 'dyson', 'vitamix',
  'kitchenaid', 'sony', 'canon', 'nikon', 'nintendo switch', 'ps5',
  // Furniture
  'herman miller', 'steelcase', 'west elm', 'restoration hardware',
  'pottery barn', 'room and board', 'eames',
  // Tools
  'milwaukee', 'dewalt', 'makita', 'festool', 'snap-on',
  // Audio
  'marantz', 'mcintosh', 'klipsch', 'technics', 'sennheiser',
  // Bikes
  'trek', 'specialized', 'cannondale', 'santa cruz', 'cervelo',
  // Musical
  'fender', 'gibson', 'taylor', 'martin', 'roland',
];

export async function fetchCraigslistRSS(
  config: CraigslistConfig,
): Promise<SourceResult<ScoutLead>> {
  const diagnostics: SourceDiagnostic[] = [];
  const cities = config.cities.length > 0 ? config.cities : DEFAULT_CITIES.slice(0, 5); // Reduced from 10 to 5
  const categories = config.categories.length > 0
    ? config.categories.map(c => CRAIGSLIST_CATEGORIES[c] || 'sss')
    : ['sss']; // Default to all for-sale

  // Build queries: user queries + brand names
  const queries = config.queries.length > 0
    ? config.queries
    : HIGH_RESALE_BRANDS.slice(0, 15); // Top 15 brands

  const feeds: Array<{ url: string; city: string; query: string }> = [];

  // Build feed URLs — limit to manageable count
  for (const query of queries) {
    for (const city of cities.slice(0, 5)) {
      for (const cat of categories) {
        feeds.push({
          url: `https://${city}.craigslist.org/search/${cat}?query=${encodeURIComponent(query)}&format=rss&sort=date`,
          city,
          query,
        });
      }
    }
  }

  // Cap at 40 feeds max to stay fast
  const feedsToFetch = feeds.slice(0, 40);
  const leads: ScoutLead[] = [];
  let successCount = 0;
  let errorCount = 0;

  // Fetch in parallel batches of 5 (avoid hammering Craigslist)
  const BATCH_SIZE = 5;
  for (let i = 0; i < feedsToFetch.length; i += BATCH_SIZE) {
    const batch = feedsToFetch.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (feed) => {
        const start = Date.now();
        try {
          const response = await fetch(feed.url, {
            signal: AbortSignal.timeout(8000),
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; research)',
              Accept: 'application/rss+xml, application/xml, text/xml',
            },
          });

          if (!response.ok) {
            const status = response.status === 403 ? 'blocked' as const : 'error' as const;
            diagnostics.push({
              source: `Craigslist ${feed.city}`,
              status,
              statusCode: response.status,
              error: `HTTP ${response.status}`,
              itemCount: 0,
              durationMs: Date.now() - start,
            });
            errorCount++;
            return [];
          }

          const xml = await response.text();
          const items = parseCraigslistRSS(xml, feed.city, feed.query, config.maxItemsPerFeed || 10);
          successCount++;
          return items;
        } catch (err) {
          diagnostics.push({
            source: `Craigslist ${feed.city}`,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            itemCount: 0,
            durationMs: Date.now() - start,
          });
          errorCount++;
          return [];
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        leads.push(...result.value);
      }
    }

    // Small delay between batches
    if (i + BATCH_SIZE < feedsToFetch.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Add summary diagnostic
  diagnostics.push({
    source: 'Craigslist RSS (summary)',
    status: leads.length > 0 ? 'success' : errorCount > successCount ? 'blocked' : 'empty',
    itemCount: leads.length,
    durationMs: 0, // summary
    error: errorCount > 0 ? `${errorCount}/${feedsToFetch.length} feeds failed` : undefined,
  });

  // Deduplicate by URL
  const seen = new Set<string>();
  const deduped = leads.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  return { leads: deduped, diagnostics };
}

function parseCraigslistRSS(
  xml: string,
  city: string,
  query: string,
  maxItems: number,
): ScoutLead[] {
  const leads: ScoutLead[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && leads.length < maxItems) {
    const entry = match[1];
    const title = extractTag(entry, 'title');
    const link = extractTag(entry, 'link') || extractLink(entry);
    const description = extractTag(entry, 'description') || '';

    if (!title || !link) continue;

    // Craigslist includes prices in the dc:format or enc:price tag, or in the title
    // Most commonly it's in the title like "MacBook Pro 2021 - $800"
    const price = extractCraigslistPrice(title, description, entry);

    leads.push({
      title: decodeHTMLEntities(title),
      url: link,
      snippet: decodeHTMLEntities(stripHTML(description)).slice(0, 500),
      source: `craigslist-${city}`,
      priceFound: price,
      category: query,
    });
  }

  return leads;
}

/**
 * Extract price from Craigslist RSS item.
 * Craigslist typically puts the price at the end of the title: "Item name - $500"
 * Or sometimes in a dc:subject or enc:price tag.
 */
function extractCraigslistPrice(title: string, description: string, rawXml: string): number | null {
  // Try title first (most reliable on Craigslist)
  const titlePrice = extractPrice(title);
  if (titlePrice) return titlePrice;

  // Try description
  const descPrice = extractPrice(description);
  if (descPrice) return descPrice;

  // Try dc:format or other tags (some Craigslist feeds include structured price)
  const dcMatch = rawXml.match(/dc:format[^>]*>([^<]+)/i);
  if (dcMatch) {
    const p = extractPrice(dcMatch[1]);
    if (p) return p;
  }

  return null;
}

// ─── RSS Deal Feeds (free, no auth) ──────────────────────────────────

export async function fetchDealFeeds(): Promise<SourceResult<DealFeedItem>> {
  const feeds = [
    { url: 'https://www.reddit.com/r/deals/.rss', source: 'r/deals' },
    { url: 'https://www.reddit.com/r/flipping/.rss', source: 'r/flipping' },
    { url: 'https://www.reddit.com/r/buildapcsales/.rss', source: 'r/buildapcsales' },
    { url: 'https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1', source: 'Slickdeals' },
    { url: 'https://www.dealnews.com/rss/', source: 'DealNews' },
  ];

  const items: DealFeedItem[] = [];
  const diagnostics: SourceDiagnostic[] = [];

  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const start = Date.now();
      try {
        const feedItems = await fetchRSSFeed(feed.url, feed.source);
        diagnostics.push({
          source: feed.source,
          status: feedItems.length > 0 ? 'success' : 'empty',
          itemCount: feedItems.length,
          durationMs: Date.now() - start,
        });
        return feedItems;
      } catch (err) {
        diagnostics.push({
          source: feed.source,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          itemCount: 0,
          durationMs: Date.now() - start,
        });
        return [];
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    }
  }

  return { leads: items, diagnostics };
}

async function fetchRSSFeed(url: string, source: string): Promise<DealFeedItem[]> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Airbitrage/1.0 (arbitrage research tool)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!response.ok) return [];

    const xml = await response.text();
    return parseRSS(xml, source);
  } catch {
    return [];
  }
}

function parseRSS(xml: string, source: string): DealFeedItem[] {
  const items: DealFeedItem[] = [];

  // Simple regex-based RSS parser (no XML library needed)
  const entryRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = entryRegex.exec(xml)) !== null && items.length < 15) {
    const entry = match[1];
    const title = extractTag(entry, 'title');
    const link = extractLink(entry);
    const description = extractTag(entry, 'description') || extractTag(entry, 'content') || extractTag(entry, 'summary') || '';
    const pubDate = extractTag(entry, 'pubDate') || extractTag(entry, 'published') || extractTag(entry, 'updated') || '';

    if (title && link) {
      items.push({
        title: decodeHTMLEntities(title),
        url: link,
        description: decodeHTMLEntities(stripHTML(description)).slice(0, 500),
        source,
        pubDate,
      });
    }
  }

  return items;
}

// ─── Collectibles APIs (free tiers) ──────────────────────────────────

/**
 * Discogs API — free, rate-limited (60 req/min), no auth needed for public data.
 * Provides release data + lowest marketplace price + number for sale.
 *
 * Strategy: Search for popular releases, get marketplace lowest price,
 * compare against eBay/Amazon sold prices.
 */

export interface CollectibleLead extends ScoutLead {
  productId?: string;    // e.g. Discogs release ID, StockX slug
  marketAvg?: number;    // cents — market average price if available
}

const DISCOGS_SEARCH_TERMS = [
  // Vinyl — known high-value genres/artists
  'miles davis kind of blue vinyl', 'led zeppelin vinyl first pressing',
  'pink floyd dark side vinyl', 'radiohead ok computer vinyl',
  'beatles abbey road vinyl', 'nirvana nevermind vinyl',
  'fleetwood mac rumours vinyl', 'kendrick lamar vinyl',
  'tyler the creator vinyl', 'frank ocean vinyl',
  'daft punk random access vinyl', 'kanye west vinyl',
];

export async function fetchDiscogsListings(
  searchTerms?: string[],
): Promise<SourceResult<CollectibleLead>> {
  const leads: CollectibleLead[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const terms = searchTerms || DISCOGS_SEARCH_TERMS;
  const start = Date.now();

  // Search Discogs marketplace for each term
  for (const term of terms.slice(0, 10)) {
    try {
      const response = await fetch(
        `https://api.discogs.com/database/search?q=${encodeURIComponent(term)}&type=release&per_page=5`,
        {
          signal: AbortSignal.timeout(8000),
          headers: {
            'User-Agent': 'Airbitrage/1.0',
            Accept: 'application/json',
          },
        },
      );

      if (!response.ok) {
        diagnostics.push({
          source: 'Discogs',
          status: response.status === 429 ? 'blocked' : 'error',
          statusCode: response.status,
          error: `HTTP ${response.status} for "${term}"`,
          itemCount: 0,
          durationMs: Date.now() - start,
        });
        continue;
      }

      const data = await response.json();

      for (const result of (data.results || []).slice(0, 3)) {
        const releaseId = result.id;
        let lowestPrice: number | null = null;

        try {
          const statsResp = await fetch(
            `https://api.discogs.com/marketplace/stats/${releaseId}`,
            {
              signal: AbortSignal.timeout(5000),
              headers: {
                'User-Agent': 'Airbitrage/1.0',
                Accept: 'application/json',
              },
            },
          );

          if (statsResp.ok) {
            const stats = await statsResp.json();
            if (stats.lowest_price?.value) {
              lowestPrice = Math.round(stats.lowest_price.value * 100);
            }
          }
        } catch { /* skip stats lookup */ }

        leads.push({
          title: result.title || term,
          url: `https://www.discogs.com${result.uri || ''}`,
          snippet: `${result.title} — ${result.format?.join(', ') || 'Vinyl'} — ${result.country || ''} ${result.year || ''}`.slice(0, 500),
          source: 'Discogs',
          priceFound: lowestPrice,
          category: 'vinyl',
          productId: String(releaseId),
          marketAvg: lowestPrice ?? undefined,
        });
      }
    } catch (err) {
      diagnostics.push({
        source: 'Discogs',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        itemCount: 0,
        durationMs: Date.now() - start,
      });
    }

    // Rate limit: Discogs allows 60/min = 1/sec
    await new Promise(resolve => setTimeout(resolve, 1100));
  }

  diagnostics.push({
    source: 'Discogs (summary)',
    status: leads.length > 0 ? 'success' : 'empty',
    itemCount: leads.length,
    durationMs: Date.now() - start,
  });

  return { leads, diagnostics };
}

/**
 * Kicks.dev — free tier for StockX product data (~175K products).
 * Provides current market prices for sneakers.
 * API: https://api.kicks.dev/v1/products?search={term}
 */

const SNEAKER_SEARCH_TERMS = [
  'jordan 1 retro high', 'jordan 4 retro', 'jordan 11 retro',
  'yeezy boost 350', 'yeezy slide', 'nike dunk low',
  'nike sb dunk', 'new balance 550', 'new balance 2002r',
  'adidas samba', 'asics gel kayano',
];

export async function fetchSneakerPrices(
  searchTerms?: string[],
): Promise<SourceResult<CollectibleLead>> {
  const leads: CollectibleLead[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const terms = searchTerms || SNEAKER_SEARCH_TERMS;
  const start = Date.now();

  for (const term of terms.slice(0, 8)) {
    try {
      const response = await fetch(
        `https://api.kicks.dev/v1/products?search=${encodeURIComponent(term)}&limit=5`,
        {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        },
      );

      if (!response.ok) {
        diagnostics.push({
          source: 'kicks.dev',
          status: response.status === 429 ? 'blocked' : 'error',
          statusCode: response.status,
          error: `HTTP ${response.status} for "${term}"`,
          itemCount: 0,
          durationMs: Date.now() - start,
        });
        continue;
      }

      const data = await response.json();

      for (const product of (data.products || data.data || []).slice(0, 3)) {
        const retailPrice = product.retailPrice
          ? Math.round(product.retailPrice * 100)
          : null;
        const lastSale = product.lastSale
          ? Math.round(product.lastSale * 100)
          : null;
        const lowestAsk = product.lowestAsk
          ? Math.round(product.lowestAsk * 100)
          : null;

        const buyPrice = retailPrice || lowestAsk;
        const slug = product.slug || product.urlKey || '';

        leads.push({
          title: product.name || product.title || term,
          url: slug ? `https://stockx.com/${slug}` : `https://stockx.com/search?s=${encodeURIComponent(term)}`,
          snippet: `${product.name || term} — Retail: $${retailPrice ? (retailPrice/100).toFixed(0) : '?'}, Last Sale: $${lastSale ? (lastSale/100).toFixed(0) : '?'}, Lowest Ask: $${lowestAsk ? (lowestAsk/100).toFixed(0) : '?'}`,
          source: 'StockX',
          priceFound: buyPrice,
          category: 'sneakers',
          productId: slug,
          marketAvg: lastSale || lowestAsk || undefined,
        });
      }
    } catch (err) {
      diagnostics.push({
        source: 'kicks.dev',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        itemCount: 0,
        durationMs: Date.now() - start,
      });
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  diagnostics.push({
    source: 'kicks.dev (summary)',
    status: leads.length > 0 ? 'success' : 'empty',
    itemCount: leads.length,
    durationMs: Date.now() - start,
  });

  return { leads, diagnostics };
}

// ─── Government Auction Feeds (free, public data) ────────────────────

/**
 * Fetch auction listings from government surplus/seized goods sites.
 * These often have items at huge discounts because most buyers don't know about them.
 *
 * GSA Auctions: https://gsaauctions.gov — federal surplus
 * GovDeals: https://www.govdeals.com — state/local government surplus
 */

export async function fetchGovAuctions(
  tavilyApiKey?: string,
): Promise<SourceResult<ScoutLead>> {
  const leads: ScoutLead[] = [];
  const diagnostics: SourceDiagnostic[] = [];

  // Strategy: Use Tavily site: searches for government auction sites
  // The old RSS URLs were fabricated and didn't work.
  if (!tavilyApiKey) {
    diagnostics.push({
      source: 'Gov Auctions',
      status: 'error',
      error: 'No Tavily API key provided',
      itemCount: 0,
      durationMs: 0,
    });
    return { leads, diagnostics };
  }

  const govQueries = [
    'site:govdeals.com electronics auction current',
    'site:govdeals.com tools equipment lot auction',
    'site:govdeals.com vehicles surplus auction',
    'site:publicsurplus.com auction electronics lot',
    'site:gsaauctions.gov surplus equipment',
  ];

  const start = Date.now();

  for (const query of govQueries) {
    try {
      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query,
          max_results: 5,
          include_raw_content: false,
          include_answer: false,
        }),
      });

      if (!response.ok) {
        diagnostics.push({
          source: `Gov Auctions (${query.split(' ')[0]})`,
          status: 'error',
          statusCode: response.status,
          error: `HTTP ${response.status}`,
          itemCount: 0,
          durationMs: Date.now() - start,
        });
        continue;
      }

      const data = await response.json();

      for (const r of data.results || []) {
        const snippet = (r.content as string || '').slice(0, 500);
        const url = r.url || '';

        leads.push({
          title: r.title || '',
          url,
          snippet,
          source: url.includes('govdeals') ? 'GovDeals'
            : url.includes('publicsurplus') ? 'PublicSurplus'
            : url.includes('gsaauctions') ? 'GSA Auctions'
            : 'Gov Auction',
          priceFound: extractPrice(r.title + ' ' + snippet),
          category: 'government-auction',
        });
      }
    } catch (err) {
      diagnostics.push({
        source: 'Gov Auctions',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        itemCount: 0,
        durationMs: Date.now() - start,
      });
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  diagnostics.push({
    source: 'Gov Auctions (summary)',
    status: leads.length > 0 ? 'success' : 'empty',
    itemCount: leads.length,
    durationMs: Date.now() - start,
  });

  return { leads, diagnostics };
}

// ─── eBay Browse (Tavily-based search as fallback) ──────────────────

export async function searchEbayListings(
  queries: string[],
  tavilyApiKey: string,
): Promise<ScoutLead[]> {
  // eBay's Browse API requires OAuth which is complex to set up.
  // Instead, we do targeted eBay searches via Tavily which finds real eBay listings.
  const ebayQueries = queries.map(q => `site:ebay.com ${q} auction ending soon`);
  const soldQueries = queries.map(q => `site:ebay.com "${q}" sold price`);

  const [listings, soldData] = await Promise.all([
    tavilyBatchSearch(ebayQueries, tavilyApiKey, 5),
    tavilyBatchSearch(soldQueries, tavilyApiKey, 3),
  ]);

  // Tag the source
  return [...listings, ...soldData].map(l => ({ ...l, source: 'eBay' }));
}

// ─── Open Library API (free, no auth, ISBN-based) ────────────────────

/**
 * Open Library API — completely free, no auth, no rate limits (be polite).
 * Strategy: Search for books by subject/keyword, get ISBNs, then
 * use ISBN for identity resolution when comparing prices.
 *
 * API: https://openlibrary.org/search.json?q={term}&limit=10
 */

export interface BookLead extends ScoutLead {
  isbn?: string;
  author?: string;
  publishYear?: number;
}

const BOOK_SEARCH_TERMS = [
  // High-value textbook categories
  'medical textbook', 'organic chemistry textbook', 'calculus textbook',
  'nursing textbook', 'anatomy physiology textbook',
  // Programming & tech (always resellable)
  'algorithms data structures', 'machine learning textbook',
  'system design interview', 'design patterns programming',
  // High-value niche
  'first edition signed', 'art photography monograph',
  'architecture coffee table book', 'vintage cookbook',
];

export async function fetchOpenLibraryBooks(
  searchTerms?: string[],
): Promise<SourceResult<BookLead>> {
  const leads: BookLead[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const terms = searchTerms || BOOK_SEARCH_TERMS;
  const start = Date.now();

  for (const term of terms.slice(0, 8)) {
    try {
      const response = await fetch(
        `https://openlibrary.org/search.json?q=${encodeURIComponent(term)}&limit=10&fields=key,title,author_name,first_publish_year,isbn,cover_i,number_of_pages_median`,
        {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        },
      );

      if (!response.ok) {
        diagnostics.push({
          source: 'Open Library',
          status: 'error',
          statusCode: response.status,
          error: `HTTP ${response.status} for "${term}"`,
          itemCount: 0,
          durationMs: Date.now() - start,
        });
        continue;
      }

      const data = await response.json();

      for (const doc of (data.docs || []).slice(0, 5)) {
        const isbn = doc.isbn?.[0] || null;
        const title = doc.title || '';
        const author = doc.author_name?.[0] || 'Unknown';

        if (!title) continue;

        leads.push({
          title: `${title} by ${author}`,
          url: isbn
            ? `https://www.amazon.com/dp/${isbn}`
            : `https://openlibrary.org${doc.key || ''}`,
          snippet: `${title} by ${author} (${doc.first_publish_year || 'unknown year'}) — ISBN: ${isbn || 'N/A'} — ${doc.number_of_pages_median || '?'} pages`,
          source: 'Open Library',
          priceFound: null, // Open Library doesn't have prices — book resale lookup will find them
          category: term,
          isbn: isbn || undefined,
          author,
          publishYear: doc.first_publish_year || undefined,
        });
      }
    } catch (err) {
      diagnostics.push({
        source: 'Open Library',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        itemCount: 0,
        durationMs: Date.now() - start,
      });
    }

    // Be polite to Open Library
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  diagnostics.push({
    source: 'Open Library (summary)',
    status: leads.length > 0 ? 'success' : 'empty',
    itemCount: leads.length,
    durationMs: Date.now() - start,
  });

  return { leads, diagnostics };
}

// ─── Utility Functions ──────────────────────────────────────────────

/**
 * Clean a deal/listing title for use in search URLs.
 * Strips bracketed tags, prices, discount info, and source labels.
 * "[Tracker] Samsung SmartTag2 (4 pack) $44.99 (55% off $100)" → "Samsung SmartTag2 4 pack"
 */
export function cleanTitleForSearch(title: string): string {
  let cleaned = title
    // Remove bracketed tags: [Tracker], [Deal], [Price Drop], etc.
    .replace(/\[[^\]]*\]/g, '')
    // Remove parenthesized discount/price info: (55% off $100), (was $180), (reg $50), etc.
    .replace(/\(\s*\d+%\s*off[^)]*\)/gi, '')
    .replace(/\(\s*(?:was|reg|originally|msrp|retail|regular(?:\s+price)?)\s*\$[\d,.]+\s*\)/gi, '')
    .replace(/\(\s*\$[\d,.]+\s*(?:off|savings?|discount)\s*\)/gi, '')
    // Remove standalone dollar amounts: $44.99, $100
    .replace(/\$\s?[\d,]+(?:\.\d{2})?/g, '')
    // Remove standalone percentage patterns: 55% off, 70% discount
    .replace(/\d+%\s*(?:off|discount|savings?)/gi, '')
    // Remove common deal-feed source tags
    .replace(/\/r\/\w+/g, '')
    .replace(/\b(?:via|from|at|@)\s+\w+\.com/gi, '')
    // Remove "Free Shipping" and similar
    .replace(/\bfree\s+shipping\b/gi, '')
    // Clean up parentheses that are now empty or near-empty
    .replace(/\(\s*\)/g, '')
    // Collapse multiple spaces and trim
    .replace(/\s+/g, ' ')
    .trim();

  // Cap at 80 chars at a word boundary
  if (cleaned.length > 80) {
    cleaned = cleaned.slice(0, 80);
    const lastSpace = cleaned.lastIndexOf(' ');
    if (lastSpace > 40) {
      cleaned = cleaned.slice(0, lastSpace);
    }
  }

  return cleaned;
}

/** Extract price from text. Returns cents or null. */
export function extractPrice(text: string): number | null {
  // Match patterns like $45.99, $1,200, $45, etc.
  const patterns = [
    /\$\s?([\d,]+(?:\.\d{2})?)/g,          // $45.99, $1,200.00
    /USD\s?([\d,]+(?:\.\d{2})?)/gi,         // USD 45.99
    /price[:\s]+\$?([\d,]+(?:\.\d{2})?)/gi, // price: 45.99
  ];

  const prices: number[] = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const num = parseFloat(match[1].replace(/,/g, ''));
      if (num > 0 && num < 1000000) { // sanity check
        prices.push(Math.round(num * 100)); // convert to cents
      }
    }
  }

  // Return the first (most prominent) price found
  return prices.length > 0 ? prices[0] : null;
}

/** Extract all prices from text. Returns array of cents values. */
export function extractAllPrices(text: string): number[] {
  const prices: number[] = [];
  const pattern = /\$\s?([\d,]+(?:\.\d{2})?)/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (num > 0 && num < 1000000) {
      prices.push(Math.round(num * 100));
    }
  }

  return prices;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'unknown';
  }
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdataMatch) return cdataMatch[1];

  const match = xml.match(new RegExp(`<${tag}[^>]*>(.*?)<\\/${tag}>`, 'is'));
  return match ? match[1].trim() : '';
}

function extractLink(xml: string): string {
  // Try <link href="..."> first (Atom format)
  const atomMatch = xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (atomMatch) return atomMatch[1];

  // Then try <link>...</link> (RSS format)
  const rssMatch = xml.match(/<link[^>]*>(.*?)<\/link>/i);
  if (rssMatch) return rssMatch[1].trim();

  return '';
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Score URL quality to filter out non-listing pages.
 * Returns 'listing' for actual product/item pages,
 * 'generic' for possibly useful pages, or 'skip' for junk.
 */
function scoreUrlQuality(url: string): 'listing' | 'generic' | 'skip' {
  const lower = url.toLowerCase();

  // Skip: search results pages, category pages, blog aggregators
  const skipPatterns = [
    /google\.com\/search/,
    /bing\.com\/search/,
    /duckduckgo\.com/,
    /\/search\?/,
    /\/search\//,
    /\/category\//,
    /\/tag\//,
    /\/blog\/?$/,
    /\/news\/?$/,
    /\/wiki\//,
    /wikipedia\.org/,
    /youtube\.com/,
    /reddit\.com\/r\/\w+\/?$/,  // subreddit index (but allow individual posts)
    /\/about\/?$/,
    /\/contact\/?$/,
    /\/faq/,
  ];

  for (const pattern of skipPatterns) {
    if (pattern.test(lower)) return 'skip';
  }

  // Listing: actual product/item pages on marketplaces
  const listingPatterns = [
    /ebay\.com\/itm\//,           // eBay item page
    /ebay\.com\/p\//,             // eBay product page
    /amazon\.com\/dp\//,          // Amazon product
    /amazon\.com\/gp\/product/,   // Amazon product
    /amazon\.com\/.*\/dp\//,      // Amazon product with title
    /craigslist\.org\/.*\/\d+\.html/,  // Craigslist listing
    /offerup\.com\/item\//,       // OfferUp item
    /facebook\.com\/marketplace\/item/, // FB Marketplace item
    /stockx\.com\/.*[a-z]/,       // StockX product
    /goat\.com\/sneakers\//,      // GOAT product
    /tcgplayer\.com\/product\//,  // TCGPlayer product
    /discogs\.com\/.*\/release\//,// Discogs release
    /ticketmaster\.com\/event\//,  // Ticketmaster event
    /stubhub\.com\/.*-tickets\//,  // StubHub listing
    /seatgeek\.com\/.*\/tickets/,  // SeatGeek event
    /target\.com\/p\//,           // Target product
    /walmart\.com\/ip\//,         // Walmart product
    /bestbuy\.com\/.*\/\d+\.p/,   // Best Buy product
    /mercari\.com\/item\//,       // Mercari item
    /poshmark\.com\/listing\//,   // Poshmark listing
    /govdeals\.com\/.*itemid=/i, // GovDeals listing
    /publicsurplus\.com\/sms\/auction\/view/i, // PublicSurplus listing
    /gsaauctions\.gov\/.*\/auction\//i, // GSA Auction listing
    /estatesales\.net\/.*\/sale\//i, // EstateSales.net sale
    /hibid\.com\/.*\/lot\//i,    // HiBid lot
    /maxsold\.com\/.*\/auction\//i, // MaxSold auction
  ];

  for (const pattern of listingPatterns) {
    if (pattern.test(lower)) return 'listing';
  }

  // Generic but possibly useful — allow through
  return 'generic';
}

/** Check if a URL is a direct item listing (not a search page or category) */
export function isListingUrl(url: string): boolean {
  return scoreUrlQuality(url) === 'listing';
}
