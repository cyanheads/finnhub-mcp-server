# finnhub-mcp-server — Design

**Package:** `@cyanheads/finnhub-mcp-server`
**Framework:** `@cyanheads/mcp-ts-core` `^0.10.6` (held — do not bump)
**Display identity:** `finnhub-mcp-server` (hyphenated machine name everywhere — `createApp` `title`, manifest `display_name`; never Title Case)

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `finnhub_search_symbols` | Resolve a company name or partial ticker to Finnhub stock symbols. The entry point for every other tool — users say "Microsoft", the rest of the surface needs "MSFT". Returns matched symbols with display symbol, description, and security type, best US match first. | `query`, `limit?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_quote` | Real-time price quote for one US stock symbol: current, change, %change, open, high, low, previous close. Pairs the quote with live market-status so the response states whether the price is live or the prior close — never implies a stale price is live. Resolve a name to a symbol with `finnhub_search_symbols` first. | `symbol` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_company` | Full company context for one US symbol in a single call: profile (name, exchange, industry, country, market cap, shares outstanding, IPO date, website, logo), headline fundamentals (P/E, EPS, 52-week range, beta, dividend yield, margins, growth), and sector peers. Combines three endpoints so "tell me about Apple" needs one tool call, not three. | `symbol` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_earnings` | Earnings data in two modes. `history`: a symbol's past quarters — actual vs. estimate EPS, surprise %, period (the surprise is the market-moving signal, surfaced prominently). `calendar`: upcoming releases across the market in a date window — date, EPS/revenue estimates, symbol. `history` requires `symbol`; `calendar` uses `from`/`to`. | `mode`, `symbol?`, `from?`, `to?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_news` | Financial news in two modes. `company`: recent articles for one symbol over a date range — headline, source, datetime, summary, URL ("what's driving AAPL today?"). `market`: broad market headlines by category (general, forex, crypto, merger). `company` requires `symbol`; `market` uses `category`. | `mode`, `symbol?`, `from?`, `to?`, `category?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_recommendations` | Analyst recommendation trends for one US symbol: strong-buy / buy / hold / sell / strong-sell counts per month, newest first. The consensus view to pair with the live quote and fundamentals from `finnhub_get_company`. | `symbol`, `limit?` | `readOnlyHint`, `openWorldHint` |

All six tools are read-only, idempotent in spirit (no `idempotentHint` — upstream data changes between calls so repeated calls legitimately differ), and `openWorldHint: true` (live external API).

### Error Contracts

Declared inline on each tool as `errors: [{ reason, code, when, recovery }]`, thrown via `ctx.fail(reason, …)`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble automatically and are **not** declared. The three domain failures below recur across the surface because they are properties of the Finnhub free tier, not of any one endpoint.

| Tool | `reason` | Code | When | Recovery |
|:-----|:---------|:-----|:-----|:---------|
| `finnhub_get_quote` | `symbol_not_found` | `NotFound` | Quote came back all-zero (`c=0, t=0`, `d`/`dp` null) — Finnhub's sentinel for an unknown US symbol (HTTP 200) | Verify the ticker, or call `finnhub_search_symbols` to resolve the company name to a valid US symbol. |
| `finnhub_get_quote` | `not_us_or_paid` | `Forbidden` | Upstream returned HTTP 403 — the symbol is international or otherwise outside the free US-equity tier | This server's free Finnhub tier covers US stocks only; international symbols require a paid Finnhub plan. Try the US listing of the company. |
| `finnhub_get_company` | `symbol_not_found` | `NotFound` | `/stock/profile2` returned an empty object for the symbol | Verify the ticker, or call `finnhub_search_symbols` to resolve the company name first. |
| `finnhub_get_company` | `not_us_or_paid` | `Forbidden` | Upstream returned HTTP 403 (international / paid-only symbol) | Free tier is US equities only; international symbols need a paid Finnhub plan. Try the company's US listing. |
| `finnhub_get_earnings` | `missing_symbol` | `InvalidParams` | `mode: 'history'` was requested without `symbol` | Provide a `symbol` for history mode, or switch to `mode: 'calendar'` for the market-wide upcoming-releases feed. |
| `finnhub_get_earnings` | `not_us_or_paid` | `Forbidden` | Upstream HTTP 403 on the symbol | Free tier is US equities only; use a US symbol or a paid plan. |
| `finnhub_get_news` | `missing_symbol` | `InvalidParams` | `mode: 'company'` was requested without `symbol` | Provide a `symbol` for company mode, or switch to `mode: 'market'` with a `category`. |
| `finnhub_get_news` | `not_us_or_paid` | `Forbidden` | Upstream HTTP 403 on the symbol | Free tier is US equities only; use a US symbol or a paid plan. |
| `finnhub_get_recommendations` | `no_coverage` | `NotFound` | Endpoint returned an empty array — no analyst coverage for the symbol | Verify the symbol is valid with `finnhub_search_symbols`; some thinly-traded or newly-listed stocks have no analyst coverage on Finnhub. |
| `finnhub_get_recommendations` | `not_us_or_paid` | `Forbidden` | Upstream HTTP 403 | Free tier is US equities only; use a US symbol or a paid plan. |

`finnhub_search_symbols` declares **no** contract — `/search` returns `{count: 0, result: []}` for a no-hit query (HTTP 200), which is an empty success surfaced via `ctx.enrich.notice`, not an error.

The shared `not_us_or_paid` (`Forbidden`/403) and `invalid_key` handling live in the service layer (see Services): the service classifies a 403 into a `Forbidden` McpError and a 401 (`{"error":"Invalid API key."}`) into a `ConfigurationError`-class failure so a misconfigured key fails loudly at the first call rather than masquerading as "no data".

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `finnhub://news-categories` | The four valid market-news categories (`general`, `forex`, `crypto`, `merger`) with one-line descriptions. Static reference an agent reads before calling `finnhub_get_news` in `market` mode. Bounded (4 entries) — fully covered by the `category` enum's `.describe()`, so this resource is a convenience mirror, not a required path. | None |

No `finnhub://quote/{symbol}`-style resource: quotes are live and time-sensitive, the value is in the freshness, and tool-only clients (most of them) must reach quotes through `finnhub_get_quote` regardless. A stale-able URI would invite caching the one thing that must not be cached.

### Prompts

*(none — purely data/action-oriented server; no recurring multi-step framing that a static template improves)*

---

## Overview

Real-time US-equity market data, company fundamentals, earnings, analyst sentiment, and financial news via the [Finnhub](https://finnhub.io) REST API (v1, base `https://finnhub.io/api/v1`, key passed as the `token` query parameter).

Fills a fleet gap that no existing server touches: **live market prices and current company financial context**. `secedgar-mcp-server` covers SEC filings (the regulatory record); `exchange-rates-mcp-server` covers fiat FX; `coingecko` covers crypto. This is the live-equity leg — the "is the market up today?" / "how is NVDA doing right now?" workflow wrapped around the same companies SecEDGAR files for. Composes with SecEDGAR (Finnhub surfaces filing-adjacent news → SecEDGAR fetches the actual filing), WorldBank (macro context), and CoinGecko (crypto coverage).

**Target users:** developers, analysts, investors, financial journalists — any agent workflow that needs current market context, starting from a company name rather than a ticker.

**Read-only.** Finnhub's free tier is data-only. No writes, no auth scopes on the tool surface.

### Free-tier scope (verified against the live API, 2026-06-13)

The Finnhub free tier (60 req/min, US real-time) was probed directly with the provisioned key. This is the ground truth the surface is built on — **not** the endpoint list in the original idea sketch, which assumed candles and forex were free (they no longer are):

| Endpoint | Free tier | Backs |
|:---------|:----------|:------|
| `/search` | ✅ 200 | `finnhub_search_symbols` |
| `/quote` | ✅ 200 | `finnhub_get_quote` |
| `/stock/market-status` | ✅ 200 | `finnhub_get_quote` (market-open flag) |
| `/stock/profile2` | ✅ 200 | `finnhub_get_company` |
| `/stock/metric` | ✅ 200 | `finnhub_get_company` |
| `/stock/peers` | ✅ 200 | `finnhub_get_company` |
| `/stock/earnings` | ✅ 200 | `finnhub_get_earnings` (history) |
| `/calendar/earnings` | ✅ 200 | `finnhub_get_earnings` (calendar) |
| `/company-news` | ✅ 200 | `finnhub_get_news` (company) |
| `/news` | ✅ 200 | `finnhub_get_news` (market) |
| `/stock/recommendation` | ✅ 200 | `finnhub_get_recommendations` |
| `/stock/candle` | ❌ **403** `You don't have access to this resource.` | *(dropped — see Decisions Log)* |
| `/forex/rates` | ❌ **403** | *(dropped — see Decisions Log)* |
| `/news-sentiment` | ❌ **403** | *(not adopted)* |
| international symbols (`SHOP.TO`, `SAP.DE`) | ❌ **403** | *(domain error — see Known Limitations)* |

---

## Requirements

- Resolve a company name or partial ticker to a US stock symbol (entry point for the whole surface).
- Real-time quote for a US symbol that **states market-open vs. prior-close** rather than implying a stale price is live.
- Single-call company context: profile + fundamentals + peers.
- Earnings: historical actual-vs-estimate surprises for a symbol, and a market-wide upcoming-releases calendar.
- Financial news: per-company over a date range, and market-wide by category.
- Analyst recommendation consensus for a symbol.
- A **clear domain error for international / paid-only symbols** (HTTP 403) — never a silent empty result.
- A **clear not-found** for unknown US symbols (the all-zero quote sentinel) — never present zeros as a real price.
- Loud failure on a bad/missing API key — fail at first call, not as "no data".
- Respect the 60 req/min free-tier limit; the per-company fan-out (3 calls) stays well inside it for conversational use.
- `FINNHUB_API_KEY` is the one required env var (already provisioned in the gitignored `.env`).

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `FinnhubService` | Finnhub REST API (`https://finnhub.io/api/v1`, `token` query param) | All `finnhub_*` tools |

`FinnhubService` is the single upstream client (init/accessor pattern, initialized in `setup()`, accessed via `getFinnhubService()`). It owns:

- **Auth** — appends `token=<FINNHUB_API_KEY>` to every request. The key never appears in a tool input.
- **Typed endpoint methods** — one per upstream call, each returning a typed raw shape (see API Reference): `search`, `quote`, `marketStatus`, `profile`, `metrics`, `peers`, `earnings`, `earningsCalendar`, `companyNews`, `marketNews`, `recommendations`.
- **Resilience** — `fetchWithTimeout` + `withRetry` (from `@cyanheads/mcp-ts-core/utils`) wrapping the full fetch+parse pipeline. Base delay calibrated to a rate-limited upstream: ~1s (the 60/min limit is the realistic failure mode under burst). Non-OK → mapped, not blindly retried (see next).
- **Status classification** (the load-bearing part) — applied centrally so every tool inherits identical, correct behavior:

  | Upstream | Maps to | Rationale |
  |:---------|:--------|:----------|
  | HTTP 200, well-formed JSON | typed payload | normal |
  | HTTP 403 `You don't have access to this resource.` | `Forbidden` McpError (`reason: not_us_or_paid` at the tool) | international or paid-only symbol/endpoint |
  | HTTP 401 `Invalid API key.` | `ConfigurationError`-class (non-retryable) | misconfigured key — fail loud, not "no data" |
  | HTTP 429 | `RateLimited`, retryable | 60/min exceeded |
  | HTTP 5xx / network / timeout | `ServiceUnavailable`, retryable | transient upstream |

  The 403 is classified in the service but surfaced as the tool's declared `not_us_or_paid` reason — the service throws a `Forbidden` McpError carrying enough context for the handler to re-key it via `ctx.fail`. (The all-zero-quote → `symbol_not_found` and empty-array → `no_coverage` checks are **per-tool**, not service-level — they are payload-shape decisions, not HTTP-status decisions.)

No DataCanvas, no MirrorService (see Decisions Log).

---

## Config

`src/config/server-config.ts` — lazy-parsed Zod schema, separate from framework config (pattern mirrors `smithsonian-mcp-server`).

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `FINNHUB_API_KEY` | **Yes** | — | Finnhub API key (free tier from finnhub.io/register). Passed as the `token` query param. Server fails to start without it. |
| `FINNHUB_BASE_URL` | No | `https://finnhub.io/api/v1` | Override the API base URL (local testing / proxy). |

```ts
const ServerConfigSchema = z.object({
  apiKey: z.string().min(1).describe(
    'Finnhub API key from https://finnhub.io/register. Required — server fails to start without it. Free tier: 60 req/min, US real-time.',
  ),
  baseUrl: z.string().default('https://finnhub.io/api/v1').describe('Finnhub REST API base URL.'),
});
// parseEnvConfig(ServerConfigSchema, { apiKey: 'FINNHUB_API_KEY', baseUrl: 'FINNHUB_BASE_URL' })
```

Both `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`) must declare `FINNHUB_API_KEY` — `lint:packaging` cross-checks the names.

---

## Tool Designs

Notation: input/output are Zod sketches; every field carries a `.describe()` in the build. Enrichment fields are **optional in the output-extension** unless marked required — the framework only populates truncation fields when the cap is hit, and declaring them required throws `-32007` on every non-truncated result (the standing capped-list rule).

### 1. `finnhub_search_symbols`

**Workflow:** "Find Microsoft's ticker" / "what's the symbol for Shopify?" — the resolver every other tool depends on.

**Wraps:** `GET /search?q={query}`.

```ts
input: z.object({
  query: z.string().min(1).describe(
    'Company name (e.g., "Apple"), partial name ("micro"), or ticker fragment. Finnhub full-text matches across symbols and descriptions. Use this first when you have a company name, not a ticker — the rest of the tools need a symbol.',
  ),
  limit: z.number().int().min(1).max(50).default(10).describe(
    'Max symbols to return (Finnhub often returns 10–50 matches for a common word). Default 10. US Common Stock matches are surfaced first.',
  ),
}),

output: z.object({
  results: z.array(z.object({
    symbol: z.string().describe('Finnhub symbol — pass this to finnhub_get_quote / _company / _earnings / _news / _recommendations.'),
    displaySymbol: z.string().describe('Human-facing ticker as shown on its exchange (e.g., "AAPL", "603020.SS").'),
    description: z.string().describe('Company / security name.'),
    type: z.string().describe('Security type (e.g., "Common Stock", "ETP", "ETF"). Empty string when Finnhub omits it.'),
    isLikelyUS: z.boolean().describe('Heuristic: symbol has no exchange suffix (no dot) — i.e., a plain US ticker reachable on the free tier. Suffixed symbols (".SS", ".T", ".L") are international and 403 on quote/profile.'),
  })).describe('Matched symbols, US Common Stock first, then by Finnhub order.'),
}),

enrichment: {
  totalCount: z.number().describe('Total matches Finnhub reported (its `count`), before the limit.'),
  notice: z.string().optional().describe('Guidance when nothing matched.'),
},
```

**Handler flow:**
1. `service.search(input.query)` → `{ count, result[] }`.
2. Map each `result` to the output object. Compute `isLikelyUS = !symbol.includes('.')` — surfaced so the agent can avoid burning a `not_us_or_paid` 403 on a suffixed symbol. (Honest signal, not a fabricated score: the dot-suffix → non-US mapping is how Finnhub namespaces exchanges.)
3. Stable sort: US Common Stock (`isLikelyUS && type === 'Common Stock'`) first, preserving Finnhub order within groups.
4. `ctx.enrich.total(count)`. If `count === 0`, `ctx.enrich.notice('No symbols matched "<query>". Try the company's common name or a ticker fragment.')`.
5. Slice to `limit` and return.

**Capped-list disclosure:** `totalCount` (required enrichment) satisfies the rule; when `count > limit` also call `ctx.enrich.truncated({ shown: limit, cap: limit })` so the agent knows more exist. `truncated`/`shown`/`cap` are **optional** in the enrichment extension.

`format()`: a markdown list — `**AAPL** — Apple Inc (Common Stock, US)` per row, with the total and any notice in the enrichment trailer.

### 2. `finnhub_get_quote`

**Workflow:** "How is Apple doing right now?" — the headline tool. The market-hours flag is the whole reason this isn't a one-line curl wrapper.

**Wraps:** `GET /quote?symbol={symbol}` **+** `GET /stock/market-status?exchange=US` — two calls, fanned out with `Promise.allSettled` (market-status failing degrades to "unknown", never tanks the quote).

```ts
input: z.object({
  symbol: z.string().min(1).describe(
    'US stock ticker (e.g., "AAPL", "MSFT"). Resolve a company name with finnhub_search_symbols first. International symbols (with an exchange suffix like ".TO") are not on the free tier and return a clear error.',
  ),
}),

output: z.object({
  symbol: z.string().describe('The symbol quoted (echo of input).'),
  current: z.number().describe('Current price when the market is open; the most recent close when it is not — read `priceIsLive`.'),
  change: z.number().nullable().describe('Absolute change vs. previous close (raw field: `d`). Null when Finnhub omits it (e.g., all-zero sentinel returns null for d).'),
  percentChange: z.number().nullable().describe('Percent change vs. previous close (raw field: `dp`). Null when omitted.'),
  high: z.number().describe('Session high.'),
  low: z.number().describe('Session low.'),
  open: z.number().describe('Session open.'),
  previousClose: z.number().describe('Previous trading day close.'),
  quoteTime: z.string().describe('Quote timestamp as ISO 8601 (converted from the Finnhub `t` Unix epoch).'),
  marketOpen: z.boolean().nullable().describe('Whether the US market is currently open (from market-status). Null when the status check failed.'),
  priceIsLive: z.boolean().describe('True only when marketOpen is true. When false, `current` is the prior close — do not present it as a live price.'),
}),

errors: [
  { reason: 'symbol_not_found', code: NotFound, when: 'Quote sentinel detected (c=0, t=0, d=null, dp=null) — unknown US symbol at HTTP 200',
    recovery: 'Verify the ticker, or call finnhub_search_symbols to resolve the company name to a valid US symbol.' },
  { reason: 'not_us_or_paid', code: Forbidden, when: 'Upstream HTTP 403 — international or paid-only symbol',
    recovery: 'This free Finnhub tier covers US stocks only; international symbols need a paid plan. Try the US listing.' },
],
```

**Handler flow:**
1. `Promise.allSettled([service.quote(symbol), service.marketStatus('US')])`. A 403 from the quote leg rejects → propagate as `ctx.fail('not_us_or_paid', …)`.
2. **All-zero sentinel:** if `quote.t === 0 && quote.c === 0` → `throw ctx.fail('symbol_not_found', …)`. (Verified: bogus symbols return `{c:0,d:null,dp:null,h:0,l:0,o:0,pc:0,t:0}` at HTTP 200 — status code can't carry this; the payload shape must. Note: `d` and `dp` are null in the sentinel, not zero, which is why the sentinel check uses `c` and `t`.)
3. `marketOpen = status.fulfilled ? status.value.isOpen : null`; `priceIsLive = marketOpen === true`.
4. Convert `t` (Unix seconds) → ISO 8601 for `quoteTime`.
5. Return the normalized object.

`format()`: `**AAPL** $291.13 ▼ -1.52% (prior close — market closed)` — the parenthetical flips to `(live)` when `priceIsLive`. The live/stale qualifier must appear in `format()` text, not only `structuredContent`, so `content[]`-only clients see it too.

### 3. `finnhub_get_company`

**Workflow:** "Tell me about Apple" — profile is hollow without the valuation numbers, so this is deliberately one tool over three.

**Wraps:** `GET /stock/profile2` + `GET /stock/metric?metric=all` + `GET /stock/peers` — `Promise.allSettled` fan-out. Profile is the spine (its 403/empty drives the error); metrics and peers degrade to partial on failure.

```ts
input: z.object({
  symbol: z.string().min(1).describe(
    'US stock ticker (e.g., "AAPL"). Resolve a company name with finnhub_search_symbols first. International symbols are not on the free tier.',
  ),
}),

output: z.object({
  symbol: z.string().describe('The symbol queried (echo of input).'),
  profile: z.object({
    name: z.string().describe('Company name.'),
    exchange: z.string().describe('Listing exchange (e.g., "NASDAQ NMS - GLOBAL MARKET").'),
    industry: z.string().describe('Finnhub industry classification.'),
    country: z.string().describe('Country code (e.g., "US").'),
    currency: z.string().describe('Reporting currency.'),
    marketCapitalization: z.number().nullable().describe('Market cap in millions of `currency`. Null when omitted.'),
    shareOutstanding: z.number().nullable().describe('Shares outstanding in millions. Null when omitted.'),
    ipo: z.string().nullable().describe('IPO date (YYYY-MM-DD). Null when omitted.'),
    weburl: z.string().nullable().describe('Company website. Null when omitted.'),
    logo: z.string().nullable().describe('Logo image URL. Null when omitted.'),
  }).describe('Company profile from /stock/profile2.'),
  fundamentals: z.object({
    peTTM: z.number().nullable().describe('Price/earnings, trailing twelve months.'),
    epsTTM: z.number().nullable().describe('Earnings per share, TTM.'),
    week52High: z.number().nullable().describe('52-week high price.'),
    week52Low: z.number().nullable().describe('52-week low price.'),
    beta: z.number().nullable().describe('Beta vs. the market.'),
    dividendYieldTTM: z.number().nullable().describe('Current dividend yield %, TTM.'),
    netProfitMarginTTM: z.number().nullable().describe('Net profit margin %, TTM.'),
    grossMarginTTM: z.number().nullable().describe('Gross margin %, TTM.'),
    revenueGrowthTTMYoy: z.number().nullable().describe('Revenue growth % YoY, TTM.'),
    roeTTM: z.number().nullable().describe('Return on equity %, TTM.'),
  }).describe('Headline fundamentals from /stock/metric (a curated subset of ~100 available metrics). Every field nullable — Finnhub omits metrics for thinly-covered names.'),
  peers: z.array(z.string()).describe('Sector peer symbols from /stock/peers (includes the queried symbol). Empty when none.'),
  partial: z.array(z.string()).optional().describe('Names of the sub-fetches that failed (e.g., ["metrics"]) when the call partially degraded. Absent on a full success.'),
}),

errors: [
  { reason: 'symbol_not_found', code: NotFound, when: '/stock/profile2 returned an empty object',
    recovery: 'Verify the ticker, or call finnhub_search_symbols to resolve the company name first.' },
  { reason: 'not_us_or_paid', code: Forbidden, when: 'Upstream HTTP 403 — international or paid-only symbol',
    recovery: 'Free tier is US equities only; international symbols need a paid Finnhub plan. Try the US listing.' },
],
```

**Handler flow:**
1. `Promise.allSettled([service.profile(symbol), service.metrics(symbol), service.peers(symbol)])`.
2. Profile leg drives errors: a 403 rejection → `ctx.fail('not_us_or_paid')`; a fulfilled-but-`{}` profile (verified empty-object response for unknown symbols) → `ctx.fail('symbol_not_found')`.
3. Pick the curated fundamentals subset from `metric` (keys verified present on a live `metric=all` pull: `peTTM`, `epsTTM`, `52WeekHigh`, `52WeekLow`, `beta`, `currentDividendYieldTTM`, `netProfitMarginTTM`, `grossMarginTTM`, `revenueGrowthTTMYoy`, `roeTTM`). Every field maps through `?? null` — never fabricate a missing metric.
4. `peers` from the peers leg (already a string array) or `[]`.
5. `partial = [legs that rejected]`; omit the field entirely when all three fulfilled.

**Sparsity rule (framework checklist):** fundamentals are all-nullable by design — a thinly-covered small-cap returns a populated profile with a near-empty metric block, and the tool must surface that honestly rather than zero-filling. `format()` and the test suite both include a sparse-symbol case.

`format()`: a profile header, a fundamentals table (omit rows that are null), a peers line, and a `⚠ partial: metrics unavailable` note when `partial` is set.

### 4. `finnhub_get_earnings`

**Workflow:** "Has Apple been beating estimates?" (`history`) / "Who reports next week?" (`calendar`). Mode-consolidated because both are the same noun (earnings) from two angles.

**Wraps:** `mode: 'history'` → `GET /stock/earnings?symbol={symbol}`; `mode: 'calendar'` → `GET /calendar/earnings?from={from}&to={to}`.

```ts
input: z.object({
  mode: z.enum(['history', 'calendar']).describe(
    "'history' = one symbol's past quarters with actual-vs-estimate surprises (requires `symbol`). 'calendar' = market-wide upcoming releases in a date window (uses `from`/`to`).",
  ),
  symbol: z.string().optional().describe('Required for `history`. US ticker. Resolve a name with finnhub_search_symbols first. Ignored in `calendar` mode.'),
  from: z.string().optional().describe('Calendar mode: window start (YYYY-MM-DD). Defaults to today when omitted.'),
  to: z.string().optional().describe('Calendar mode: window end (YYYY-MM-DD). Defaults to today + 14 days when omitted.'),
  limit: z.number().int().min(1).max(100).default(50).describe('Max rows returned (history quarters or calendar entries). Default 50.'),
}),

output: z.object({
  mode: z.enum(['history', 'calendar']).describe('The mode used (echo of input).'),
  history: z.array(z.object({
    period: z.string().describe('Fiscal period end (YYYY-MM-DD).'),
    year: z.number().describe('Fiscal year.'),
    quarter: z.number().describe('Fiscal quarter (1–4).'),
    actualEPS: z.number().nullable().describe('Reported EPS. Null if not yet reported.'),
    estimateEPS: z.number().nullable().describe('Consensus estimate EPS.'),
    surprise: z.number().nullable().describe('actual − estimate (absolute).'),
    surprisePercent: z.number().nullable().describe('Surprise as % of estimate — the market-moving signal. Positive = beat, negative = miss.'),
  })).optional().describe('Present in `history` mode. Newest quarter first.'),
  calendar: z.array(z.object({
    symbol: z.string().describe('Stock ticker.'),
    date: z.string().describe('Expected report date (YYYY-MM-DD).'),
    hour: z.string().describe('"bmo" (before open) / "amc" (after close) / "" when unknown.'),
    epsEstimate: z.number().nullable().describe('Consensus EPS estimate. Null for distant future dates or uncovered symbols.'),
    revenueEstimate: z.number().nullable().describe('Consensus revenue estimate in the reporting currency. Null when unavailable.'),
    year: z.number().describe('Fiscal year.'),
    quarter: z.number().describe('Fiscal quarter (1–4).'),
  })).optional().describe('Present in `calendar` mode. Sorted by date. Note: `epsActual` and `revenueActual` are not surfaced here — this tool is for the upcoming-releases workflow; actuals are available in `history` mode for a specific symbol.'),
}),

enrichment: {
  totalCount: z.number().describe('Total rows available before the limit.'),
  truncated: z.boolean().optional(),
  shown: z.number().optional(),
  cap: z.number().optional(),
  notice: z.string().optional().describe('Guidance when the result set is empty.'),
},

errors: [
  { reason: 'missing_symbol', code: InvalidParams, when: "mode 'history' without symbol",
    recovery: 'Provide a `symbol` for history mode, or switch to mode: calendar for the market-wide feed.' },
  { reason: 'not_us_or_paid', code: Forbidden, when: 'Upstream HTTP 403 on the symbol',
    recovery: 'Free tier is US equities only; use a US symbol or a paid plan.' },
],
```

**Handler flow:**
1. `mode === 'history'`: require `symbol` (else `ctx.fail('missing_symbol')`); `service.earnings(symbol)` → array, newest first; map to `history[]`.
2. `mode === 'calendar'`: default `from`/`to` (today, +14d); `service.earningsCalendar(from, to)` → `{ earningsCalendar[] }`; map to `calendar[]`. (Verified: free; `epsActual`/`epsEstimate` are commonly `null` for distant dates — surfaced honestly.)
3. `ctx.enrich.total(rows.length)`; slice to `limit`; if sliced, `ctx.enrich.truncated({ shown: limit, cap: limit })`. Empty → `ctx.enrich.notice(...)`.

The two output arrays are a discriminated-by-`mode` pair; only one is populated. `format()` renders whichever is present (a surprise-% column for history, a date/symbol list for calendar).

### 5. `finnhub_get_news`

**Workflow:** "What's driving AAPL today?" (`company`) / "Top market headlines" (`market`).

**Wraps:** `mode: 'company'` → `GET /company-news?symbol={symbol}&from={from}&to={to}`; `mode: 'market'` → `GET /news?category={category}`.

```ts
input: z.object({
  mode: z.enum(['company', 'market']).describe(
    "'company' = recent articles for one symbol over a date range (requires `symbol`). 'market' = broad headlines by `category`.",
  ),
  symbol: z.string().optional().describe('Required for `company` mode. US ticker. Ignored in `market` mode.'),
  from: z.string().optional().describe('Company mode: window start (YYYY-MM-DD). Defaults to today − 7 days.'),
  to: z.string().optional().describe('Company mode: window end (YYYY-MM-DD). Defaults to today.'),
  category: z.enum(['general', 'forex', 'crypto', 'merger']).default('general').describe('Market mode: news category. See finnhub://news-categories.'),
  limit: z.number().int().min(1).max(50).default(15).describe('Max articles. Default 15 — news lists run long; keep context lean.'),
}),

output: z.object({
  mode: z.enum(['company', 'market']).describe('The mode used (echo of input).'),
  articles: z.array(z.object({
    headline: z.string().describe('Article headline.'),
    source: z.string().describe('Publisher name.'),
    datetime: z.string().describe('Publish time, ISO 8601 (from Finnhub `datetime` epoch).'),
    summary: z.string().describe('Article summary (may be empty).'),
    url: z.string().describe('Link to the article.'),
    category: z.string().optional().describe('Finnhub category tag (market mode). Note: the response category may differ from the requested category (e.g., "business" for a "general" request).'),
    related: z.string().optional().describe('Related symbol(s) Finnhub tagged.'),
  })).describe('Articles, newest first.'),
}),

enrichment: {
  totalCount: z.number().describe('Total articles available before the limit.'),
  truncated: z.boolean().optional(),
  shown: z.number().optional(),
  cap: z.number().optional(),
  notice: z.string().optional(),
},

errors: [
  { reason: 'missing_symbol', code: InvalidParams, when: "mode 'company' without symbol",
    recovery: 'Provide a `symbol` for company mode, or switch to mode: market with a category.' },
  { reason: 'not_us_or_paid', code: Forbidden, when: 'Upstream HTTP 403 on the symbol',
    recovery: 'Free tier is US equities only; use a US symbol or a paid plan.' },
],
```

**Handler flow:**
1. `company`: require `symbol`; default the 7-day window; `service.companyNews(symbol, from, to)` → array.
2. `market`: `service.marketNews(category)` → array.
3. Convert `datetime` epochs → ISO; sort newest first; `ctx.enrich.total(len)`; slice to `limit` with truncation disclosure; empty → notice.

`format()`: `**<headline>** — <source>, <date>` per article with the URL, total/truncation in the trailer.

### 6. `finnhub_get_recommendations`

**Workflow:** "What do analysts think of Apple?" — the consensus layer beside the quote and fundamentals. This is the slot the dropped `finnhub_get_candles` vacated; it is genuinely free-tier and genuinely useful.

**Wraps:** `GET /stock/recommendation?symbol={symbol}`.

```ts
input: z.object({
  symbol: z.string().min(1).describe('US stock ticker (e.g., "AAPL"). Resolve a name with finnhub_search_symbols first.'),
  limit: z.number().int().min(1).max(24).default(12).describe('Max months to return, newest first. Default 12 (one year of consensus history). The API typically returns 12–24 months; setting this higher surfaces older trend data.'),
}),

output: z.object({
  symbol: z.string().describe('The symbol queried (echo of input).'),
  trends: z.array(z.object({
    period: z.string().describe('Month the consensus is for (YYYY-MM-DD, first of month).'),
    strongBuy: z.number().describe('Number of analysts with a Strong Buy rating this month.'),
    buy: z.number().describe('Number of analysts with a Buy rating this month.'),
    hold: z.number().describe('Number of analysts with a Hold rating this month.'),
    sell: z.number().describe('Number of analysts with a Sell rating this month.'),
    strongSell: z.number().describe('Number of analysts with a Strong Sell rating this month.'),
  })).describe('Recommendation counts per month, newest first. Typically 12–24 months of history.'),
}),

errors: [
  { reason: 'no_coverage', code: NotFound, when: 'Endpoint returned an empty array — no analyst coverage',
    recovery: 'Verify the symbol is valid with finnhub_search_symbols; some thinly-traded or newly-listed stocks have no analyst coverage on Finnhub.' },
  { reason: 'not_us_or_paid', code: Forbidden, when: 'Upstream HTTP 403',
    recovery: 'Free tier is US equities only; use a US symbol or a paid plan.' },
],

enrichment: {
  totalCount: z.number().describe('Total months available before the limit.'),
  truncated: z.boolean().optional(),
  shown: z.number().optional(),
  cap: z.number().optional(),
},
```

**Handler flow:** `service.recommendations(symbol)` → array; empty → `ctx.fail('no_coverage')`; sort newest first; `ctx.enrich.total(all.length)`; slice to `limit`; if sliced, `ctx.enrich.truncated({ shown: limit, cap: limit })`; return.

**Capped-list disclosure:** `totalCount` required; `truncated`/`shown`/`cap` are `.optional()` in enrichment extension — framework only sets them when the cap is hit.

`format()`: a per-month table (`2026-06: 14 strong-buy / 24 buy / 15 hold / 2 sell / 0 strong-sell`), with total/truncation in the enrichment trailer.

---

## Workflow Analysis

Only `finnhub_get_quote` and `finnhub_get_company` make multiple upstream calls; both fan out in parallel and degrade gracefully.

`finnhub_get_quote` (2 calls):

| # | Call | Purpose | On failure |
|:--|:-----|:--------|:-----------|
| 1 | `GET /quote?symbol={s}` | Price snapshot | 403 → `not_us_or_paid`; all-zero → `symbol_not_found` |
| 2 | `GET /stock/market-status?exchange=US` | Live market-open flag | degrade: `marketOpen = null`, `priceIsLive = false` |

`finnhub_get_company` (3 calls, `Promise.allSettled`):

| # | Call | Purpose | On failure |
|:--|:-----|:--------|:-----------|
| 1 | `GET /stock/profile2?symbol={s}` | Profile (spine) | 403 → `not_us_or_paid`; `{}` → `symbol_not_found` |
| 2 | `GET /stock/metric?symbol={s}&metric=all` | Fundamentals | degrade: `fundamentals` all-null, add `partial: ['metrics']` |
| 3 | `GET /stock/peers?symbol={s}` | Sector peers | degrade: `peers: []`, add `partial: ['peers']` |

The fan-out is why the per-company call costs 3 of the 60/min budget — fine for conversational use, documented as tight for bulk (Known Limitations).

---

## Domain Mapping

| Noun | Operations → Tools |
|:-----|:-------------------|
| Symbol | resolve-by-name (→ `finnhub_search_symbols`) |
| Quote | get-live (→ `finnhub_get_quote`, + market-status) |
| Company | get-context = profile + metrics + peers (→ `finnhub_get_company`) |
| Earnings | history-for-symbol, upcoming-calendar (→ `finnhub_get_earnings`, mode) |
| News | for-company, by-category (→ `finnhub_get_news`, mode) |
| Analyst sentiment | recommendation-trends (→ `finnhub_get_recommendations`) |

---

## API Reference

**Base:** `https://finnhub.io/api/v1` · **Auth:** `?token=<FINNHUB_API_KEY>` on every request · **Free tier:** 60 req/min, US real-time.

| Endpoint | Params | Response shape (verified 2026-06-13) |
|:---------|:-------|:-------------------------------------|
| `GET /search` | `q` | `{ count, result: [{ symbol, displaySymbol, description, type }] }` |
| `GET /quote` | `symbol` | `{ c, d, dp, h, l, o, pc, t }` — `c`=current, `d`=change, `dp`=%chg, `h`=session high, `l`=low, `o`=open, `pc`=prev close, `t`=epoch (Unix seconds). **Unknown symbol → all-zero/null at HTTP 200: `{c:0,d:null,dp:null,h:0,l:0,o:0,pc:0,t:0}`.** |
| `GET /stock/market-status` | `exchange=US` | `{ exchange, holiday, isOpen, session, t, timezone }` |
| `GET /stock/profile2` | `symbol` | `{ ticker, name, country, currency, exchange, ipo, marketCapitalization, shareOutstanding, logo, weburl, finnhubIndustry, ... }` — **unknown symbol → `{}`.** |
| `GET /stock/metric` | `symbol`, `metric=all` | `{ metric: { peTTM, epsTTM, 52WeekHigh, 52WeekLow, beta, currentDividendYieldTTM, netProfitMarginTTM, grossMarginTTM, revenueGrowthTTMYoy, roeTTM, ...~100 keys }, metricType, series, symbol }` |
| `GET /stock/peers` | `symbol` | `["AAPL","DELL",...]` (includes the queried symbol) |
| `GET /stock/earnings` | `symbol` | `[{ actual, estimate, period, quarter, surprise, surprisePercent, symbol, year }]` |
| `GET /calendar/earnings` | `from`, `to` | `{ earningsCalendar: [{ date, epsActual, epsEstimate, hour, quarter, revenueActual, revenueEstimate, symbol, year }] }` (estimates often null for distant dates) |
| `GET /company-news` | `symbol`, `from`, `to` | `[{ category, datetime, headline, id, image, related, source, summary, url }]` |
| `GET /news` | `category` | same article shape as company-news |
| `GET /stock/recommendation` | `symbol` | `[{ symbol, period, strongBuy, buy, hold, sell, strongSell }]` — **empty array when no coverage.** |

**Error envelopes:** `403 {"error":"You don't have access to this resource."}` (international/paid) · `401 {"error":"Invalid API key."}` · `429` (rate limit). All errors are a flat `{ error: string }` with no code field — classify on HTTP status.

---

## Decisions Log

**Dropped `finnhub_get_candles` (idea.md tool #6).** Live probe: `GET /stock/candle` returns **HTTP 403 `You don't have access to this resource.`** on the provisioned free key, across resolutions and date ranges, stable on retry. Finnhub moved OHLCV candles to paid plans since the idea was sketched. The seed's premise — "actual real-time quotes on the free tier, no fake EOD delay" — holds for quotes but **not** for candles. Shipping a tool that 403s on every call is broken-on-arrival; cut it. Candle/charting support is the natural first addition if/when a paid key is provisioned, and is where the deferred DataCanvas idea would land (long-range OHLCV is the one analytical-shape result in this domain). Recorded as a paid-tier future item, not a v1 gap.

**Dropped `finnhub_get_forex` (idea.md tool #7).** `GET /forex/rates` also returns **HTTP 403** on the free tier. Independently, FX is already covered by the fleet's `exchange-rates-mcp-server` (ECB reference rates, keyless) — so even on a paid key this tool would duplicate a better-scoped sibling. Cut with no replacement; if cross-asset FX context is needed, that's `exchange-rates-mcp-server`'s job. (Stating capabilities, not anti-positioning: the FX leg lives in a dedicated server.)

**Added `finnhub_get_recommendations` (not in idea.md).** Probing surfaced `/stock/recommendation`, `/stock/peers`, and `/stock/market-status` as free and genuinely useful. Recommendations fill the slot candles vacated with real free-tier value (analyst consensus is a natural companion to a live quote), keeping the surface at a useful six tools rather than a thin four. Peers folded into `finnhub_get_company`; market-status folded into `finnhub_get_quote`.

**Quote pairs with `/stock/market-status` instead of inferring from the timestamp.** The idea sketch said "flag when market is closed and price is previous-close." The cleanest signal is the dedicated market-status endpoint's `isOpen` boolean (verified free), not heuristics on the quote `t` epoch (which would misfire around holidays and pre/post-market). `priceIsLive` is derived strictly from `marketOpen === true`; when status is unavailable it fails safe to `false` (never claims live). This is the server reporting what only the server can know (is the exchange open) so the agent never presents a stale price as live.

**Unknown-symbol detection is payload-shape, not HTTP status.** Verified: a bogus ticker returns `{c:0,...,t:0}` at **HTTP 200**, and `/stock/profile2` returns `{}`. So `symbol_not_found` is detected by the all-zero quote / empty profile sentinels per-tool, while `not_us_or_paid` is the 403 classified in the service. Two distinct not-available cases, two distinct codes (`NotFound` vs `Forbidden`) — the agent needs to tell "no such US ticker" from "that's an international symbol you can't reach here".

**International-symbol error is the generic 403, surfaced as `not_us_or_paid`.** Probe confirmed `SHOP.TO` and `SAP.DE` return the *same* 403 as paywalled endpoints — Finnhub doesn't distinguish "international" from "paid feature" at the wire. So one `Forbidden` reason covers both, with a recovery hint that names the real fix (use the US listing / a paid plan). `finnhub_search_symbols` exposes `isLikelyUS` (dot-suffix heuristic) so an agent can avoid the 403 before spending a call.

**Mode consolidation on earnings and news.** Both nouns have two natural angles (history/calendar, company/market) sharing most of the response shape and all of the service wiring. One tool with a `mode` enum tightens the surface from four tools to two without diverging error semantics (the only mode-specific error is `missing_symbol`, declared once per tool). Quote/company/recommendations stay single-purpose — no second mode earns its place.

**No DataCanvas.** Every tool returns either a single record (quote, company) or a short, capped, categorical list (search hits, news, earnings rows, recommendation months) — discovery/drill-in shape, not analytical-SQL shape. The capped-list + enrichment-truncation pattern covers the lists; nothing here is something an agent would `GROUP BY`. (Candles would be — deferred with the candle tool.) Per the design skill's gate: canvas earns its keep on *shape, not size*, and emitting a `canvas_id` without a `dataframe_query` tool is dead output. Skip.

**No MirrorService.** Finnhub is a live-data API queried for *current* state — the whole point is freshness. There is no bounded corpus queried-far-more-than-it-changes to mirror; quotes, news, and recommendations change continuously. The live API is the only correct data path.

**Capped-list truncation fields are optional in the output extension.** `truncated`/`shown`/`cap` are declared optional in each enrichment block; only `totalCount` is required (populated every call via `ctx.enrich.total`). The framework populates truncation fields only when the cap is actually hit — declaring them required throws `-32007` on every non-truncated result. (Standing fleet rule, pinned here so the build doesn't regress it.)

**Display identity is `finnhub-mcp-server` everywhere.** `createApp({ name: 'finnhub-mcp-server', title: 'finnhub-mcp-server', ... })`, manifest `display_name: 'finnhub-mcp-server'`. The hyphenated machine name is the title on every surface — never "Finnhub MCP Server". `title` is set explicitly (not left to fall back to the npm-scoped `name`, which would display the scope).

**`createApp()` identity block is `name` + `title` only.** `description` derives from `package.json` (the canonical source) — not duplicated into `createApp()`. No `websiteUrl`/`description` copies in the identity block (that's drift).

---

## Known Limitations

- **US equities only, real-time.** International symbols (any exchange-suffixed ticker — `.TO`, `.DE`, `.SS`, `.T`, `.L`) return HTTP 403 on the free tier and surface as `not_us_or_paid`. Documented in the README as the free-tier boundary.
- **No candles / OHLCV, no forex.** Both `/stock/candle` and `/forex/rates` are paid-tier (403). Charting and FX are out of scope for v1 (FX → `exchange-rates-mcp-server`).
- **60 req/min.** Comfortable for conversational use; tight for bulk. `finnhub_get_company` spends 3 calls per invocation. Finnhub REST has no multi-symbol quote batch endpoint — one symbol per quote call (documented; no client-side fan-out across many symbols in v1).
- **"Latest" quote when market is closed is the prior close.** Surfaced explicitly via `priceIsLive` / `marketOpen` — never presented as live.
- **Metric sparsity.** `/stock/metric` omits fields for thinly-covered names; all fundamentals are nullable and surfaced as such, never zero-filled.
- **Earnings calendar estimates are often null** for distant future dates — surfaced as null, not fabricated.

---

## Services (detail)

| Module | Type | Purpose | Used By |
|:-------|:-----|:--------|:--------|
| `FinnhubService` | Service | Auth'd, rate-aware, status-classifying HTTP client for all Finnhub endpoints | All tools |

```ts
class FinnhubService {
  // each method: fetchWithTimeout + withRetry, token appended, status classified
  search(q: string): Promise<FinnhubSearchResponse>
  quote(symbol: string): Promise<FinnhubQuote>
  marketStatus(exchange: string): Promise<FinnhubMarketStatus>
  profile(symbol: string): Promise<FinnhubProfile | Record<string, never>>  // {} for unknown
  metrics(symbol: string): Promise<FinnhubMetricResponse>
  peers(symbol: string): Promise<string[]>
  earnings(symbol: string): Promise<FinnhubEarning[]>
  earningsCalendar(from: string, to: string): Promise<FinnhubEarningsCalendar>
  companyNews(symbol: string, from: string, to: string): Promise<FinnhubNewsArticle[]>
  marketNews(category: string): Promise<FinnhubNewsArticle[]>
  recommendations(symbol: string): Promise<FinnhubRecommendation[]>
}
```

Typed raw shapes (`types.ts`) mirror the API Reference table. The service returns raw upstream shapes; tools normalize (epoch→ISO, parallel-array→objects is N/A here since no endpoint returns parallel arrays on the free tier, curated field subsets, sentinel→error). Resilience config: `withRetry` base ~1s (rate-limit-calibrated), `fetchWithTimeout` default; 403/401 are non-retryable (classified and thrown), 429/5xx/network are retryable.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` (`FINNHUB_API_KEY`, `FINNHUB_BASE_URL`); wire `server.json` + `manifest.json` env vars.
2. **`FinnhubService`** — `types.ts` raw shapes, init/accessor, `token` injection, `fetchWithTimeout` + `withRetry`, the status-classification table (403→Forbidden, 401→config error, 429/5xx→retryable). The load-bearing layer — build and test first.
3. **`finnhub_search_symbols`** — simplest, confirms service wiring + enrichment/truncation.
4. **`finnhub_get_quote`** — quote + market-status fan-out, all-zero sentinel, `priceIsLive` derivation.
5. **`finnhub_get_company`** — 3-way `allSettled`, curated fundamentals, `partial` degradation, sparse-symbol test.
6. **`finnhub_get_earnings`** — mode dispatch (history/calendar), date defaults.
7. **`finnhub_get_news`** — mode dispatch (company/market), date defaults.
8. **`finnhub_get_recommendations`** — single call, `no_coverage` empty-array sentinel.
9. **Resource** — `finnhub://news-categories`.

Each step independently testable. Steps 3–8 parallelize once the service is solid. Per the framework checklist: every tool's tests include at least one sparse/empty upstream case (sparse metric block, empty news, all-zero quote, empty recommendation array), since the free tier is full of partially-covered symbols.

---

## Review pass

**Date:** 2026-06-13. Independent review against the live Finnhub API (provisioned key). All probes were real API calls; no claims fabricated.

### Validated correct (no changes needed)

- All 11 free-tier endpoints confirmed accessible (200) and all 4 paid/international endpoints confirmed 403 — the cut of `/stock/candle` and `/forex/rates` is sound.
- `/stock/market-status?exchange=US` returns `{ exchange, holiday, isOpen, session, t, timezone }` — design matches.
- `/stock/profile2` returns `{}` for unknown symbols — sentinel detection is correct.
- `/quote` bogus-symbol sentinel is `{c:0,d:null,dp:null,h:0,l:0,o:0,pc:0,t:0}` at HTTP 200 — sentinel condition `c===0 && t===0` is correct.
- All 10 curated metric keys (`peTTM`, `epsTTM`, `52WeekHigh`, `52WeekLow`, `beta`, `currentDividendYieldTTM`, `netProfitMarginTTM`, `grossMarginTTM`, `revenueGrowthTTMYoy`, `roeTTM`) present and populated for AAPL.
- `/stock/peers` returns a plain string array including the queried symbol — design matches.
- `/stock/earnings` returns `[{ actual, estimate, period, quarter, surprise, surprisePercent, symbol, year }]` — matches the design's raw shape.
- `/calendar/earnings` wraps results in `{ earningsCalendar: [...] }` — design's service method signature is correct.
- `/stock/recommendation` returns `[{ symbol, period, strongBuy, buy, hold, sell, strongSell }]` — design matches.
- Auth: `?token=<key>` on every request — confirmed.
- 401 envelope: `{"error":"Invalid API key."}` — matches.
- 403 envelope: `{"error":"You don't have access to this resource."}` at HTTP 403 — matches.
- Identity: `createApp({ name, title })` only; no `description`/`websiteUrl` duplication — correct.
- Capped-list `-32007` rule: all capped-list tools declare `truncated`/`shown`/`cap` as `.optional()` — confirmed across all 4 tools with limits.

### Changes made

1. **API Reference table — `dp` was missing from the quote field list.** The table showed `{ c, d, h, l, o, pc, t }` but the live response has `dp` as a distinct field (percent change). Added `dp` explicitly and expanded the field annotation with full field name semantics.

2. **Quote output schema — added raw field name hints to `change` and `percentChange`.** Added `(raw field: \`d\`)` and `(raw field: \`dp\`)` to the `.describe()` text so the implementer maps the right source field. Also noted that `d`/`dp` are null (not zero) in the all-zero sentinel.

3. **All-zero sentinel description updated.** The error contract table and handler flow now both correctly note the sentinel shape as `c=0, t=0, d=null, dp=null` — the `d`/`dp` null detail matters for a robust implementation that checks more than just `c` and `t`.

4. **`finnhub_get_recommendations` — added `limit` input.** The endpoint returns all historical months (verified 24+ for large-caps). Without a cap, a single call can return 24 months × 6 fields = non-trivial context on a busy surface. Added `limit: z.number().int().min(1).max(24).default(12)` (one year default, two-year ceiling). Added the corresponding enrichment block (`totalCount`, `truncated?`, `shown?`, `cap?`) and updated the handler flow and MCP surface table.

5. **Missing `.describe()` on output fields — systematic fix.** The framework checklist requires `.describe()` on every field. Fixed:
   - `finnhub_get_recommendations` output: `symbol`, `strongBuy`, `buy`, `hold`, `sell`, `strongSell`, `trends` array description updated.
   - `finnhub_get_earnings` history: `year`, `quarter`; clarified `surprise` as "absolute".
   - `finnhub_get_earnings` calendar: `symbol`, `epsEstimate`, `revenueEstimate`, `year`, `quarter`; added note that `epsActual`/`revenueActual` are intentionally omitted (upstream has them; design is upcoming-releases focused).
   - `finnhub_get_news` output: `mode`, `headline`, `source`; added note that response `category` tag may differ from the requested category (observed: `"business"` returned for `"general"` request).
   - `finnhub_get_company` output: top-level `symbol`.

6. **`finnhub_get_recommendations` error recovery updated.** The `no_coverage` recovery text said "small-cap and non-US names often have no recommendation data" — live probe disproved this (PAPL, a small-cap, has full recommendation data). Updated to the accurate statement: some thinly-traded or newly-listed stocks have no coverage.

### Not added (deliberate cuts validated)

- **`epsActual`/`revenueActual` in calendar output**: the upstream `earningsCalendar` response includes these fields, but they are always null for upcoming events (the calendar's purpose). The design omits them intentionally. Added a note in the output schema describing this so the implementer doesn't add them reflexively.
- **No DataCanvas**: confirmed correct — all output shapes are discovery/drill-in (categorical lists, single records), not analytical. Nothing here is something an agent would GROUP BY.
- **No additional tools**: probed `/news-sentiment` — 403. No other free-tier endpoints that would add material value beyond the six confirmed tools.
