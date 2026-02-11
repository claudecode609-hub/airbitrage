/**
 * Buy-Intent Harvester — fetches buy-intent posts from Reddit swap subs.
 *
 * BRUTE FORCE MODE: We keep ALL buy-intent posts, even those without a stated
 * price. The sourcer will look up market prices for priceless posts.
 * This maximizes the number of opportunities we can evaluate.
 */

import { extractPrice } from '@/agents/scout/sources';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BuyIntent {
  title: string;
  itemWanted: string;
  maxPrice: number;       // cents — 0 means "no price stated, needs market lookup"
  hasStatedPrice: boolean;
  location: string;
  buyerUsername: string;
  buyerTradeCount: number;
  source: string;         // "r/hardwareswap", etc.
  postUrl: string;
  postAge: number;        // hours since posted
  created: number;        // unix timestamp
}

export interface SourceDiagnostic {
  source: string;
  status: 'success' | 'empty' | 'error';
  itemCount: number;
  durationMs: number;
  error?: string;
}

export interface HarvestResult {
  intents: BuyIntent[];
  diagnostics: SourceDiagnostic[];
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Reddit swap subs that use [H]/[W] format */
const HW_FORMAT_SUBS = [
  'hardwareswap',
  'mechmarket',
  'photomarket',
  'appleswap',
  'AVexchange',
  'gamesale',
  'homelabsales',
  'Knife_Swap',
  'Pen_Swap',
  'GunAccessoriesForSale',
  'comicswap',
  'funkoswap',
];

/** Reddit subs that use [WTB] format */
const WTB_FORMAT_SUBS = [
  'watchexchange',
  'vinylcollectors',
];

const MIN_PRICE_CENTS = 2500;   // $25 minimum (only for posts that have a price)
const MAX_POST_AGE_HOURS = 72;  // 72h window
const REDDIT_DELAY_MS = 400;
const POSTS_PER_SUB = 100;      // max out Reddit's limit

// ─── Main Harvester ──────────────────────────────────────────────────────────

export async function harvestBuyIntents(): Promise<HarvestResult> {
  const allIntents: BuyIntent[] = [];
  const diagnostics: SourceDiagnostic[] = [];

  const allSubs = [...HW_FORMAT_SUBS, ...WTB_FORMAT_SUBS];
  for (const sub of allSubs) {
    const start = Date.now();
    try {
      const intents = await fetchRedditSubreddit(sub);
      diagnostics.push({
        source: `r/${sub}`,
        status: intents.length > 0 ? 'success' : 'empty',
        itemCount: intents.length,
        durationMs: Date.now() - start,
      });
      allIntents.push(...intents);
    } catch (err) {
      diagnostics.push({
        source: `r/${sub}`,
        status: 'error',
        itemCount: 0,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise(r => setTimeout(r, REDDIT_DELAY_MS));
  }

  // Sort: priced posts first (by price desc), then priceless posts
  allIntents.sort((a, b) => {
    if (a.hasStatedPrice && !b.hasStatedPrice) return -1;
    if (!a.hasStatedPrice && b.hasStatedPrice) return 1;
    return b.maxPrice - a.maxPrice;
  });

  return { intents: allIntents, diagnostics };
}

// ─── Reddit Fetching ─────────────────────────────────────────────────────────

interface RedditPost {
  title: string;
  author: string;
  author_flair_text: string | null;
  permalink: string;
  created_utc: number;
  subreddit: string;
  link_flair_text: string | null;
  selftext: string;
}

async function fetchRedditSubreddit(subreddit: string): Promise<BuyIntent[]> {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${POSTS_PER_SUB}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Airbitrage/1.0)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Reddit returned ${response.status}`);
  }

  const data = await response.json();
  const posts: RedditPost[] = (data?.data?.children || []).map(
    (child: { data: RedditPost }) => child.data,
  );

  const intents: BuyIntent[] = [];
  const nowSec = Date.now() / 1000;

  for (const post of posts) {
    const ageHours = (nowSec - post.created_utc) / 3600;
    if (ageHours > MAX_POST_AGE_HOURS) continue;

    const intent = parseBuyIntentFromPost(post, subreddit, ageHours);
    if (!intent) continue;

    // If they stated a price, enforce minimum
    if (intent.hasStatedPrice && intent.maxPrice < MIN_PRICE_CENTS) continue;

    // If no price, keep it — sourcer will look up market price
    intents.push(intent);
  }

  return intents;
}

// ─── Post Classification ─────────────────────────────────────────────────────

function parseBuyIntentFromPost(
  post: RedditPost,
  subreddit: string,
  ageHours: number,
): BuyIntent | null {
  const title = post.title;
  const selftext = post.selftext || '';

  // ── Buy signal detection ───────────────────────────────────────────
  const flairIsBuying = post.link_flair_text
    && /^buy/i.test(post.link_flair_text.trim());

  const hwResult = parseHWFormat(title);
  const isHWBuyPost = hwResult !== null;

  const isWTBPost = /\[WTB\]/i.test(title);

  if (!flairIsBuying && !isHWBuyPost && !isWTBPost) return null;

  // ── Extract item wanted ────────────────────────────────────────────
  let itemWanted: string;

  if (isHWBuyPost && hwResult) {
    itemWanted = hwResult.itemWanted;
  } else {
    itemWanted = title
      .replace(/\[.*?\]/g, '')
      .replace(/\$[\d,.]+/g, '')
      .replace(/paypal|cash|venmo|zelle|local\s*cash/gi, '')
      .trim();
  }

  if (itemWanted.length < 3) return null;

  // ── Extract price (may be 0 = unknown) ─────────────────────────────
  let maxPrice: number | null = null;

  if (hwResult?.maxPrice) {
    maxPrice = hwResult.maxPrice;
  }
  if (!maxPrice) {
    maxPrice = extractPrice(title);
  }
  if (!maxPrice && selftext.length > 0) {
    maxPrice = extractBestPriceFromBody(selftext);
  }

  const hasStatedPrice = maxPrice !== null && maxPrice > 0;

  return {
    title,
    itemWanted: itemWanted.slice(0, 150),
    maxPrice: maxPrice || 0,
    hasStatedPrice,
    location: extractLocation(title),
    buyerUsername: post.author,
    buyerTradeCount: parseTradeCount(post.author_flair_text),
    source: `r/${subreddit}`,
    postUrl: `https://www.reddit.com${post.permalink}`,
    postAge: Math.round(ageHours),
    created: post.created_utc,
  };
}

// ─── Title Parsing ───────────────────────────────────────────────────────────

interface ParsedHW {
  location: string;
  itemWanted: string;
  maxPrice: number | null;
}

function parseHWFormat(title: string): ParsedHW | null {
  const hwMatch = title.match(/\[H\]\s*(.*?)\s*\[W\]\s*(.*)/i);
  if (!hwMatch) return null;

  const haveSection = hwMatch[1].trim();
  const wantSection = hwMatch[2].trim();

  // [H] must contain payment indicator (PayPal, Cash, $, etc.)
  const havePayment = /paypal|cash|venmo|zelle|money|\$/i.test(haveSection);
  if (!havePayment) return null;

  // CRITICAL: [W] must NOT be primarily payment words — that means it's a SELL post
  // e.g. "[H] RTX 3080, PayPal [W] Local Cash" is a SELL, not a BUY
  const wantPayment = /paypal|cash|venmo|zelle|money|\$/i.test(wantSection);
  const wantClean = wantSection
    .replace(/\[.*?\]/g, '')
    .replace(/paypal|cash|venmo|zelle|money|local|g&s|goods\s*(?:&|and)\s*services|\$[\d,.]+/gi, '')
    .replace(/,/g, '')
    .trim();

  // If [W] is ONLY payment words (nothing left after stripping), it's a SELL post
  if (wantPayment && wantClean.length < 3) return null;

  const price = extractPrice(haveSection);

  const itemWanted = wantSection
    .replace(/\[.*?\]/g, '')
    .replace(/,?\s*local.*$/i, '')
    .trim();

  if (itemWanted.length < 3) return null;

  return {
    location: extractLocation(title),
    itemWanted: itemWanted.slice(0, 150),
    maxPrice: price,
  };
}

function extractBestPriceFromBody(selftext: string): number | null {
  const text = selftext.slice(0, 2000);

  const pricePattern = /\$\s?([\d,]+(?:\.\d{2})?)/g;
  const prices: number[] = [];
  let match;

  while ((match = pricePattern.exec(text)) !== null) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (num >= 15 && num < 50000) {
      prices.push(Math.round(num * 100));
    }
  }

  if (prices.length === 0) return null;
  return Math.max(...prices);
}

function extractLocation(title: string): string {
  const locMatch = title.match(/\[([A-Z]{2,3}-[A-Z]{2})\]/i);
  if (locMatch) return locMatch[1].toUpperCase();

  const countryMatch = title.match(/\[(USA?|CAN|UK|EU)\]/i);
  if (countryMatch) return countryMatch[1].toUpperCase();

  return 'unknown';
}

function parseTradeCount(flair: string | null): number {
  if (!flair) return 0;

  const match = flair.match(/(\d+)\s*(?:trades?|confirmed|swaps?)/i)
    || flair.match(/(?:trades?|confirmed|swaps?)\s*:?\s*(\d+)/i);

  if (match) return parseInt(match[1], 10);

  const numMatch = flair.match(/^\d+$/);
  if (numMatch) return parseInt(numMatch[0], 10);

  return 0;
}
