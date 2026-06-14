/**
 * @fileoverview finnhub_get_quote — real-time price quote for one US stock
 * symbol, paired with live market-status so the response states whether the
 * price is live or the prior close. The market-hours flag is the whole reason
 * this is not a one-line curl wrapper.
 * @module mcp-server/tools/definitions/get-quote.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';

export const getQuote = tool('finnhub_get_quote', {
  description:
    'Real-time price quote for one US stock symbol: current, change, %change, open, high, low, previous close. Pairs the quote with live market-status so the response states whether the price is live or the prior close — never implies a stale price is live. Resolve a name to a symbol with finnhub_search_symbols first. International symbols (with an exchange suffix like ".TO") are not on the free tier and return a clear error.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    symbol: z
      .string()
      .min(1)
      .describe(
        'US stock ticker (e.g., "AAPL", "MSFT"). Resolve a company name with finnhub_search_symbols first. International symbols (with an exchange suffix like ".TO") are not on the free tier and return a clear error.',
      ),
  }),
  output: z.object({
    symbol: z.string().describe('The symbol quoted (echo of input).'),
    current: z
      .number()
      .describe(
        'Current price when the market is open; the most recent close when it is not — read `priceIsLive`.',
      ),
    change: z
      .number()
      .nullable()
      .describe('Absolute change vs. previous close. Null when the data is unavailable.'),
    percentChange: z
      .number()
      .nullable()
      .describe('Percent change vs. previous close. Null when unavailable.'),
    high: z.number().describe('Session high.'),
    low: z.number().describe('Session low.'),
    open: z.number().describe('Session open.'),
    previousClose: z.number().describe('Previous trading day close.'),
    quoteTime: z.string().describe('Quote timestamp as ISO 8601.'),
    marketOpen: z
      .boolean()
      .nullable()
      .describe(
        'Whether the US market is currently open. Null when the market-status check failed.',
      ),
    priceIsLive: z
      .boolean()
      .describe(
        'True only when the market is open. When false, `current` is the prior close, not a live price.',
      ),
  }),

  errors: [
    {
      reason: 'symbol_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Quote sentinel detected (c=0, t=0, d=null, dp=null) — unknown US symbol at HTTP 200.',
      recovery:
        'Verify the ticker, or call finnhub_search_symbols to resolve the company name to a valid US symbol.',
    },
    {
      reason: 'not_us_or_paid',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Upstream HTTP 403 — international or paid-only symbol.',
      recovery:
        'This free Finnhub tier covers US stocks only; international symbols require a paid plan. Try the US listing of the company.',
    },
  ],

  async handler(input, ctx) {
    const service = getFinnhubService();
    const [quoteResult, statusResult] = await Promise.allSettled([
      service.quote(input.symbol, ctx),
      service.marketStatus('US', ctx),
    ]);

    if (quoteResult.status === 'rejected') {
      const err = quoteResult.reason;
      if (err instanceof McpError && err.code === JsonRpcErrorCode.Forbidden) {
        throw ctx.fail('not_us_or_paid', undefined, {
          symbol: input.symbol,
          ...ctx.recoveryFor('not_us_or_paid'),
        });
      }
      throw err;
    }

    const quote = quoteResult.value;

    // All-zero sentinel: an unknown US symbol returns {c:0,...,t:0} at HTTP 200.
    // The status code cannot carry this — the payload shape must. d/dp are null
    // in the sentinel, so the check keys on the always-numeric c and t.
    if (quote.c === 0 && quote.t === 0) {
      throw ctx.fail('symbol_not_found', `No quote for symbol "${input.symbol}".`, {
        symbol: input.symbol,
        ...ctx.recoveryFor('symbol_not_found'),
      });
    }

    const marketOpen = statusResult.status === 'fulfilled' ? statusResult.value.isOpen : null;
    const priceIsLive = marketOpen === true;

    if (statusResult.status === 'rejected') {
      ctx.log.warning('Market-status fetch failed; price freshness unknown', {
        symbol: input.symbol,
      });
    }

    return {
      symbol: input.symbol,
      current: quote.c,
      change: quote.d,
      percentChange: quote.dp,
      high: quote.h,
      low: quote.l,
      open: quote.o,
      previousClose: quote.pc,
      quoteTime: new Date(quote.t * 1000).toISOString(),
      marketOpen,
      priceIsLive,
    };
  },

  format: (result) => {
    const arrow =
      result.percentChange == null
        ? ''
        : result.percentChange > 0
          ? '▲'
          : result.percentChange < 0
            ? '▼'
            : '▬';
    const pct =
      result.percentChange == null
        ? 'n/a'
        : `${result.percentChange > 0 ? '+' : ''}${result.percentChange.toFixed(2)}%`;
    const chg = result.change == null ? 'n/a' : result.change.toFixed(2);
    const freshness =
      result.marketOpen == null
        ? 'freshness unknown'
        : result.priceIsLive
          ? 'live'
          : 'prior close — market closed';

    const lines = [
      `**${result.symbol}** $${result.current} ${arrow} ${pct} (${freshness})`,
      `Change: ${chg} | Open: ${result.open} | High: ${result.high} | Low: ${result.low} | Prev close: ${result.previousClose}`,
      `Quote time: ${result.quoteTime}${
        result.marketOpen == null ? '' : ` | Market open: ${result.marketOpen ? 'yes' : 'no'}`
      }`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
