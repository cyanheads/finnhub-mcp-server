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
  instructions:
    'Real-time US-equity market data via Finnhub. Start from a company name: finnhub_search_symbols resolves it to a US ticker, then finnhub_get_quote / _company / _earnings / _news / _recommendations work from that symbol. Free tier is US equities only — international symbols (exchange-suffixed like ".TO") return a clear not_us_or_paid error. Quotes report whether the price is live or the prior close via priceIsLive.',
  setup(core) {
    initFinnhubService(core.config, core.storage);
  },
});
