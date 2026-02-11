/**
 * Scout-then-Snipe runner — the new agent execution pattern.
 *
 * Phase 1: SCOUT (cheap, no Claude)
 *   - Hit free APIs, RSS feeds, Tavily searches to gather raw leads
 *   - Extract prices programmatically
 *   - Look up resale prices via Tavily
 *   - Filter to only leads with confirmed price spreads
 *
 * Phase 2: SNIPE (Claude, targeted)
 *   - Send ONLY pre-qualified leads to Claude
 *   - Claude verifies, calculates exact fees, writes reasoning
 *   - One focused Claude call instead of 5+ blind ones
 */

import {
  tavilyBatchSearch,
  fetchCryptoPrices,
  fetchDealFeeds,
  searchEbayListings,
  fetchCraigslistRSS,
  fetchGovAuctions,
  fetchDiscogsListings,
  fetchSneakerPrices,
  fetchOpenLibraryBooks,
  ScoutLead,
  CryptoPrice,
  CraigslistConfig,
  SourceDiagnostic,
  BookLead,
  extractPrice,
  extractAllPrices,
  isListingUrl,
} from './sources';
import {
  findCryptoSpreads,
  filterLeadsWithPriceData,
  filterDealFeedItems,
  batchResaleLookup,
  batchBookResaleLookup,
  qualifyCollectiblesDirectly,
  QualifiedLead,
  CryptoSpread,
} from './filter';
import { callClaude, ClaudeResponse, ClaudeMessage, ClaudeContentBlock } from '@/lib/claude';
import { checkBudget, recordUsage, loadBudgetConfig, estimateCost } from '@/lib/budget';
import { AgentType } from '@/types';
import { ParsedOpportunity, AgentProgressEvent } from '../base-agent';

// ─── Types ───────────────────────────────────────────────────────────

export interface ScoutSnipeConfig {
  agentType: AgentType;
  apiKey: string;
  tavilyApiKey: string;
}

export interface ScoutSnipeResult {
  success: boolean;
  opportunities: ParsedOpportunity[];
  reasoning: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  estimatedCost: number;
  scoutStats: {
    leadsFound: number;
    leadsQualified: number;
    sourcesChecked: string[];
    diagnostics?: SourceDiagnostic[];
  };
  error?: string;
  abortReason?: string;
}

// ─── Per-Agent Scout Configs ─────────────────────────────────────────

interface AgentScoutConfig {
  searchQueries: string[];
  useEbaySearch: boolean;
  useDealFeeds: boolean;
  useCryptoAPIs: boolean;
  useCraigslistRSS: boolean;
  useGovAuctions: boolean;
  useCollectiblesAPIs: boolean;
  useOpenLibrary: boolean;
  craigslistConfig?: CraigslistConfig;
  cryptoPairs?: string[];
  minProfitCents: number;
  minSpreadPercent: number;
  snipeSystemPrompt: string;
}

function getScoutConfig(agentType: AgentType, userConfig: Record<string, unknown> = {}): AgentScoutConfig {
  const categories = (userConfig.categories as string[]) || [];
  const region = (userConfig.region as string) || 'US';

  switch (agentType) {
    case 'listings':
      return {
        searchQueries: [
          // Targeted listing-path queries for actual marketplace listings
          ...(categories.length > 0 ? categories.flatMap(cat => [
            `site:offerup.com/item ${cat} for sale`,
            `site:mercari.com/item ${cat}`,
          ]) : [
            `site:offerup.com/item/ macbook pro`,
            `site:offerup.com/item/ iphone 15`,
            `site:mercari.com/item/ herman miller aeron`,
            `site:mercari.com/item/ dyson vacuum`,
            `site:offerup.com/item/ milwaukee tools`,
            `site:offerup.com/item/ nintendo switch`,
          ]),
        ],
        useEbaySearch: false,
        useDealFeeds: false,
        useCryptoAPIs: false,
        useCraigslistRSS: true,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        craigslistConfig: {
          cities: region ? [region.toLowerCase().replace(/\s+/g, '')] : [],
          categories: categories.length > 0 ? categories : ['electronics', 'furniture', 'tools', 'musical'],
          queries: categories.length > 0 ? categories : [], // Empty = use HIGH_RESALE_BRANDS default
        },
        minProfitCents: (userConfig.minProfitCents as number) || 1000,
        minSpreadPercent: 15,
        snipeSystemPrompt: SNIPE_PROMPTS.listings,
      };

    case 'auctions':
      return {
        searchQueries: [
          ...categories.flatMap(cat => [
            `site:ebay.com/itm ${cat} auction`,
            `site:estatesales.net ${cat} lot`,
            `site:hibid.com ${cat} lot`,
          ]),
          ...(categories.length === 0 ? [
            // eBay actual item pages
            `site:ebay.com/itm vintage electronics auction`,
            `site:ebay.com/itm camera lens auction`,
            `site:ebay.com/itm vintage watch lot`,
            `site:ebay.com/itm audio equipment lot`,
            `site:ebay.com/itm power tools lot auction`,
            `site:ebay.com/itm musical instrument auction`,
            // Estate sale platforms with real listing pages
            `site:estatesales.net electronics lot sale`,
            `site:estatesales.net tools equipment`,
            `site:hibid.com electronics lot`,
            `site:hibid.com equipment tools lot`,
            `site:maxsold.com electronics auction`,
            `site:auctionninja.com lot auction`,
          ] : []),
        ],
        useEbaySearch: true,
        useDealFeeds: false,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: true,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        minProfitCents: (userConfig.minProfitCents as number) || 1000,
        minSpreadPercent: 15,
        snipeSystemPrompt: SNIPE_PROMPTS.auctions,
      };

    case 'crypto':
      return {
        searchQueries: [],
        useEbaySearch: false,
        useDealFeeds: false,
        useCryptoAPIs: true,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        cryptoPairs: (userConfig.pairs as string[]) || [
          // Major pairs
          'BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD',
          // Mid-cap — more likely to have spreads
          'DOGE/USD', 'ADA/USD', 'AVAX/USD', 'DOT/USD',
          'LINK/USD', 'UNI/USD', 'ATOM/USD', 'NEAR/USD',
          'FIL/USD', 'APT/USD', 'ARB/USD', 'OP/USD',
          'LTC/USD', 'BCH/USD', 'ETC/USD', 'ALGO/USD',
          // Stablecoin arb (USDT premium)
          'BTC/USDT', 'ETH/USDT',
        ],
        minProfitCents: 0,
        minSpreadPercent: (userConfig.minSpreadPercent as number) || 0.15, // lowered from 0.3%
        snipeSystemPrompt: SNIPE_PROMPTS.crypto,
      };

    case 'retail':
      return {
        searchQueries: [
          ...categories.flatMap(cat => [
            `site:brickseek.com/walmart-clearance-checker ${cat}`,
            `site:brickseek.com/target-clearance-checker ${cat}`,
            `"clearance" "${cat}" "$" "was $" OR "reg $" OR "% off"`,
          ]),
          ...(categories.length === 0 ? [
            // Product-specific clearance with price signals
            `site:brickseek.com/walmart-clearance-checker`,
            `site:brickseek.com/target-clearance-checker`,
            // Specific products on clearance — these are more likely to have real prices
            `"dyson" "clearance" "$" site:target.com/p OR site:walmart.com/ip`,
            `"ninja" OR "instant pot" "clearance" "$" site:target.com/p OR site:walmart.com/ip`,
            `"lego" "clearance" "$" site:target.com/p OR site:walmart.com/ip`,
            `"airpods" "open box" OR "clearance" "$" site:bestbuy.com`,
            `"kitchenaid" "clearance" "$" site:target.com/p OR site:walmart.com/ip`,
            `"nintendo switch" "clearance" OR "open box" "$" site:bestbuy.com`,
            // Deal-specific pages with actual prices
            `site:slickdeals.net "clearance" "$" "was $" this week`,
            `site:dealnews.com clearance "70% off" OR "80% off" "$"`,
            // Amazon warehouse / open box
            `site:amazon.com/dp "renewed" OR "open box" "was $"`,
            `amazon warehouse deals electronics open box price`,
            // Specific high-margin products
            `"roomba" "clearance" OR "refurbished" "$" site:amazon.com OR site:walmart.com`,
            `"sonos" "open box" OR "refurbished" "$" site:bestbuy.com`,
            `"vitamix" "clearance" OR "refurbished" "$"`,
          ] : []),
        ],
        useEbaySearch: false,
        useDealFeeds: true,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        minProfitCents: (userConfig.minProfitCents as number) || 1000,
        minSpreadPercent: 20,
        snipeSystemPrompt: SNIPE_PROMPTS.retail,
      };

    case 'tickets':
      return {
        searchQueries: [
          // Specific high-demand events & artists
          `sold out concert tickets 2025 face value available`,
          `ticketmaster presale code concert this week`,
          `stubhub cheapest tickets popular concert`,
          `seatgeek best deals concert tickets`,
          `vividseats cheap tickets sold out show`,
          // Sports
          `nba playoff tickets face value 2025`,
          `nfl tickets below face value`,
          `mlb tickets cheap deals this week`,
          `premier league tickets resale price`,
          `champions league tickets for sale`,
          `march madness tickets face value`,
          // Concerts & festivals
          `taylor swift eras tour tickets resale price`,
          `beyonce concert tickets for sale`,
          `coachella tickets face value below resale`,
          `lollapalooza festival tickets cheap`,
          `sold out concert tickets available primary`,
          // Specific arbitrage searches
          `tickets face value vs stubhub resale price`,
          `concert tickets resale profit 2025`,
          `underpriced tickets secondary market`,
          `event tickets below market value`,
          ...(userConfig.eventTypes as string[] || []).flatMap(t => [
            `${t} tickets for sale this month`,
            `${t} tickets face value below resale`,
            `${t} tickets cheap deal 2025`,
          ]),
        ],
        useEbaySearch: false,
        useDealFeeds: false,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        minProfitCents: (userConfig.minProfitCents as number) || 1500,
        minSpreadPercent: 15,
        snipeSystemPrompt: SNIPE_PROMPTS.tickets,
      };

    case 'collectibles':
      return {
        searchQueries: [
          ...categories.flatMap(cat => [
            `site:ebay.com/itm ${cat} buy it now`,
            `site:mercari.com/item ${cat}`,
          ]),
          ...(categories.length === 0 ? [
            // Sneakers — actual listing pages
            `site:ebay.com/itm jordan retro buy it now`,
            `site:mercari.com/item/ jordan sneakers`,
            `site:mercari.com/item/ yeezy`,
            // Pokemon/Trading cards
            `site:ebay.com/itm pokemon booster box`,
            `site:mercari.com/item/ pokemon cards lot`,
            `site:tcgplayer.com/product pokemon`,
            // Vinyl
            `site:ebay.com/itm vinyl record first pressing`,
            `site:mercari.com/item/ vinyl records lot`,
            // LEGO
            `site:ebay.com/itm lego retired set sealed`,
            `site:mercari.com/item/ lego set`,
            // Other collectibles
            `site:ebay.com/itm funko pop exclusive`,
            `site:mercari.com/item/ hot wheels`,
          ] : []),
        ],
        useEbaySearch: true,
        useDealFeeds: false,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: true,
        useOpenLibrary: false,
        minProfitCents: (userConfig.minProfitCents as number) || 1000,
        minSpreadPercent: 15,
        snipeSystemPrompt: SNIPE_PROMPTS.collectibles,
      };

    case 'books':
      return {
        searchQueries: [
          ...categories.flatMap(cat => [
            `${cat} used books cheap lot for sale`,
            `${cat} amazon fba profitable books`,
            `site:ebay.com ${cat} book lot`,
          ]),
          ...(categories.length === 0 ? [
            // Textbooks
            `used textbooks for sale cheap lot`,
            `college textbook lot for sale`,
            `medical textbook used for sale cheap`,
            `engineering textbook used cheap`,
            `site:ebay.com textbook lot`,
            // Valuable books
            `out of print books for sale`,
            `rare first edition book for sale`,
            `signed book for sale cheap`,
            `vintage book lot for sale`,
            // Sourcing
            `thrift store book haul valuable finds`,
            `library book sale this week`,
            `used books lot for sale cheap bulk`,
            `estate sale books lot`,
            // Specific profitable niches
            `technical programming book used for sale`,
            `art book coffee table for sale cheap`,
            `vintage cookbook for sale lot`,
            `children book lot for sale`,
            `site:ebay.com book lot buy it now`,
            `amazon fba book arbitrage finds`,
          ] : []),
        ],
        useEbaySearch: true,
        useDealFeeds: false,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: true,
        minProfitCents: (userConfig.minProfitCents as number) || 500,
        minSpreadPercent: 20,
        snipeSystemPrompt: SNIPE_PROMPTS.books,
      };

    default:
      return {
        searchQueries: [],
        useEbaySearch: false,
        useDealFeeds: false,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        minProfitCents: 2000,
        minSpreadPercent: 30,
        snipeSystemPrompt: 'Analyze the following leads and identify real arbitrage opportunities.',
      };
  }
}

// ─── Snipe Prompts (what Claude sees) ────────────────────────────────

const SNIPE_PROMPTS: Record<string, string> = {
  listings: `You are the Listings Agent for Airbitrage. You are being given PRE-SCREENED leads — items found on Craigslist and local marketplaces where our automated system has already detected a potential price spread.

Your job: Verify each lead and produce structured opportunity data.

SELL PRICE VERIFICATION:
- Leads marked "VERIFIED" have sell prices confirmed from real marketplace listings. Trust these.
- Leads marked "ESTIMATED" have rough sell prices. Use the search_sold_prices tool to verify before including.
- Leads marked "UNKNOWN" have no sell price. Use the search_sold_prices tool to find the real sell price.
- Only present sell prices you are confident in. Set sellPriceType accordingly.

RULES:
- The buy and sell items should be the same product (brand, model). If you can reasonably identify the product from the title, include it.
- Use the actual URLs from the lead data. For sell URLs, use the best listing URL from your search results.
- Calculate fees using standard platform rates (eBay: 13.13% + $0.30, Amazon: 15%)
- Add shipping estimates (small: $5, medium: $12, large: $25)
- Assign a confidence score (0-100). Craigslist/Marketplace listings with direct URLs get +10. Search/category page URLs get -20.
- Note condition risks for used items.

Output opportunities where net profit > $10 after all fees. Be generous — surface marginal opportunities and let the user decide.`,

  auctions: `You are the Auction Agent for Airbitrage. You are being given PRE-SCREENED auction leads where our system detected potential value.

Your job: Verify each lead and produce structured opportunity data.

SELL PRICE VERIFICATION:
- Leads marked "VERIFIED" have sell prices confirmed from real marketplace listings. Trust these.
- Leads marked "ESTIMATED" have rough sell prices. Use the search_sold_prices tool to verify before including.
- Leads marked "UNKNOWN" have no sell price. Use the search_sold_prices tool to find the real sell price.
- Only present sell prices you are confident in. Set sellPriceType accordingly.

RULES:
- The buy and sell items should be the same product. If you can identify the product from the title, include it.
- Use the actual URLs from the lead data. For sell URLs, use the best listing URL from your search results.
- Check if the current bid/price is below market value for this item
- Factor in buyer premium, shipping, and resale fees (eBay: 13.13%)
- Assign confidence based on data quality. Deduct 20 points for search-page URLs.
- Note sniping risks and bid competition.

Output opportunities where net profit > $10 after all fees. Be generous — let the user decide.`,

  crypto: `You are the Crypto Agent for Airbitrage. You are being given REAL-TIME price data from exchange APIs showing cross-exchange spreads.

Your job: Verify each spread and produce structured opportunity data.
- Confirm the spread is real and significant
- Calculate trading fees (0.1% maker/taker on both sides typically)
- Estimate withdrawal fees (BTC ~$5-15, ETH ~$5-20, stablecoins ~$1-5)
- Account for transfer time (spreads may close during transfer)
- Assign confidence based on spread size vs. typical volatility

Note: All prices provided are LIVE from exchange APIs. Convert USD amounts to cents for output.`,

  retail: `You are the Retail Agent for Airbitrage. You are being given PRE-SCREENED retail deals from clearance feeds and deal aggregators where deep discounts were detected.

Your job: Verify each deal and produce structured opportunity data.

SELL PRICE VERIFICATION:
- Leads marked "VERIFIED" have sell prices confirmed from real eBay sold listings. Trust these.
- Leads marked "ESTIMATED" have rough sell prices (often just the regular retail price). Use the search_sold_prices tool to find ACTUAL resale prices on eBay.
- Leads marked "UNKNOWN" have no sell price. Use the search_sold_prices tool to find the real sell price.
- Only present sell prices you are confident in. Set sellPriceType accordingly.
- The sell price should be what the item ACTUALLY SELLS FOR on eBay/Amazon, NOT the regular retail price.

RULES:
- When the lead clearly identifies a specific product (brand + model), you should output it as an opportunity even if the URL is a category/search page. Use the title and description to identify the product.
- Use the actual URLs from the lead data. For sell URLs, use the best listing URL from your search results.
- If the lead is too generic (e.g. "Walmart clearance" with no specific product), skip it.
- Confirm the clearance/deal price is plausible (not obviously wrong)
- Factor in Amazon FBA fees (15% referral + ~$3-5 fulfillment) or eBay fees (13.13%)
- Consider whether the item has resale demand (brand name items are better)
- If the item is gated on Amazon, note it in riskNotes.

Output opportunities where net profit > $10 after all fees. Be generous — it's better to surface a marginal opportunity than to miss a good one. The user can decide.`,

  tickets: `You are the Tickets Agent for Airbitrage. You are being given leads about events where ticket price spreads may exist between primary and secondary markets.

Your job: Verify each lead and produce structured opportunity data.

SELL PRICE VERIFICATION:
- Leads marked "VERIFIED" have sell prices confirmed. Trust these.
- Leads marked "ESTIMATED" or "UNKNOWN" need verification. Use the search_sold_prices tool if available.
- Only present sell prices you are confident in. Set sellPriceType accordingly.

CRITICAL RULES:
- The buy and sell MUST be for the EXACT SAME event, venue, date, and comparable section. Do NOT compare tickets for different events or sections.
- Use ONLY the actual URLs from the lead data. Never invent URLs.
- Check if face-value tickets are actually available at the stated price
- Compare against secondary market prices (StubHub, SeatGeek, VividSeats) for the SAME event
- Factor in seller fees (StubHub: ~15%, SeatGeek: ~15%)
- Consider event date proximity and demand trends. Deduct 20 points if URLs are search pages.
- Note transfer restrictions and anti-scalping rules

Only output opportunities where net profit > $30 after all fees.`,

  collectibles: `You are the Collectibles Agent for Airbitrage. You are being given PRE-SCREENED leads for collectible items where our system detected pricing below market averages.

Your job: Verify each lead and produce structured opportunity data.

SELL PRICE VERIFICATION:
- Leads marked "VERIFIED" have sell prices confirmed from real marketplace data (StockX, eBay sold). Trust these.
- Leads marked "ESTIMATED" have rough sell prices (e.g. Discogs-to-eBay estimate). Use the search_sold_prices tool to verify.
- Leads marked "UNKNOWN" have no sell price. Use the search_sold_prices tool to find the real sell price.
- Only present sell prices you are confident in. Set sellPriceType accordingly.

RULES:
- The buy and sell should be the same product. If you can identify the specific item (name, colorway, set number), include it.
- Use the actual URLs from the lead data.
- Factor in platform fees (StockX: 9.5%, GOAT: 9.5%+$5, eBay: 13.13%)
- Consider authentication costs and shipping.
- Deduct 20 confidence points for search-page URLs.
- Note authenticity risks and condition concerns.

Output opportunities where net profit > $10 after all fees. Be generous — surface marginal opportunities and let the user decide.`,

  books: `You are the Books/Media Agent for Airbitrage. You are being given PRE-SCREENED leads for books and media where our system detected pricing below Amazon/eBay resale values.

Your job: Verify each lead and produce structured opportunity data.

SELL PRICE VERIFICATION:
- Leads marked "VERIFIED" have sell prices confirmed from real marketplace listings. Trust these.
- Leads marked "ESTIMATED" have rough sell prices. Use the search_sold_prices tool to verify before including.
- Leads marked "UNKNOWN" have no sell price. Use the search_sold_prices tool to find the real sell price.
- Only present sell prices you are confident in. Set sellPriceType accordingly.

RULES:
- The buy and sell should be the same book (same title, edition if identifiable).
- Use the actual URLs from the lead data.
- Factor in Amazon FBA fees (15% referral + $3.22 fulfillment for standard books)
- Books are typically bought at thrift stores/library sales for $1-$3 and resold for $10-$80+
- Include ISBN in the description when available.
- Deduct 20 confidence points for search-page URLs.

Output opportunities where net profit > $5 after all fees. Books have very low buy costs, so even modest sell prices can be profitable.`,
};

// ─── The Main Runner ─────────────────────────────────────────────────

export async function runScoutThenSnipe(
  config: ScoutSnipeConfig,
  userConfig: Record<string, unknown> = {},
  onProgress?: (event: AgentProgressEvent) => void,
): Promise<ScoutSnipeResult> {
  const agentConfig = getScoutConfig(config.agentType, userConfig);
  const sourcesChecked: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  onProgress?.({ type: 'started', message: 'Scout phase starting — gathering leads from free sources…' });

  // Global timeout — abort the entire run after 3 minutes to prevent hanging
  const runTimeout = setTimeout(() => {
    onProgress?.({ type: 'error', message: 'Run timed out after 3 minutes' });
  }, 180000);

  const allDiagnostics: SourceDiagnostic[] = [];

  try {
    // ─── PHASE 1: SCOUT ────────────────────────────────────────────

    // 1a. Crypto: direct API calls (free, instant)
    if (agentConfig.useCryptoAPIs && agentConfig.cryptoPairs) {
      onProgress?.({ type: 'tool_call', message: 'Fetching live crypto prices from Binance, Coinbase, Kraken…' });

      const cryptoPrices = await fetchCryptoPrices(agentConfig.cryptoPairs);
      sourcesChecked.push('Binance API', 'Coinbase API', 'Kraken API');

      const spreads = findCryptoSpreads(cryptoPrices, agentConfig.minSpreadPercent);

      onProgress?.({
        type: 'tool_result',
        message: `Found ${cryptoPrices.length} prices across ${new Set(cryptoPrices.map(p => p.exchange)).size} exchanges. ${spreads.length} spreads detected.`,
        data: { prices: cryptoPrices.length, spreads: spreads.length },
      });

      if (spreads.length > 0) {
        clearTimeout(runTimeout);
        const opportunities = buildCryptoOpportunities(spreads);

        onProgress?.({
          type: 'completed',
          message: `Found ${opportunities.length} crypto arbitrage opportunities (no Claude tokens used!)`,
          data: { opportunities: opportunities.length, tokens: 0 },
        });

        return {
          success: true,
          opportunities,
          reasoning: `Found ${spreads.length} cross-exchange spreads by comparing live prices from ${[...new Set(cryptoPrices.map(p => p.exchange))].join(', ')}.`,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalToolCalls: 0,
          estimatedCost: 0,
          scoutStats: {
            leadsFound: cryptoPrices.length,
            leadsQualified: spreads.length,
            sourcesChecked,
            diagnostics: allDiagnostics,
          },
        };
      }

      clearTimeout(runTimeout);
      return {
        success: true,
        opportunities: [],
        reasoning: `Checked ${agentConfig.cryptoPairs.length} pairs across 3 exchanges. No spreads exceeding ${agentConfig.minSpreadPercent}% found at this time.`,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalToolCalls: 0,
        estimatedCost: 0,
        scoutStats: {
          leadsFound: cryptoPrices.length,
          leadsQualified: 0,
          sourcesChecked,
          diagnostics: allDiagnostics,
        },
      };
    }

    // 1b. Craigslist RSS feeds (free, no auth, structured prices)
    let craigslistLeads: ScoutLead[] = [];
    if (agentConfig.useCraigslistRSS && agentConfig.craigslistConfig) {
      onProgress?.({ type: 'tool_call', message: 'Fetching Craigslist RSS feeds across cities…' });

      const clResult = await fetchCraigslistRSS(agentConfig.craigslistConfig);
      craigslistLeads = clResult.leads;
      allDiagnostics.push(...clResult.diagnostics);
      const citiesChecked = agentConfig.craigslistConfig.cities.length > 0
        ? agentConfig.craigslistConfig.cities.length
        : 5;
      sourcesChecked.push(`Craigslist RSS (${citiesChecked} cities)`);

      const withPrices = craigslistLeads.filter(l => l.priceFound && l.priceFound > 0);

      onProgress?.({
        type: 'tool_result',
        message: `Found ${craigslistLeads.length} Craigslist listings, ${withPrices.length} have prices.${craigslistLeads.length < 5 ? ' (low count — will add Tavily fallback)' : ''}`,
        data: { total: craigslistLeads.length, withPrices: withPrices.length, diagnostics: clResult.diagnostics },
      });

      // Craigslist fallback: if RSS returned very few results, supplement with Tavily
      if (craigslistLeads.length < 5) {
        onProgress?.({ type: 'tool_call', message: 'Craigslist RSS returned few results — adding Tavily fallback…' });
        const fallbackQueries = [
          'site:craigslist.org macbook for sale',
          'site:craigslist.org iphone for sale',
          'site:craigslist.org herman miller for sale',
          'site:craigslist.org dyson for sale',
        ];
        const fallbackLeads = await tavilyBatchSearch(fallbackQueries, config.tavilyApiKey, 5);
        craigslistLeads.push(...fallbackLeads);
        onProgress?.({
          type: 'tool_result',
          message: `Tavily fallback added ${fallbackLeads.length} additional Craigslist leads.`,
        });
      }
    }

    // 1c. Government auction search (Tavily-based — old RSS URLs were broken)
    let govLeads: ScoutLead[] = [];
    if (agentConfig.useGovAuctions) {
      onProgress?.({ type: 'tool_call', message: 'Searching government auction sites (GovDeals, PublicSurplus, GSA)…' });

      const govResult = await fetchGovAuctions(config.tavilyApiKey);
      govLeads = govResult.leads;
      allDiagnostics.push(...govResult.diagnostics);
      sourcesChecked.push('GovDeals', 'PublicSurplus', 'GSA Auctions');

      onProgress?.({
        type: 'tool_result',
        message: `Found ${govLeads.length} government auction listings.`,
        data: { total: govLeads.length, diagnostics: govResult.diagnostics },
      });
    }

    // 1d. Collectibles APIs (Discogs + kicks.dev)
    let collectiblesLeads: ScoutLead[] = [];
    if (agentConfig.useCollectiblesAPIs) {
      onProgress?.({ type: 'tool_call', message: 'Fetching collectibles data (Discogs, StockX via kicks.dev)…' });

      const [discogsResult, sneakerResult] = await Promise.all([
        fetchDiscogsListings(),
        fetchSneakerPrices(),
      ]);

      collectiblesLeads = [...discogsResult.leads, ...sneakerResult.leads];
      allDiagnostics.push(...discogsResult.diagnostics, ...sneakerResult.diagnostics);
      sourcesChecked.push('Discogs API', 'kicks.dev/StockX');

      onProgress?.({
        type: 'tool_result',
        message: `Found ${discogsResult.leads.length} vinyl listings + ${sneakerResult.leads.length} sneaker prices.`,
        data: { discogs: discogsResult.leads.length, sneakers: sneakerResult.leads.length },
      });
    }

    // 1e. Open Library (free, ISBN-based book data)
    let bookLeads: BookLead[] = [];
    if (agentConfig.useOpenLibrary) {
      onProgress?.({ type: 'tool_call', message: 'Searching Open Library for book data…' });

      const bookResult = await fetchOpenLibraryBooks();
      bookLeads = bookResult.leads;
      allDiagnostics.push(...bookResult.diagnostics);
      sourcesChecked.push('Open Library');

      onProgress?.({
        type: 'tool_result',
        message: `Found ${bookLeads.length} books with ISBN data for price comparison.`,
        data: { total: bookLeads.length, diagnostics: bookResult.diagnostics },
      });
    }

    // 1f. Deal feeds (free, no auth)
    let dealLeads: QualifiedLead[] = [];
    if (agentConfig.useDealFeeds) {
      onProgress?.({ type: 'tool_call', message: 'Checking deal feeds (Slickdeals, DealNews, Reddit)…' });

      const feedResult = await fetchDealFeeds();
      allDiagnostics.push(...feedResult.diagnostics);
      sourcesChecked.push('Slickdeals', 'DealNews', 'r/deals', 'r/flipping', 'r/buildapcsales');

      dealLeads = filterDealFeedItems(feedResult.leads, 25); // Lowered from 35% to 25%

      onProgress?.({
        type: 'tool_result',
        message: `Found ${feedResult.leads.length} deal feed items, ${dealLeads.length} passed price filter (35%+ discount).`,
        data: { feedItems: feedResult.leads.length, qualified: dealLeads.length, diagnostics: feedResult.diagnostics },
      });
    }

    // 1g. Tavily batch search (costs Tavily credits, but no Claude tokens)
    let scoutLeads: ScoutLead[] = [];
    if (agentConfig.searchQueries.length > 0) {
      const queries = agentConfig.searchQueries.slice(0, 12);

      onProgress?.({
        type: 'tool_call',
        message: `Running ${queries.length} targeted web searches…`,
        data: { queries: queries.length },
      });

      scoutLeads = await tavilyBatchSearch(queries, config.tavilyApiKey, 5);
      sourcesChecked.push('Tavily Search');

      onProgress?.({
        type: 'tool_result',
        message: `Found ${scoutLeads.length} raw leads from web search. ${scoutLeads.filter(l => l.priceFound).length} have extractable prices.`,
        data: { leads: scoutLeads.length, withPrices: scoutLeads.filter(l => l.priceFound).length },
      });
    }

    // 1h. eBay-specific search
    let ebayLeads: ScoutLead[] = [];
    if (agentConfig.useEbaySearch) {
      const ebayQueries = agentConfig.searchQueries
        .filter(q => !q.includes('site:ebay.com'))
        .slice(0, 10)
        .map(q => q.replace(/site:\S+/g, '').trim());

      if (ebayQueries.length > 0) {
        onProgress?.({ type: 'tool_call', message: 'Searching eBay listings…' });
        ebayLeads = await searchEbayListings(ebayQueries, config.tavilyApiKey);
        sourcesChecked.push('eBay');

        onProgress?.({
          type: 'tool_result',
          message: `Found ${ebayLeads.length} eBay listings.`,
          data: { leads: ebayLeads.length },
        });
      }
    }

    // Combine all leads from all sources (excluding books — they get their own pipeline)
    const allLeads = [...craigslistLeads, ...govLeads, ...collectiblesLeads, ...scoutLeads, ...ebayLeads];
    const leadsWithPrices = allLeads.filter(l => l.priceFound && l.priceFound > 0);
    const leadsWithoutPrices = allLeads.filter(l => !l.priceFound || l.priceFound <= 0);

    // Diagnostic: log what we got from each source
    console.log(`[Scout ${config.agentType}] Source breakdown:`);
    console.log(`  Craigslist: ${craigslistLeads.length} leads`);
    console.log(`  Gov auctions: ${govLeads.length} leads`);
    console.log(`  Collectibles: ${collectiblesLeads.length} leads`);
    console.log(`  Tavily search: ${scoutLeads.length} leads`);
    console.log(`  eBay: ${ebayLeads.length} leads`);
    console.log(`  Deal feeds: ${dealLeads.length} pre-qualified`);
    console.log(`  Books: ${bookLeads.length} leads`);
    console.log(`  TOTAL: ${allLeads.length} leads, ${leadsWithPrices.length} with prices, ${leadsWithoutPrices.length} without`);
    if (leadsWithoutPrices.length > 0) {
      console.log(`  Leads without prices (first 5):`);
      for (const l of leadsWithoutPrices.slice(0, 5)) {
        console.log(`    - "${l.title.slice(0, 60)}" from ${l.source} (${l.url.slice(0, 80)})`);
      }
    }

    onProgress?.({
      type: 'tool_call',
      message: `${leadsWithPrices.length} leads have prices (${leadsWithoutPrices.length} without). Running resale price lookups…`,
    });

    // 1i. Resale price lookup (Tavily, but no Claude)
    let qualifiedLeads: QualifiedLead[] = [];
    if (leadsWithPrices.length > 0) {
      const resaleData = await batchResaleLookup(leadsWithPrices, config.tavilyApiKey);

      qualifiedLeads = filterLeadsWithPriceData(
        allLeads,
        resaleData,
        agentConfig.minProfitCents,
        agentConfig.minSpreadPercent,
      );

      onProgress?.({
        type: 'tool_result',
        message: `Resale check complete. ${qualifiedLeads.length} leads have confirmed price spreads.`,
        data: { qualified: qualifiedLeads.length, resaleDataPoints: resaleData.size },
      });
    }

    // 1i-b. For high-quality listing URLs WITHOUT prices, try a direct Tavily lookup
    // These are real marketplace listings where the snippet just didn't include the price
    if (leadsWithoutPrices.length > 0 && qualifiedLeads.length < 10) {
      const listingUrlLeads = leadsWithoutPrices.filter(l => isListingUrl(l.url)).slice(0, 8);

      if (listingUrlLeads.length > 0) {
        onProgress?.({
          type: 'tool_call',
          message: `${listingUrlLeads.length} listing URLs have no price — trying direct lookups…`,
        });

        for (const lead of listingUrlLeads) {
          try {
            // Fetch the listing page content to find the price
            const resp = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(8000),
              body: JSON.stringify({
                api_key: config.tavilyApiKey,
                query: `${lead.title} price`,
                max_results: 3,
                include_answer: true,
              }),
            });
            if (!resp.ok) continue;
            const data = await resp.json();

            // Try to get a price from the answer
            const answerPrice = data.answer ? extractPrice(data.answer) : null;
            if (answerPrice && answerPrice > 0) {
              lead.priceFound = answerPrice;
              // Now it has a price, add it to the resale pipeline
              leadsWithPrices.push(lead);
            }
          } catch { /* skip */ }
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Re-run resale lookup for newly-priced leads
        if (leadsWithPrices.length > 0) {
          const newResaleData = await batchResaleLookup(
            leadsWithPrices.filter(l => l.priceFound && l.priceFound > 0),
            config.tavilyApiKey,
          );
          const newQualified = filterLeadsWithPriceData(
            allLeads.filter(l => l.priceFound && l.priceFound > 0),
            newResaleData,
            agentConfig.minProfitCents,
            agentConfig.minSpreadPercent,
          );
          // Merge new qualified leads (avoid duplicates)
          const existingUrls = new Set(qualifiedLeads.map(q => q.buyUrl));
          for (const q of newQualified) {
            if (!existingUrls.has(q.buyUrl)) {
              qualifiedLeads.push(q);
            }
          }
        }
      }
    }

    // 1j. Book-specific resale lookup (books have no priceFound — need ISBN-based lookups)
    let bookQualifiedLeads: QualifiedLead[] = [];
    if (bookLeads.length > 0) {
      onProgress?.({ type: 'tool_call', message: `Running ISBN-based resale lookups for ${bookLeads.length} books…` });

      bookQualifiedLeads = await batchBookResaleLookup(
        bookLeads,
        config.tavilyApiKey,
        agentConfig.minProfitCents,
      );

      onProgress?.({
        type: 'tool_result',
        message: `Book resale check complete. ${bookQualifiedLeads.length} books have profitable resale prices.`,
        data: { qualified: bookQualifiedLeads.length },
      });
    }

    // 1k. Collectibles direct qualification (no Tavily needed — uses Discogs/StockX data)
    let collectiblesDirectLeads: QualifiedLead[] = [];
    if (agentConfig.useCollectiblesAPIs && collectiblesLeads.length > 0) {
      // If Tavily-based resale lookup didn't produce results for collectibles,
      // fall back to direct qualification using marketplace data
      const collectiblesInQualified = qualifiedLeads.filter(q =>
        q.buySource === 'Discogs' || q.buySource === 'StockX'
      );
      if (collectiblesInQualified.length === 0) {
        onProgress?.({ type: 'tool_call', message: 'Using Discogs/StockX marketplace data for direct qualification…' });
        collectiblesDirectLeads = qualifyCollectiblesDirectly(
          collectiblesLeads,
          agentConfig.minProfitCents,
        );
        onProgress?.({
          type: 'tool_result',
          message: `Direct collectibles qualification: ${collectiblesDirectLeads.length} opportunities from marketplace data.`,
        });
      }
    }

    // Merge all qualified leads
    const allQualified = [...qualifiedLeads, ...dealLeads, ...bookQualifiedLeads, ...collectiblesDirectLeads].slice(0, 25);

    const totalLeads = allLeads.length + (dealLeads.length > 0 ? dealLeads.length : 0) + bookLeads.length;

    console.log(`[Scout ${config.agentType}] Pipeline summary:`);
    console.log(`  Total leads: ${totalLeads}`);
    console.log(`  Qualified from resale: ${qualifiedLeads.length}`);
    console.log(`  Qualified from deals: ${dealLeads.length}`);
    console.log(`  Qualified from books: ${bookQualifiedLeads.length}`);
    console.log(`  Qualified from collectibles direct: ${collectiblesDirectLeads.length}`);
    console.log(`  FINAL: ${allQualified.length} → sending to Claude`);
    if (allQualified.length > 0) {
      for (const q of allQualified.slice(0, 5)) {
        console.log(`    ✓ "${q.title.slice(0, 50)}" buy=$${(q.buyPrice/100).toFixed(2)} sell=$${(q.sellPriceEstimate/100).toFixed(2)} spread=${q.spreadPercent.toFixed(0)}%`);
      }
    }

    if (allQualified.length === 0) {
      // Build a diagnostic summary for the "no results" case
      const diagSummary = allDiagnostics
        .filter(d => d.status !== 'success')
        .map(d => `${d.source}: ${d.status}${d.error ? ` (${d.error})` : ''}`)
        .join('; ');

      onProgress?.({
        type: 'completed',
        message: `Scouted ${totalLeads} leads from ${sourcesChecked.length} sources. No profitable spreads found.${diagSummary ? ` Issues: ${diagSummary}` : ''}`,
        data: { leads: totalLeads, qualified: 0, diagnostics: allDiagnostics },
      });

      return {
        success: true,
        opportunities: [],
        reasoning: `Scouted ${totalLeads} leads across ${sourcesChecked.join(', ')}. No leads passed the minimum profit threshold of $${(agentConfig.minProfitCents / 100).toFixed(0)}.${diagSummary ? ` Source issues: ${diagSummary}` : ''}`,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalToolCalls: 0,
        estimatedCost: 0,
        scoutStats: {
          leadsFound: totalLeads,
          leadsQualified: 0,
          sourcesChecked,
          diagnostics: allDiagnostics,
        },
      };
    }

    // ─── PHASE 2: SNIPE ────────────────────────────────────────────

    onProgress?.({
      type: 'calling_claude',
      message: `Snipe phase: sending ${allQualified.length} pre-qualified leads to Claude for verification…`,
      data: { leads: allQualified.length },
    });

    // Check budget before Claude call
    const budgetConfig = await loadBudgetConfig();
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
        scoutStats: { leadsFound: totalLeads, leadsQualified: allQualified.length, sourcesChecked },
        abortReason: 'Daily token limit reached.',
      };
    }

    // Build the leads summary for Claude with sell-price quality labels
    const leadsSummary = allQualified.map((lead, i) => {
      const priceLabel = lead.sellPriceType === 'verified'
        ? `VERIFIED $${(lead.sellPriceEstimate / 100).toFixed(2)} from listing`
        : lead.sellPriceType === 'research_needed' || lead.sellPriceEstimate === 0
          ? 'UNKNOWN — use search_sold_prices tool to find sell price'
          : `ESTIMATED ~$${(lead.sellPriceEstimate / 100).toFixed(2)} (verify with search_sold_prices tool)`;

      return `[Lead ${i + 1}]
Title: ${lead.title.slice(0, 100)}
Buy: $${(lead.buyPrice / 100).toFixed(2)} on ${lead.buySource}
Buy URL: ${lead.buyUrl}
Sell Price: ${priceLabel}
Sell Source: ${lead.sellSource}
Sell URL: ${lead.sellUrl}
Confidence: ${lead.confidence}
Snippet: ${lead.description.slice(0, 150)}`;
    }).join('\n\n');

    const OPPORTUNITY_OUTPUT_SCHEMA = `
Return verified opportunities as a JSON array wrapped in <opportunities> tags:
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
    "sellPriceType": "verified",
    "estimatedProfit": 10743,
    "fees": {
      "platformFee": 2457,
      "shippingCost": 1200,
      "total": 3657
    },
    "confidence": 85,
    "riskNotes": ["Condition not verified", "Listing age unknown"],
    "reasoning": "Brief explanation of why this is a real opportunity..."
  }
]
</opportunities>

IMPORTANT:
- All prices in CENTS.
- sellPriceType must be one of: "verified" (you found real sold/listed prices), "estimated" (price is a rough estimate), "research_needed" (you couldn't verify the price).
- For leads marked UNKNOWN or ESTIMATED, use the search_sold_prices tool to look up real sold prices BEFORE including them.
- Only present sell prices you are confident in. If you can't verify a sell price, set sellPriceType to "research_needed".
- If you can identify a specific product from the lead title/description, include it even if the URL is a search page. Add "URL is a search page, not a direct listing" to riskNotes and reduce confidence by 20.
- If the lead is too vague to identify ANY specific product (e.g. just "Walmart clearance"), skip it.
- PREFER to include opportunities rather than exclude them. Let the user make the final call.
- You MUST output at least one opportunity if ANY of the leads have identifiable products with profitable spreads. An empty array means NONE of the leads had identifiable products.`;

    // Count how many leads need research (determines if we need tool-use loop)
    const needsResearch = allQualified.filter(l =>
      l.sellPriceType === 'research_needed' || l.sellPriceType === 'estimated'
    ).length;

    const snipeMessage = `Here are ${allQualified.length} pre-screened leads where our automated system detected potential price spreads. Verify each one and output structured opportunities for any that are genuinely profitable after fees.

${needsResearch > 0 ? `NOTE: ${needsResearch} leads have unverified sell prices. Use the search_sold_prices tool to look up real eBay sold prices for these items before finalizing your analysis. You have up to 5 tool calls.\n\n` : ''}${leadsSummary}

${OPPORTUNITY_OUTPUT_SCHEMA}`;

    // Build tool definitions for Claude
    const snipeTools = needsResearch > 0 ? [{
      name: 'search_sold_prices',
      description: 'Search eBay sold listings to find real sold prices for a product. Returns listing URLs and prices. Use this to verify or find sell prices for leads marked ESTIMATED or UNKNOWN.',
      input_schema: {
        type: 'object' as const,
        properties: {
          product_name: {
            type: 'string' as const,
            description: 'The product name to search for (e.g. "Dyson V8 Absolute vacuum")',
          },
        },
        required: ['product_name'],
      },
    }] : undefined;

    // Tool-use loop (max 5 tool calls to conserve Tavily budget)
    let toolCallsUsed = 0;
    const maxToolCalls = 5;
    const messages: ClaudeMessage[] = [
      { role: 'user', content: snipeMessage },
    ];

    let finalResponse: ClaudeResponse | null = null;

    for (let loop = 0; loop < maxToolCalls + 1; loop++) {
      const response = await callClaude(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: agentConfig.snipeSystemPrompt,
          messages,
          ...(snipeTools && toolCallsUsed < maxToolCalls ? { tools: snipeTools } : {}),
        },
        config.apiKey,
      );

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      await recordUsage(config.agentType, response.usage.input_tokens, response.usage.output_tokens, 0);

      // Check if Claude wants to use a tool
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0 || toolCallsUsed >= maxToolCalls) {
        // Claude is done — parse final response
        finalResponse = response;
        break;
      }

      // Add assistant message
      messages.push({ role: 'assistant', content: response.content });

      // Execute tool calls
      const toolResults: ClaudeContentBlock[] = [];
      for (const block of toolUseBlocks) {
        toolCallsUsed++;
        const input = (block as ClaudeContentBlock).input as unknown as { product_name: string };
        const productName = input?.product_name || '';

        onProgress?.({
          type: 'tool_call',
          message: `Claude searching eBay sold prices for "${productName.slice(0, 50)}"…`,
        });

        let resultText: string;
        try {
          resultText = await searchSoldPrices(productName, config.tavilyApiKey);
        } catch {
          resultText = 'Error: search failed';
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: (block as ClaudeContentBlock).id,
          content: resultText,
        });

        onProgress?.({
          type: 'tool_result',
          message: `Sold price search complete for "${productName.slice(0, 50)}"`,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Parse opportunities from Claude's final response
    const opportunities = finalResponse ? parseOpportunities(finalResponse) : [];
    const cost = estimateCost(totalInputTokens, totalOutputTokens);

    clearTimeout(runTimeout);

    onProgress?.({
      type: 'completed',
      message: `Verified ${opportunities.length} opportunities from ${allQualified.length} leads. ${totalInputTokens + totalOutputTokens} tokens used ($${cost.toFixed(4)}).`,
      data: { opportunities: opportunities.length, tokens: totalInputTokens + totalOutputTokens, cost },
    });

    return {
      success: true,
      opportunities,
      reasoning: finalResponse ? extractReasoning(finalResponse) : '',
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls: 1 + toolCallsUsed,
      estimatedCost: cost,
      scoutStats: {
        leadsFound: totalLeads,
        leadsQualified: allQualified.length,
        sourcesChecked,
        diagnostics: allDiagnostics,
      },
    };

  } catch (err) {
    clearTimeout(runTimeout);
    const error = err instanceof Error ? err.message : String(err);
    onProgress?.({ type: 'error', message: error });

    return {
      success: false,
      opportunities: [],
      reasoning: '',
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls: 0,
      estimatedCost: estimateCost(totalInputTokens, totalOutputTokens),
      scoutStats: { leadsFound: 0, leadsQualified: 0, sourcesChecked, diagnostics: allDiagnostics },
      error,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildCryptoOpportunities(spreads: CryptoSpread[]): ParsedOpportunity[] {
  return spreads.map(spread => {
    const buyPriceCents = Math.round(spread.buyPrice * 100);
    const sellPriceCents = Math.round(spread.sellPrice * 100);

    // Estimate fees: 0.1% trading fee on each side + withdrawal
    const buyFee = Math.round(buyPriceCents * 0.001);
    const sellFee = Math.round(sellPriceCents * 0.001);
    const withdrawalFee = 500; // ~$5 estimated
    const totalFees = buyFee + sellFee + withdrawalFee;

    const profit = sellPriceCents - buyPriceCents - totalFees;

    return {
      title: `${spread.pair} Spread: ${spread.buyExchange} → ${spread.sellExchange}`,
      description: `${spread.pair} is trading at $${spread.buyPrice.toFixed(2)} on ${spread.buyExchange} and $${spread.sellPrice.toFixed(2)} on ${spread.sellExchange}. Spread: ${spread.spreadPercent.toFixed(3)}%.`,
      buyPrice: buyPriceCents,
      buySource: spread.buyExchange,
      buyUrl: spread.buyUrl,
      sellPrice: sellPriceCents,
      sellSource: spread.sellExchange,
      sellUrl: spread.sellUrl,
      sellPriceType: 'verified' as const, // Live exchange API prices
      estimatedProfit: Math.max(0, profit),
      fees: {
        platformFee: buyFee + sellFee,
        other: withdrawalFee,
        total: totalFees,
      },
      confidence: spread.spreadPercent > 1 ? 85 : spread.spreadPercent > 0.5 ? 70 : 55,
      riskNotes: [
        'Spread may close during transfer time',
        `Transfer time depends on network congestion`,
        'Price is a snapshot — may change by the time you trade',
      ],
      reasoning: `Live API data: ${spread.buyExchange} price $${spread.buyPrice.toFixed(2)} vs ${spread.sellExchange} price $${spread.sellPrice.toFixed(2)}. Raw spread ${spread.spreadPercent.toFixed(3)}%.`,
    };
  });
}

function parseOpportunities(response: ClaudeResponse): ParsedOpportunity[] {
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');

  const match = text.match(/<opportunities>\s*([\s\S]*?)\s*<\/opportunities>/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (o: Record<string, unknown>) =>
          o.title &&
          typeof o.buyPrice === 'number' &&
          typeof o.sellPrice === 'number' &&
          o.buySource &&
          o.sellSource,
      )
      .map((o: Record<string, unknown>) => ({
        ...o,
        // Default sellPriceType if Claude didn't provide it
        sellPriceType: o.sellPriceType || 'estimated',
      })) as ParsedOpportunity[];
  } catch {
    return [];
  }
}

function extractReasoning(response: ClaudeResponse): string {
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');
}

/**
 * Search eBay sold listings for a product to find real sold prices.
 * Used by Claude as a tool during the snipe phase.
 */
async function searchSoldPrices(productName: string, tavilyApiKey: string): Promise<string> {
  if (!productName || productName.length < 3) {
    return 'Error: product_name must be at least 3 characters';
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: `site:ebay.com "${productName}" sold`,
        max_results: 5,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      return `Error: Tavily returned ${response.status}`;
    }

    const data = await response.json();
    const results = (data.results || []) as Array<{ url: string; title?: string; content?: string }>;

    // Only extract from real listing URLs
    const listings: Array<{ url: string; title: string; prices: number[] }> = [];
    for (const result of results) {
      if (!isListingUrl(result.url)) continue;

      const text = (result.title || '') + ' ' + (result.content || '');
      const prices = extractAllPrices(text).filter(p => p >= 100 && p <= 500000); // $1 - $5000 range

      if (prices.length > 0) {
        listings.push({
          url: result.url,
          title: (result.title || '').slice(0, 100),
          prices,
        });
      }
    }

    if (listings.length === 0) {
      return `No eBay sold listings found for "${productName}". The sell price cannot be verified. Set sellPriceType to "research_needed".`;
    }

    // Format results for Claude
    const allPrices = listings.flatMap(l => l.prices);
    const sorted = [...allPrices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    let output = `Found ${listings.length} eBay sold listings for "${productName}":\n`;
    for (const listing of listings) {
      output += `- ${listing.title}\n  URL: ${listing.url}\n  Prices: ${listing.prices.map(p => `$${(p/100).toFixed(2)}`).join(', ')}\n`;
    }
    output += `\nMedian sold price: $${(median/100).toFixed(2)} (${allPrices.length} data points)`;
    output += `\nUse this as the sellPrice (in cents: ${median}). Set sellPriceType to "verified" if 2+ data points, or "estimated" if only 1.`;

    return output;
  } catch {
    return `Error: search failed for "${productName}"`;
  }
}
