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
} from './sources';
import {
  findCryptoSpreads,
  filterLeadsWithPriceData,
  filterDealFeedItems,
  batchResaleLookup,
  batchBookResaleLookup,
  QualifiedLead,
  CryptoSpread,
} from './filter';
import { callClaude, ClaudeResponse } from '@/lib/claude';
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
        minProfitCents: (userConfig.minProfitCents as number) || 2000,
        minSpreadPercent: 25,
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
        minProfitCents: (userConfig.minProfitCents as number) || 2000,
        minSpreadPercent: 20,
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
            `${cat} clearance sale 70% off this week`,
            `target clearance ${cat} markdown`,
            `walmart clearance ${cat} deals`,
            `${cat} open box deal clearance`,
          ]),
          ...(categories.length === 0 ? [
            // Target
            `target clearance 70 off toys this week`,
            `target clearance home goods markdown`,
            `target clearance baby products deals`,
            `target clearance kitchen appliances`,
            // Walmart
            `walmart clearance electronics deals today`,
            `walmart hidden clearance markdown`,
            `walmart clearance tools hardware`,
            // Other retailers
            `costco clearance markdowns`,
            `best buy open box clearance deals`,
            `home depot clearance power tools discount`,
            `amazon warehouse deals open box`,
            `kohls clearance 80 percent off`,
            `nordstrom rack clearance designer`,
            `lowes clearance tools hardware`,
            // Specific high-value
            `lego set clearance discount sale`,
            `dyson vacuum clearance refurbished`,
            `ninja blender clearance sale`,
            `instant pot clearance deal`,
            `airpods clearance discount sale`,
          ] : []),
        ],
        useEbaySearch: false,
        useDealFeeds: true,
        useCryptoAPIs: false,
        useCraigslistRSS: false,
        useGovAuctions: false,
        useCollectiblesAPIs: false,
        useOpenLibrary: false,
        minProfitCents: (userConfig.minProfitCents as number) || 1500,
        minSpreadPercent: 35,
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
        minProfitCents: (userConfig.minProfitCents as number) || 2000,
        minSpreadPercent: 20,
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
        minProfitCents: (userConfig.minProfitCents as number) || 1500,
        minSpreadPercent: 20,
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
        minProfitCents: (userConfig.minProfitCents as number) || 800,
        minSpreadPercent: 35,
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

The buy-side data comes primarily from Craigslist RSS feeds with real listing URLs and prices. The sell-side estimates come from automated resale price lookups.

Your job: Verify each lead and produce structured opportunity data.

CRITICAL RULES:
- The buy item and sell item MUST be the EXACT SAME product (same brand, model, size, condition class). If the lead compares different items or the items aren't clearly identical, REJECT that lead entirely.
- Use ONLY the actual URLs from the lead data. Never invent or guess URLs. Craigslist URLs are real listing pages — these are high quality.
- Calculate fees using standard platform rates (eBay: 13.13% + $0.30, Amazon: 15%)
- Add shipping estimates (small: $5, medium: $12, large: $25)
- Assign a confidence score (0-100) based on data quality. Craigslist listings with direct URLs get +10 confidence. Deduct 20 points if the sell URL is a search page.
- Be skeptical — if the price spread seems too good to be true, lower confidence and add risk notes.
- Note condition risks for used items (Craigslist items are typically used).

Only output opportunities where net profit > $20 after all fees.`,

  auctions: `You are the Auction Agent for Airbitrage. You are being given PRE-SCREENED auction leads where our system detected potential value.

Your job: Verify each lead and produce structured opportunity data.

CRITICAL RULES:
- The buy item and resale comparison MUST be the EXACT SAME product. If the lead compares a generic category search to a specific product price, REJECT it.
- Use ONLY the actual URLs from the lead data. Never invent URLs.
- Check if the current bid/price is genuinely below market value for this SPECIFIC item
- Factor in eBay buyer premium, shipping, and resale fees
- Consider auction timing (ending soon = less competition = more realistic price)
- Assign confidence conservatively — deduct 20 points if URLs are search pages not specific listings
- Note sniping risks (last-minute bidding wars)

Only output opportunities where net profit > $20 after all fees.`,

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

CRITICAL RULES:
- The buy item and sell comparison MUST be the EXACT SAME product (same SKU, brand, model). Do NOT compare a deal on one item to the resale price of a different item.
- Use ONLY the actual URLs from the lead data. Never invent or guess URLs.
- Confirm the clearance/deal price is real (not a misleading discount)
- Compare against likely resale price on Amazon/eBay for this SPECIFIC product
- Factor in Amazon FBA fees (15% referral + ~$3-5 fulfillment) or eBay fees (13.13%)
- Consider whether the item has resale demand (brand name items are better)
- Flag if the item might be gated on Amazon. Deduct 20 points if URLs are search pages.

Only output opportunities where net profit > $15 after all fees.`,

  tickets: `You are the Tickets Agent for Airbitrage. You are being given leads about events where ticket price spreads may exist between primary and secondary markets.

Your job: Verify each lead and produce structured opportunity data.

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

CRITICAL RULES:
- The buy item and sell comparison MUST be the EXACT SAME product (same colorway, edition, grade, size). Do NOT compare different variants or editions.
- Use ONLY the actual URLs from the lead data. Never invent URLs.
- Verify the specific item and its market value
- Factor in platform fees (StockX: 9.5%, GOAT: 9.5%+$5, eBay: 13.13%)
- Consider authentication costs and shipping. Deduct 20 points if URLs are search pages.
- Assess condition/grading impact on price
- Note authenticity risks

Only output opportunities where net profit > $20 after all fees.`,

  books: `You are the Books/Media Agent for Airbitrage. You are being given PRE-SCREENED leads for books and media where our system detected pricing below Amazon/eBay resale values.

Your job: Verify each lead and produce structured opportunity data.

CRITICAL RULES:
- The buy and sell MUST be the EXACT SAME book (same ISBN, edition, format). Do NOT compare a paperback price to a hardcover price, or different editions.
- Use ONLY the actual URLs from the lead data. Never invent URLs.
- Confirm the book/media item and its resale value for this SPECIFIC edition
- Factor in Amazon FBA fees (15% referral + $3.22 fulfillment for standard books)
- Consider book condition requirements. Deduct 20 points if URLs are search pages.
- Check if sales rank suggests the book will actually sell
- Include ISBN when possible

Only output opportunities where net profit > $10 after all fees.`,
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

      dealLeads = filterDealFeedItems(feedResult.leads, 35); // Lowered from 50% to 35%

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

    onProgress?.({
      type: 'tool_call',
      message: `${leadsWithPrices.length} leads have prices. Running resale price lookups…`,
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

    // Merge all qualified leads
    const allQualified = [...qualifiedLeads, ...dealLeads, ...bookQualifiedLeads].slice(0, 25);

    const totalLeads = allLeads.length + (dealLeads.length > 0 ? dealLeads.length : 0) + bookLeads.length;

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

    // Build the leads summary for Claude (compact to save tokens)
    const leadsSummary = allQualified.map((lead, i) => {
      return `[Lead ${i + 1}]
Title: ${lead.title.slice(0, 100)}
Buy: $${(lead.buyPrice / 100).toFixed(2)} on ${lead.buySource}
Buy URL: ${lead.buyUrl}
Est. Sell: $${(lead.sellPriceEstimate / 100).toFixed(2)} on ${lead.sellSource}
Sell URL: ${lead.sellUrl}
Spread: $${(lead.estimatedSpread / 100).toFixed(2)} (${lead.spreadPercent.toFixed(0)}%)
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
- If the buy and sell items are NOT clearly identical products, do NOT include that lead.
- If a URL is a search/category page rather than a specific item listing, add "Buy/Sell URL is a search page, not a direct listing" to riskNotes and reduce confidence by 20.
- If none of the leads verify as real opportunities with identical items, return an empty array. An empty array is a GOOD result — it means you're being properly selective.`;

    const snipeMessage = `Here are ${allQualified.length} pre-screened leads where our automated system detected potential price spreads. Verify each one and output structured opportunities for any that are genuinely profitable after fees.

${leadsSummary}

${OPPORTUNITY_OUTPUT_SCHEMA}`;

    // Single Claude call with all qualified leads
    const response = await callClaude(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: agentConfig.snipeSystemPrompt,
        messages: [{ role: 'user', content: snipeMessage }],
      },
      config.apiKey,
    );

    totalInputTokens = response.usage.input_tokens;
    totalOutputTokens = response.usage.output_tokens;

    await recordUsage(config.agentType, totalInputTokens, totalOutputTokens, 0);

    // Parse opportunities from Claude's response
    const opportunities = parseOpportunities(response);
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
      reasoning: extractReasoning(response),
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls: 1, // Just one Claude call!
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

function extractReasoning(response: ClaudeResponse): string {
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');
}
