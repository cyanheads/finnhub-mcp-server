<div align="center">
  <h1>@cyanheads/finnhub-mcp-server</h1>
  <p><b>Real-time US-equity quotes, company fundamentals, earnings, analyst trends, and financial news via Finnhub. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/finnhub-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/finnhub-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/finnhub-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/finnhub-mcp-server/releases/latest/download/finnhub-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=finnhub-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmlubmh1Yi1tY3Atc2VydmVyIl0sImVudiI6eyJGSU5OSFVCX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22finnhub-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffinnhub-mcp-server%22%5D%2C%22env%22%3A%7B%22FINNHUB_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Six tools, name-first: `finnhub_search_symbols` resolves a company name to a US ticker, then the other five work from that symbol — a live quote, full company context, earnings, news, and analyst consensus.

| Tool | Description |
|:---|:---|
| `finnhub_search_symbols` | Resolve a company name or partial ticker to US stock symbols, best US match first. The entry point for every other tool. |
| `finnhub_get_quote` | Real-time price quote for one US symbol, paired with live market-status so the response states whether the price is live or the prior close. |
| `finnhub_get_company` | Full company context in one call — profile, headline fundamentals (P/E, EPS, margins, growth), and sector peers. |
| `finnhub_get_earnings` | Earnings in two modes: a symbol's past quarters with actual-vs-estimate surprises (`history`), or market-wide upcoming releases in a date window (`calendar`). |
| `finnhub_get_news` | Financial news in two modes: recent articles for one symbol over a date range (`company`), or broad market headlines by category (`market`). |
| `finnhub_get_recommendations` | Analyst recommendation trends for one US symbol — strong-buy / buy / hold / sell / strong-sell counts per month, newest first. |

### `finnhub_search_symbols`

Resolve a company name, partial name, or ticker fragment to Finnhub stock symbols. Run this first when you have a name, not a ticker — the rest of the surface needs a symbol.

- Full-text match across symbols and descriptions; US Common Stock matches surfaced first
- Each result carries `isLikelyUS` (a dot-suffix heuristic — `.SS`, `.T`, `.L` are international) so an agent can avoid spending a call on a symbol the free tier can't reach
- `limit` (1–50, default 10); reports the total match count and discloses truncation when more matched than returned

---

### `finnhub_get_quote`

Real-time price quote for one US symbol. The market-hours flag is the point — the response never presents a stale price as live.

- Current price, absolute and percent change, session open/high/low, previous close, and an ISO 8601 quote time
- Pairs `/quote` with `/stock/market-status` (parallel fan-out) to derive `priceIsLive` — `true` only when the US market is open; when closed, `current` is the prior close, surfaced as such
- Market-status failing degrades to `marketOpen: null` rather than tanking the quote
- Unknown US ticker → `symbol_not_found`; international or paid-only symbol → `not_us_or_paid`

---

### `finnhub_get_company`

Full company context for one US symbol in a single call — profile is hollow without the valuation numbers, so this is deliberately one tool over three.

- Profile: name, exchange, industry, country, currency, market cap, shares outstanding, IPO date, website, logo
- Headline fundamentals: P/E (TTM), EPS (TTM), 52-week range, beta, dividend yield, net/gross margin, revenue growth YoY, ROE — every field nullable, surfaced honestly for thinly-covered names rather than zero-filled
- Sector peers from `/stock/peers` (includes the queried symbol)
- Combines three endpoints under a parallel fan-out; metrics or peers failing degrade to a `partial` list, profile drives the not-found / forbidden errors

---

### `finnhub_get_earnings`

Earnings data for one symbol or across the market, selected by `mode`.

- `history` (requires `symbol`): past quarters — actual vs. estimate EPS, absolute surprise, and surprise % (the market-moving signal), newest first
- `calendar` (uses `from` / `to`, defaults to today through +14 days): upcoming releases across the market — date, EPS/revenue estimates, expected report time
- `limit` (1–100, default 50); reports total rows and discloses truncation

---

### `finnhub_get_news`

Financial news for one company or the broad market, selected by `mode`.

- `company` (requires `symbol`): recent articles over a date range (defaults to the last 7 days) — headline, source, ISO 8601 datetime, summary, URL
- `market` (uses `category`): broad headlines by `general`, `forex`, `crypto`, or `merger` (see the `finnhub://news-categories` resource)
- `limit` (1–50, default 15 — news lists run long); articles newest first, with total and truncation disclosure

---

### `finnhub_get_recommendations`

Analyst recommendation consensus for one US symbol — the view to pair with the live quote and fundamentals.

- Per-month strong-buy / buy / hold / sell / strong-sell counts, newest first (typically 12–24 months of history)
- `limit` (1–24, default 12 — one year); reports total months and discloses truncation
- Empty result (no analyst coverage) → `no_coverage`, distinct from an invalid symbol

## Resource

| Type | Name | Description |
|:---|:---|:---|
| Resource | `finnhub://news-categories` | The four valid market-news categories (`general`, `forex`, `crypto`, `merger`) with one-line descriptions. |

The resource is a convenience mirror — its data is fully covered by the `category` enum on `finnhub_get_news`, so tool-only clients lose nothing. Live data (quotes, news, earnings) is intentionally not exposed as a resource: it's time-sensitive, and the value is in the freshness, so it's reachable only through the tools.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Finnhub-specific:

- Single rate-aware Finnhub client — token injected server-side (never a tool input), with timeout and retry calibrated to the 60 req/min free tier
- Live market-status pairing on quotes so a closed-market price is reported as the prior close, never as live
- Status classification at the service boundary: 403 → a clear `not_us_or_paid` domain error, 401 → loud configuration failure at first call (not "no data"), 429/5xx → retried
- `finnhub_get_company` fans out profile + metrics + peers in parallel and degrades to partial results when a leg fails

Agent-friendly output:

- Honest sparsity — every fundamental is nullable and absent values stay null; Finnhub's thinly-covered names are surfaced as-is, never zero-filled or fabricated
- Two distinct "not available" signals — `symbol_not_found` (unknown US ticker, detected from the all-zero quote / empty profile sentinel) vs. `not_us_or_paid` (international or paid-only, HTTP 403) — so an agent can tell them apart and recover
- Typed error contracts with recovery hints on every failure, plus `isLikelyUS` on search results so an agent avoids burning a call on an unreachable symbol
- Capped lists report their total count and disclose truncation, so an agent knows when more data exists

## Getting started

This server requires a free [Finnhub API key](https://finnhub.io/register) (Dashboard → API key). The free tier covers US equities in real time at 60 req/min.

Each user must obtain their own API key. Use is subject to [Finnhub's Terms of Service](https://finnhub.io/terms-of-service) — the free tier is for personal use only, and redistributing or sharing access to Finnhub data with third parties requires written approval from Finnhub.

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "finnhub-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/finnhub-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FINNHUB_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "finnhub-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/finnhub-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FINNHUB_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "finnhub-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "FINNHUB_API_KEY=your-api-key",
        "ghcr.io/cyanheads/finnhub-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 FINNHUB_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- A free [Finnhub API key](https://finnhub.io/register). The free tier is US equities only, real-time, 60 req/min — international symbols (any exchange-suffixed ticker like `.TO` or `.DE`) and candle/forex endpoints are paid-tier and return a clear error.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/finnhub-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd finnhub-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set FINNHUB_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `FINNHUB_API_KEY` | **Required.** Free Finnhub API key from [finnhub.io/register](https://finnhub.io/register). Sent as the `token` query param; the server fails to start without it. | — |
| `FINNHUB_BASE_URL` | Finnhub REST API base URL. Override for local testing or a proxy. | `https://finnhub.io/api/v1` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424: `debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t finnhub-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -e FINNHUB_API_KEY=your-key -p 3010:3010 finnhub-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/finnhub-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits the Finnhub service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools across symbols, quotes, company, earnings, news, and recommendations. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). News-categories reference. |
| `src/services/finnhub` | Finnhub REST client — auth, typed endpoint methods, retry, and HTTP-status classification. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap the Finnhub API: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
