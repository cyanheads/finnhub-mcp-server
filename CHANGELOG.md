# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-08-30

Search now identifies US class-share symbols and rejects overlong queries before calling Finnhub; configuration examples explicitly choose stateless HTTP sessions.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-08-21

MCP SDK v2 via @cyanheads/mcp-ts-core ^0.12.3: protocol revision 2026-07-28 served beside 2025-era clients, strict tool inputs, error-envelope output schemas. Missing-symbol errors reclassified ValidationError. Bun 1.4.0 images, supply-chain install guard, TypeScript 7.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Add the package.json mcpName field so the server can publish to the MCP Registry.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-14

Initial release — 6 tools for real-time US-equity market data via Finnhub: symbol search, live quotes with market-status, company context, earnings, news, and analyst recommendations. Requires a free Finnhub API key.
