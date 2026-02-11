# Airbitrage

Arbitrage discovery powered by AI agents. Airbitrage finds real arbitrage opportunities by starting from **proven buyer demand** — people actively posting what they want to buy and how much they'll pay — then searching for cheaper sources elsewhere on the internet.

## How It Works

The app runs a **Buy Intent Agent** that operates in three phases:

1. **Harvest** (free) — Scans Reddit swap subreddits (r/hardwareswap, r/mechmarket, r/appleswap, etc.) for buy-intent posts. These are real people saying "I have $800 PayPal, I want an RTX 4080." Prices are extracted from post titles and bodies.

2. **Source** (Tavily API) — For each buy-intent post with a stated price, searches eBay, Amazon, Mercari, and Swappa for the same item at a lower price. Calculates fees (PayPal, shipping) and estimated profit.

3. **Verify** (Claude API) — Uses Claude to confirm the product match is accurate, flag condition concerns, and validate the profit calculation. Only runs when profitable matches are found.

The result: a feed of opportunities where a real buyer is willing to pay more than you can source the item for, with profit estimates, confidence scores, and direct links to both the buyer's post and the source listing.

## Quick Start

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/) (for Claude verification)
- A [Tavily API key](https://tavily.com/) (for web search)

### Setup

```bash
git clone https://github.com/claudecode609-hub/airbitrage.git
cd airbitrage
npm install
```

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Add your API keys to `.env`:

```
AIRBITRAGE_ANTHROPIC_KEY=sk-ant-...
TAVILY_API_KEY=tvly-...
```

### Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Navigate to the **Buy Intent** agent tab and click **Run Now**.

### Build for Production

```bash
npm run build
npm start
```

## What You See

- **Dashboard** — Summary of opportunities across all agents, stats at a glance
- **Buy Intent tab** — The active agent. Shows harvested opportunities with buyer info (username, trade count, subreddit), source vs. buyer price comparison, estimated profit, and confidence scores
- **Opportunity cards** — Each card shows the source price, buyer's price, profit estimate, and two action buttons: "Buy from Source" (opens the marketplace listing) and "View Buyer Post" (opens the Reddit thread)
- **Settings** — Configure API keys and agent defaults

## Tech Stack

- **Next.js 15+** with App Router and Server Components
- **TypeScript** and **Tailwind CSS v4**
- **Claude API** (raw fetch, no SDK) for AI verification
- **Tavily API** for web search
- **Reddit JSON API** (no auth required) for harvesting buy-intent posts
- Custom UI components throughout — no component libraries

## Reddit Sources

The agent monitors these subreddits for buy-intent posts:

| Subreddit | Format | Category |
|-----------|--------|----------|
| r/hardwareswap | [H]/[W] | PC hardware, GPUs, CPUs |
| r/mechmarket | [H]/[W] | Mechanical keyboards |
| r/photomarket | [H]/[W] | Cameras, lenses |
| r/appleswap | [H]/[W] | Apple devices |
| r/AVexchange | [H]/[W] | Audio equipment |
| r/gamesale | [H]/[W] | Video games, consoles |
| r/homelabsales | [H]/[W] | Servers, networking |
| r/Knife_Swap | [H]/[W] | Knives, EDC |
| r/Pen_Swap | [H]/[W] | Fountain pens |
| r/watchexchange | [WTB] | Watches |

## Project Structure

```
src/
├── agents/
│   ├── buyer-intent/       # Buy Intent Agent pipeline
│   │   ├── harvester.ts    # Reddit API fetcher + title/body parser
│   │   ├── sourcer.ts      # Tavily search + price comparison
│   │   └── runner.ts       # 3-phase pipeline orchestration
│   ├── scout/              # Legacy scout-then-snipe pipeline
│   └── run-agent.ts        # Agent dispatcher
├── app/
│   ├── (dashboard)/        # Dashboard, agent tabs, settings
│   └── api/stream/         # SSE endpoint for live agent updates
├── components/             # Custom UI components
├── hooks/                  # React hooks (useAgentRun, etc.)
├── lib/                    # API clients, utilities, budget tracking
└── types/                  # TypeScript type definitions
```

## License

MIT
