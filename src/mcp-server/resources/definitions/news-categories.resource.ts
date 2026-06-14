/**
 * @fileoverview finnhub://news-categories — the four valid market-news
 * categories with one-line descriptions. A static reference an agent reads
 * before calling finnhub_get_news in `market` mode. Bounded (4 entries) and
 * fully mirrored by the `category` enum's describe(), so this is a convenience
 * mirror, not a required path.
 * @module mcp-server/resources/definitions/news-categories.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

/** The four free-tier market-news categories Finnhub's `/news` endpoint accepts. */
const CATEGORIES = [
  { id: 'general', description: 'Top general market and business headlines.' },
  { id: 'forex', description: 'Foreign-exchange and currency market news.' },
  { id: 'crypto', description: 'Cryptocurrency and digital-asset news.' },
  { id: 'merger', description: 'Mergers, acquisitions, and corporate deal news.' },
] as const;

export const newsCategoriesResource = resource('finnhub://news-categories', {
  name: 'finnhub-news-categories',
  description:
    'The four valid market-news categories (general, forex, crypto, merger) with one-line descriptions. Use when selecting the category for finnhub_get_news in market mode.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    categories: z
      .array(
        z
          .object({
            id: z.string().describe('Category value to pass as finnhub_get_news `category`.'),
            description: z.string().describe('What the category covers.'),
          })
          .describe('A single market-news category.'),
      )
      .describe('The four supported market-news categories.'),
  }),

  handler() {
    return { categories: CATEGORIES.map((c) => ({ ...c })) };
  },

  list: () => ({
    resources: [
      {
        uri: 'finnhub://news-categories',
        name: 'finnhub-news-categories',
        mimeType: 'application/json',
      },
    ],
  }),
});
