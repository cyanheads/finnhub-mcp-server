# finnhub-mcp-server — Design

**Package:** `@cyanheads/finnhub-mcp-server`
**Framework:** `@cyanheads/mcp-ts-core` `^0.13.22`
**Display identity:** `finnhub-mcp-server` (hyphenated machine name everywhere — `createApp` `title`, manifest `display_name`; never Title Case)

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `finnhub_search_symbols` | Resolve a company name or ticker to Finnhub symbols, exact matches first. | `query`, `limit?`, `exchange?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_quote` | Real-time price quote for one US stock symbol: current, change, %change, open, high, low, previous close. Pairs the quote with live market-status so the response states whether the price is live or the prior close — never implies a stale price is live. Resolve a name to a symbol with `finnhub_search_symbols` first. | `symbol` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_company` | US company profile, fundamentals, and peers grouped by sub-industry, industry, or sector. | `symbol`, `peerGrouping?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_earnings` | Earnings history or a paged calendar with estimates and reported actuals where available. | `mode`, `symbol?`, `from?`, `to?`, `limit?`, `offset?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_news` | Paged company news for a date window, or market news by category. | `mode`, `symbol?`, `from?`, `to?`, `category?`, `limit?`, `offset?` | `readOnlyHint`, `openWorldHint` |
| `finnhub_get_recommendations` | Analyst recommendation trends for one US symbol: strong-buy / buy / hold / sell / strong-sell counts per month, newest first. The consensus view to pair with the live quote and fundamentals from `finnhub_get_company`. | `symbol`, `limit?` | `readOnlyHint`, `openWorldHint` |

All six tools are read-only, idempotent in spirit (no `idempotentHint` — upstream data changes between calls so repeated calls legitimately differ), and `openWorldHint: true` (live external API).

Symbol inputs use Zod's native `.trim().toUpperCase()` checks before handlers run, preserving punctuation such as `BRK.B`. Required symbol schemas apply `.min(1)` after trimming; history/company-news keep `missing_symbol` for blank optional inputs. Earnings calendar treats blank as an omitted market-wide filter. Search queries remain unchanged; market news ignores `symbol`. No extra upstream lookup is needed to normalize a ticker.

### Error Contracts

Tool definitions declare domain errors with a reason, code, and recovery. Handlers use `ctx.fail` for their own errors and forward declared date-window errors from the shared helper. Framework failures such as `Timeout` and `ServiceUnavailable` propagate through the standard error pipeline.

| Tool | `reason` | Code | When | Recovery |
|:-----|:---------|:-----|:-----|:---------|
| `finnhub_get_quote` | `symbol_not_found` | `NotFound` | Quote came back all-zero (`c=0, t=0`, `d`/`dp` null) — Finnhub's sentinel for an unknown US symbol (HTTP 200) | Verify the ticker, or call `finnhub_search_symbols` to resolve the company name to a valid US symbol. |
| `finnhub_get_quote` | `not_us_or_paid` | `Forbidden` | Upstream returned HTTP 403 — the symbol is international or otherwise outside the free US-equity tier | This server's free Finnhub tier covers US stocks only; international symbols require a paid Finnhub plan. Try the US listing of the company. |
| `finnhub_get_company` | `symbol_not_found` | `NotFound` | `/stock/profile2` returned an empty object for the symbol | Verify the ticker with `finnhub_search_symbols`. ETFs, funds, or trusts may lack company profiles; try `finnhub_get_quote` for price data. |
| `finnhub_get_company` | `not_us_or_paid` | `Forbidden` | Upstream returned HTTP 403 (international / paid-only symbol) | Free tier is US equities only; international symbols need a paid Finnhub plan. Try the company's US listing. |
| `finnhub_get_earnings` | `missing_symbol` | `ValidationError` | `mode: 'history'` was requested without a nonblank `symbol` | Provide a `symbol` for history mode, or switch to `mode: 'calendar'` for the market-wide upcoming-releases feed. |
| `finnhub_get_earnings` | `not_us_or_paid` | `Forbidden` | Upstream HTTP 403 on the symbol | Free tier is US equities only; use a US symbol or a paid plan. |
| Earnings calendar and company news | `invalid_date` | `ValidationError` | A date bound is not a real `YYYY-MM-DD` date | Use a real date for the identified field. |
| Earnings calendar and company news | `inverted_date_window` | `ValidationError` | The resolved start follows the end | Choose a start date on or before the end date. |
| `finnhub_get_earnings` | `calendar_limit_exceeded` | `ValidationError` | Calendar limit exceeds 100 | Use a limit of 100 or less and continue with `nextOffset`. |
| `finnhub_get_news` | `missing_symbol` | `ValidationError` | `mode: 'company'` was requested without a nonblank `symbol` | Provide a `symbol` for company mode, or switch to `mode: 'market'` with a `category`. |
| `finnhub_get_news` | `not_us_or_paid` | `Forbidden` | Upstream HTTP 403 on the symbol | Free tier is US equities only; use a US symbol or a paid plan. |
| `finnhub_get_recommendations` | `no_coverage` | `NotFound` | Endpoint returned an empty array — no analyst coverage for the symbol | Verify the ticker with `finnhub_search_symbols`. ETFs, funds, or trusts may lack analyst coverage, as may thinly-traded or newly-listed stocks; try `finnhub_get_quote` for price data. |
| `finnhub_get_recommendations` | `not_us_or_paid` | `Forbidden` | Upstream HTTP 403 | Free tier is US equities only; use a US symbol or a paid plan. |

`finnhub_search_symbols` declares **no** contract — `/search` returns `{count: 0, result: []}` for a no-hit query (HTTP 200), which is an empty success surfaced via `ctx.enrich.notice`, not an error.

The service maps HTTP 403 to `Forbidden`. Tools that declare `not_us_or_paid` add that reason where the rejected request concerns a symbol. The service maps HTTP 401 to `ConfigurationError` so callers can distinguish invalid credentials from an empty result.

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
- Earnings history provides quarterly EPS surprises. The calendar includes estimates and available reported EPS and revenue for a date window, optionally filtered by symbol.
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

Tool definitions specify the input and output schemas. List tools disclose `totalCount`, with optional `truncated`, `shown`, and `cap` fields for local truncation.

### 1. `finnhub_search_symbols`

[Tool definition](../src/mcp-server/tools/definitions/search-symbols.tool.ts). Wraps `GET /search`.

- Send the 1–20-character query unchanged. Trim and uppercase a supplied exchange and echo it on both response surfaces, including an empty result. Blank or omitted exchange searches globally.
- Rank case-insensitive exact matches against `symbol` or `displaySymbol` first, then likely-US Common Stock, then other rows. Preserve Finnhub order within each group and apply the limit after ranking.
- `isLikelyUS` recognizes plain tickers and alphabetic `.A`/`.B` class shares. Quote and profile responses determine availability. Exchange filtering can exclude listings a ticker query would find.
- `totalCount` is Finnhub's reported count. Zero matches are a success with guidance.

### 2. `finnhub_get_quote`

**Workflow:** "How is Apple doing right now?" — the headline tool. The market-hours flag is the whole reason this isn't a one-line curl wrapper.

**Wraps:** `GET /quote?symbol={symbol}` **+** `GET /stock/market-status?exchange=US` — two calls, fanned out with `Promise.allSettled` (market-status failing degrades to "unknown", never tanks the quote).

```ts
input: z.object({
  symbol: z.string().trim().toUpperCase().min(1).describe(
    'US stock ticker (e.g., "AAPL", "MSFT"). Resolve a company name with finnhub_search_symbols first. International symbols (with an exchange suffix like ".TO") are not on the free tier and return a clear error.',
  ),
}),

output: z.object({
  symbol: z.string().describe('The symbol quoted, trimmed and uppercased.'),
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

[Tool definition](../src/mcp-server/tools/definitions/get-company.tool.ts). Fetches profile, fundamentals, and peers concurrently.

- The profile determines call success. Empty profiles and HTTP 403 surface the declared errors. Mark unavailable metrics or peers in `partial` and retain successful data.
- Missing numeric metrics remain null. The peers array can include the queried symbol.
- Omit Finnhub's `grouping` for `peerGrouping: 'subIndustry'`, the default. Send `industry` or `sector` verbatim when selected. Echo the choice on both response surfaces, including partial results.

### 4. `finnhub_get_earnings`

[Tool definition](../src/mcp-server/tools/definitions/get-earnings.tool.ts). History uses `GET /stock/earnings`. Calendar uses `GET /calendar/earnings` with an optional symbol filter.

- History requires a symbol and ignores calendar dates and offset. Its limit defaults to 50 and accepts larger positive integers. Empty history succeeds with ticker and coverage guidance.
- Calendar defaults to today through 14 days ahead in UTC. Resolve and validate the bounds with the [date-window helper](../src/services/finnhub/date-window.ts) before fetching. Omitted or blank symbol requests the market-wide feed.
- Calendar rows carry nullable EPS and revenue estimates and actuals. Preserve zero and `hour: "dmh"` for releases during market hours.
- Sort calendar rows by date then symbol with deterministic ties, then page with a zero-based offset. The limit defaults to 50 with a maximum of 100.
- Fetched bounds show the earliest and latest dates in the full upstream response. At 1,500 rows or more, warn that Finnhub may omit releases.

### 5. `finnhub_get_news`

[Tool definition](../src/mcp-server/tools/definitions/get-news.tool.ts). Company mode uses `GET /company-news`. Market mode uses `GET /news`.

- Company mode requires a symbol and defaults to the UTC window from seven days ago through today. Validate dates before fetching. Page after sorting newest first with deterministic ties.
- Company-news bounds show the earliest and latest timestamps among all fetched articles. Nonempty responses carry a caveat because even shorter responses can omit older articles.
- Market mode keeps its category-based request and newest-first local limit. An article's category tag may differ from the requested category. Both modes default to limit 15 with a maximum of 100.
- Normalize headline and summary text with the [article text helper](../src/services/finnhub/normalize-article-text.ts). Decode entities and preserve literal text and paragraph and list boundaries. Both response surfaces carry normalized text and the article URL.

The [paging helper](../src/mcp-server/tools/definitions/window-page.ts) shared with earnings calendar reports the fetched count, observed `fetchedFrom` and `fetchedTo`, and `nextOffset` while fetched rows remain. Continuation includes any upstream warning. Each page refetches Finnhub, so the result set can shift. An empty response has no fetched bounds. An offset at or beyond the fetched count has no next page.

### 6. `finnhub_get_recommendations`

[Tool definition](../src/mcp-server/tools/definitions/get-recommendations.tool.ts). Wraps `GET /stock/recommendation`.

- Return monthly rating counts, newest first. The local limit defaults to 12 and accepts larger positive integers. Upstream history depth varies by symbol.
- Empty upstream rows produce `no_coverage` with ticker verification guidance and the quote tool as an option for price data.

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
| 3 | `GET /stock/peers?symbol={s}` with optional `grouping` | Selected peer group | `peers: []` and `partial` includes `'peers'` |

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
| `GET /search` | `q`, optional `exchange` | `{ count, result: [{ symbol, displaySymbol, description, type }] }` |
| `GET /quote` | `symbol` | `{ c, d, dp, h, l, o, pc, t }` — `c`=current, `d`=change, `dp`=%chg, `h`=session high, `l`=low, `o`=open, `pc`=prev close, `t`=epoch (Unix seconds). **Unknown symbol → all-zero/null at HTTP 200: `{c:0,d:null,dp:null,h:0,l:0,o:0,pc:0,t:0}`.** |
| `GET /stock/market-status` | `exchange=US` | `{ exchange, holiday, isOpen, session, t, timezone }` |
| `GET /stock/profile2` | `symbol` | `{ ticker, name, country, currency, exchange, ipo, marketCapitalization, shareOutstanding, logo, weburl, finnhubIndustry, ... }` — **unknown symbol → `{}`.** |
| `GET /stock/metric` | `symbol`, `metric=all` | `{ metric: { peTTM, epsTTM, 52WeekHigh, 52WeekLow, beta, currentDividendYieldTTM, netProfitMarginTTM, grossMarginTTM, revenueGrowthTTMYoy, roeTTM, ...~100 keys }, metricType, series, symbol }` |
| `GET /stock/peers` | `symbol`, optional `grouping` (`industry` or `sector`) | Array of peer symbols. Default: sub-industry. |
| `GET /stock/earnings` | `symbol` | `[{ actual, estimate, period, quarter, surprise, surprisePercent, symbol, year }]` |
| `GET /calendar/earnings` | `from`, `to`, optional `symbol` | `{ earningsCalendar: [{ date, epsActual, epsEstimate, hour, quarter, revenueActual, revenueEstimate, symbol, year }] }` (estimates often null for distant dates) |
| `GET /company-news` | `symbol`, `from`, `to` | `[{ category, datetime, headline, id, image, related, source, summary, url }]` |
| `GET /news` | `category` | same article shape as company-news |
| `GET /stock/recommendation` | `symbol` | `[{ symbol, period, strongBuy, buy, hold, sell, strongSell }]` — **empty array when no coverage.** |

Classify failures by HTTP status. Finnhub can return a JSON `error` message for HTTP 401 or 403 and an HTML response for HTTP 429.

---

## Decisions Log

**Dropped `finnhub_get_candles` (idea.md tool #6).** Live probe: `GET /stock/candle` returns **HTTP 403 `You don't have access to this resource.`** on the provisioned free key, across resolutions and date ranges, stable on retry. Finnhub moved OHLCV candles to paid plans since the idea was sketched. The seed's premise — "actual real-time quotes on the free tier, no fake EOD delay" — holds for quotes but **not** for candles. Shipping a tool that 403s on every call is broken-on-arrival; cut it. Candle/charting support is the natural first addition if/when a paid key is provisioned, and is where the deferred DataCanvas idea would land (long-range OHLCV is the one analytical-shape result in this domain). Recorded as a paid-tier future item, not a v1 gap.

**Dropped `finnhub_get_forex` (idea.md tool #7).** `GET /forex/rates` also returns **HTTP 403** on the free tier. Independently, FX is already covered by the fleet's `exchange-rates-mcp-server` (ECB reference rates, keyless) — so even on a paid key this tool would duplicate a better-scoped sibling. Cut with no replacement; if cross-asset FX context is needed, that's `exchange-rates-mcp-server`'s job. (Stating capabilities, not anti-positioning: the FX leg lives in a dedicated server.)

**Added `finnhub_get_recommendations` (not in idea.md).** Probing surfaced `/stock/recommendation`, `/stock/peers`, and `/stock/market-status` as free and genuinely useful. Recommendations fill the slot candles vacated with real free-tier value (analyst consensus is a natural companion to a live quote), keeping the surface at a useful six tools rather than a thin four. Peers folded into `finnhub_get_company`; market-status folded into `finnhub_get_quote`.

**Quote pairs with `/stock/market-status` instead of inferring from the timestamp.** The idea sketch said "flag when market is closed and price is previous-close." The cleanest signal is the dedicated market-status endpoint's `isOpen` boolean (verified free), not heuristics on the quote `t` epoch (which would misfire around holidays and pre/post-market). `priceIsLive` is derived strictly from `marketOpen === true`; when status is unavailable it fails safe to `false` (never claims live). This is the server reporting what only the server can know (is the exchange open) so the agent never presents a stale price as live.

**Unknown-symbol detection is payload-shape, not HTTP status.** Verified: a bogus ticker returns `{c:0,...,t:0}` at **HTTP 200**, and `/stock/profile2` returns `{}`. So `symbol_not_found` is detected by the all-zero quote / empty profile sentinels per-tool, while `not_us_or_paid` is the 403 classified in the service. Two distinct not-available cases, two distinct codes (`NotFound` vs `Forbidden`) — the agent needs to tell "no such US ticker" from "that's an international symbol you can't reach here".

**International-symbol error is the generic 403, surfaced as `not_us_or_paid`.** Probe confirmed `SHOP.TO` and `SAP.DE` return the *same* 403 as paywalled endpoints — Finnhub doesn't distinguish "international" from "paid feature" at the wire. So one `Forbidden` reason covers both, with a recovery hint that names the real fix (use the US listing / a paid plan). `finnhub_search_symbols` exposes `isLikelyUS` as a ranking heuristic: plain tickers and `.A`/`.B` class shares are likely US, while recognized exchange suffixes are not. Endpoint responses remain authoritative.

**Mode consolidation on earnings and news.** History and calendar share an earnings tool. Company and market news share a news tool and article shape. Date validation and paging apply to the modes that query an upstream date window.

**No DataCanvas.** The tools return individual records and lists for lookup and comparison. Calendar and company-news callers can page through fetched records. Earnings history and recommendations return up to the requested number of available rows. None of these workflows requires a SQL interface.

**No MirrorService.** Finnhub is a live-data API queried for *current* state — the whole point is freshness. There is no bounded corpus queried-far-more-than-it-changes to mirror; quotes, news, and recommendations change continuously. The live API is the only correct data path.

**Capped-list truncation fields are optional in the output extension.** `truncated`/`shown`/`cap` are declared optional in each enrichment block; only `totalCount` is required (populated every call via `ctx.enrich.total`). The framework populates truncation fields only when the cap is actually hit — declaring them required throws `-32007` on every non-truncated result. (Standing fleet rule, pinned here so the build doesn't regress it.)

**Display identity is `finnhub-mcp-server` everywhere.** `createApp({ name: 'finnhub-mcp-server', title: 'finnhub-mcp-server', ... })`, manifest `display_name: 'finnhub-mcp-server'`. The hyphenated machine name is the title on every surface — never "Finnhub MCP Server". `title` is set explicitly (not left to fall back to the npm-scoped `name`, which would display the scope).

**`createApp()` identity block is `name` + `title` only.** `description` derives from `package.json` (the canonical source) — not duplicated into `createApp()`. No `websiteUrl`/`description` copies in the identity block (that's drift).

---

## Known Limitations

- **US equities only, real-time.** International symbols such as `SHOP.TO` and `SAP.DE` return HTTP 403 on the free tier and surface as `not_us_or_paid`. Dotted US class-share tickers such as `BRK.B` are preserved; a dot alone does not identify an international listing. Endpoint responses remain authoritative.
- **No candles / OHLCV, no forex.** Both `/stock/candle` and `/forex/rates` are paid-tier (403). Charting and FX are out of scope for v1 (FX → `exchange-rates-mcp-server`).
- **60 req/min.** Comfortable for conversational use; tight for bulk. `finnhub_get_company` spends 3 calls per invocation. Finnhub REST has no multi-symbol quote batch endpoint — one symbol per quote call (documented; no client-side fan-out across many symbols in v1).
- **"Latest" quote when market is closed is the prior close.** Surfaced explicitly via `priceIsLive` / `marketOpen` — never presented as live.
- **Metric sparsity.** `/stock/metric` omits fields for thinly-covered names; all fundamentals are nullable and surfaced as such, never zero-filled.
- **Earnings calendar estimates are often null** for distant future dates — surfaced as null, not fabricated.

---

## Services (detail)

[FinnhubService](../src/services/finnhub/finnhub-service.ts) owns upstream requests and status classification. [Raw types](../src/services/finnhub/types.ts) model the upstream response shapes. The tools normalize and paginate the responses.

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

## Upstream contract checks

The June 2026 free-tier checks established the endpoint coverage listed above, the quote and profile sentinels, the US market-status and company-context payloads, and the empty recommendation array.

Finnhub symbol lookup returns different sets with and without `exchange=US`. Global SPY, TM, and BABA searches list the exact ETP or ADR first. The default peers call yields the sub-industry group, with a distinct sector set for AAPL and a distinct industry set for MSFT.

Calendar and company news can return partial date coverage. The calendar can reach a 1,500-row ceiling, and a company-news query can omit older articles below 250 rows. Compare wide requests to narrower ones when validating coverage. Company news can include encoded entities, and market news can include HTML paragraphs.
