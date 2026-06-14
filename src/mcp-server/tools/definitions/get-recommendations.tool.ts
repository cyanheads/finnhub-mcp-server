/**
 * @fileoverview finnhub_get_recommendations — analyst recommendation trends for
 * one US symbol: strong-buy / buy / hold / sell / strong-sell counts per month,
 * newest first. The consensus view to pair with the live quote and fundamentals.
 * @module mcp-server/tools/definitions/get-recommendations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';

export const getRecommendations = tool('finnhub_get_recommendations', {
  description:
    'Analyst recommendation trends for one US symbol: strong-buy / buy / hold / sell / strong-sell counts per month, newest first. The consensus view to pair with the live quote and fundamentals from finnhub_get_company. Resolve a company name with finnhub_search_symbols first.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    symbol: z
      .string()
      .min(1)
      .describe(
        'US stock ticker (e.g., "AAPL"). Resolve a name with finnhub_search_symbols first.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(24)
      .default(12)
      .describe(
        'Max months to return, newest first. Default 12 (one year of consensus history). The API typically returns 12–24 months; setting this higher surfaces older trend data.',
      ),
  }),
  output: z.object({
    symbol: z.string().describe('The symbol queried (echo of input).'),
    trends: z
      .array(
        z
          .object({
            period: z.string().describe('Month the consensus is for (YYYY-MM-DD, first of month).'),
            strongBuy: z
              .number()
              .describe('Number of analysts with a Strong Buy rating this month.'),
            buy: z.number().describe('Number of analysts with a Buy rating this month.'),
            hold: z.number().describe('Number of analysts with a Hold rating this month.'),
            sell: z.number().describe('Number of analysts with a Sell rating this month.'),
            strongSell: z
              .number()
              .describe('Number of analysts with a Strong Sell rating this month.'),
          })
          .describe('One month of analyst recommendation counts.'),
      )
      .describe(
        'Recommendation counts per month, newest first. Typically 12–24 months of history.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Total months available before the limit.'),
    truncated: z.boolean().optional().describe('True when months were capped at the limit.'),
    shown: z.number().optional().describe('Number of months returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
  },

  errors: [
    {
      reason: 'no_coverage',
      code: JsonRpcErrorCode.NotFound,
      when: 'Endpoint returned an empty array — no analyst coverage for the symbol.',
      recovery:
        'Verify the symbol is valid with finnhub_search_symbols; some thinly-traded or newly-listed stocks have no analyst coverage on Finnhub.',
    },
    {
      reason: 'not_us_or_paid',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Upstream HTTP 403 — international or paid-only symbol.',
      recovery: 'Free tier is US equities only; use a US symbol or a paid plan.',
    },
  ],

  async handler(input, ctx) {
    const service = getFinnhubService();
    let raw: Awaited<ReturnType<typeof service.recommendations>>;
    try {
      raw = await service.recommendations(input.symbol, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.Forbidden) {
        throw ctx.fail('not_us_or_paid', undefined, {
          symbol: input.symbol,
          ...ctx.recoveryFor('not_us_or_paid'),
        });
      }
      throw err;
    }

    if (raw.length === 0) {
      throw ctx.fail('no_coverage', `No analyst coverage for "${input.symbol}".`, {
        symbol: input.symbol,
        ...ctx.recoveryFor('no_coverage'),
      });
    }

    const sorted = [...raw].sort((a, b) => b.period.localeCompare(a.period));
    const trends = sorted.map((r) => ({
      period: r.period,
      strongBuy: r.strongBuy,
      buy: r.buy,
      hold: r.hold,
      sell: r.sell,
      strongSell: r.strongSell,
    }));

    ctx.enrich.total(trends.length);
    const sliced = trends.slice(0, input.limit);
    if (trends.length > input.limit) {
      ctx.enrich.truncated({ shown: sliced.length, cap: input.limit });
    }

    return { symbol: input.symbol, trends: sliced };
  },

  format: (result) => {
    const lines = [`**${result.symbol}** analyst recommendations (newest first):`];
    for (const t of result.trends) {
      lines.push(
        `- ${t.period}: ${t.strongBuy} strong-buy / ${t.buy} buy / ${t.hold} hold / ${t.sell} sell / ${t.strongSell} strong-sell`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
