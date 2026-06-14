/**
 * @fileoverview Barrel collecting all tool definitions into `allToolDefinitions`
 * for `createApp()`.
 * @module mcp-server/tools/definitions/index
 */

import { getCompany } from './get-company.tool.js';
import { getEarnings } from './get-earnings.tool.js';
import { getNews } from './get-news.tool.js';
import { getQuote } from './get-quote.tool.js';
import { getRecommendations } from './get-recommendations.tool.js';
import { searchSymbols } from './search-symbols.tool.js';

export const allToolDefinitions = [
  searchSymbols,
  getQuote,
  getCompany,
  getEarnings,
  getNews,
  getRecommendations,
];
