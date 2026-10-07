# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-10-07

Refresh framework error handling and logging, native Docker builds, bundle exclusions, and MCP Registry launch metadata.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-09-20

HTTP sessions default to stateless via a source-level declaration when MCP_SESSION_MODE is unset; Claude Code and Codex plugin installs now deliver FINNHUB_API_KEY instead of a placeholder; mcp-ts-core bumped to ^0.13.6.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-08-30

Quotes now expose Finnhub session and holiday status; earnings calendars can filter by symbol, and news can return up to 100 fetched articles.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-08-30

Search now identifies US class-share symbols and rejects overlong queries before calling Finnhub; configuration examples explicitly choose stateless HTTP sessions.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-08-21

MCP SDK v2 via @cyanheads/mcp-ts-core ^0.12.3: protocol revision 2026-07-28 served beside 2025-era clients, strict tool inputs, error-envelope output schemas. Missing-symbol errors reclassified ValidationError. Bun 1.4.0 images, supply-chain install guard, TypeScript 7.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Add the package.json mcpName field so the server can publish to the MCP Registry.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-14

Initial release — 6 tools for real-time US-equity market data via Finnhub: symbol search, live quotes with market-status, company context, earnings, news, and analyst recommendations. Requires a free Finnhub API key.
