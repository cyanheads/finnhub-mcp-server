/**
 * @fileoverview finnhub_search_symbols — resolve a company name or partial
 * ticker to Finnhub stock symbols. The entry point the rest of the surface
 * depends on: users say "Microsoft", the other tools need "MSFT".
 * @module mcp-server/tools/definitions/search-symbols.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';

export const searchSymbols = tool('finnhub_search_symbols', {
  description:
    'Resolve a company name or partial ticker to Finnhub stock symbols. The entry point for every other tool — users say "Microsoft", the rest of the surface needs "MSFT". Returns matched symbols with display symbol, description, and security type, best US match first. Each result carries isLikelyUS so an agent can avoid spending a call on an international symbol the free tier cannot reach.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Company name (e.g., "Apple"), partial name ("micro"), or ticker fragment. Finnhub full-text matches across symbols and descriptions. Use this first when you have a company name, not a ticker — the rest of the tools need a symbol.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Max symbols to return (Finnhub often returns 10–50 matches for a common word). Default 10. US Common Stock matches are surfaced first.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            symbol: z
              .string()
              .describe(
                'Finnhub symbol — pass this to finnhub_get_quote / _company / _earnings / _news / _recommendations.',
              ),
            displaySymbol: z
              .string()
              .describe(
                'Human-facing ticker as shown on its exchange (e.g., "AAPL", "603020.SS").',
              ),
            description: z.string().describe('Company / security name.'),
            type: z
              .string()
              .describe(
                'Security type (e.g., "Common Stock", "ETP", "ETF"). Empty string when Finnhub omits it.',
              ),
            isLikelyUS: z
              .boolean()
              .describe(
                'Heuristic: symbol has no exchange suffix (no dot) — i.e., a plain US ticker reachable on the free tier. Suffixed symbols (".SS", ".T", ".L") are international and 403 on quote/profile.',
              ),
          })
          .describe('A single matched symbol.'),
      )
      .describe('Matched symbols, US Common Stock first, then by Finnhub order.'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe('Total matches Finnhub reported (its `count`), before the limit.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more matches existed than the limit returned.'),
    shown: z.number().optional().describe('Number of symbols returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when nothing matched the query.'),
  },

  async handler(input, ctx) {
    const { count, result } = await getFinnhubService().search(input.query, ctx);

    const mapped = result.map((match) => ({
      symbol: match.symbol,
      displaySymbol: match.displaySymbol,
      description: match.description,
      type: match.type,
      isLikelyUS: !match.symbol.includes('.'),
    }));

    /**
     * Stable sort: US Common Stock first, preserving Finnhub's order within
     * each group. The dot-suffix → non-US mapping is how Finnhub namespaces
     * exchanges (honest signal, not a fabricated score).
     */
    const rank = (r: (typeof mapped)[number]): number =>
      r.isLikelyUS && r.type === 'Common Stock' ? 0 : 1;
    const sorted = [...mapped].sort((a, b) => rank(a) - rank(b));

    ctx.enrich.total(count);
    if (count === 0) {
      ctx.enrich.notice(
        `No symbols matched "${input.query}". Try the company's common name or a ticker fragment.`,
      );
    }

    const results = sorted.slice(0, input.limit);
    if (count > input.limit) {
      ctx.enrich.truncated({ shown: results.length, cap: input.limit });
    }

    ctx.log.info('Symbol search complete', {
      query: input.query,
      count,
      returned: results.length,
    });

    return { results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matching symbols.' }];
    }
    const lines = result.results.map((r) => {
      const region = r.isLikelyUS ? 'likely US (free tier)' : 'international';
      const type = r.type || 'Unknown type';
      return `**${r.symbol}** — ${r.description} (${type}, ${region}) · display: ${r.displaySymbol}`;
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
