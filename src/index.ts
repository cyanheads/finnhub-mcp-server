#!/usr/bin/env node
/**
 * @fileoverview finnhub-mcp-server MCP server entry point. Wires the Finnhub
 * service into `setup()` and registers the tool + resource surface.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initFinnhubService } from './services/finnhub/finnhub-service.js';

await createApp({
  name: 'finnhub-mcp-server',
  title: 'finnhub-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  skills: 'skills',
  /**
   * Every tool here is a single-shot read against Finnhub — nothing calls
   * `ctx.requestInput`, so no HTTP caller needs a live session. Declaring the
   * posture in source makes it independent of the launch environment; an
   * explicit `MCP_SESSION_MODE` still wins.
   */
  sessionMode: 'stateless',
  instructions:
    'US-equity market data and financial news via Finnhub. Resolve an unfamiliar company name with finnhub_search_symbols, then pass the returned symbol to finnhub_get_quote / _company / _earnings / _news / _recommendations. Endpoint coverage varies by instrument and plan; not_us_or_paid indicates access restrictions. Read quoteTime together with priceIsLive and market-status fields when describing price freshness.',
  setup(core) {
    initFinnhubService(core.config, core.storage);
  },
});
