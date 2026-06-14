/**
 * @fileoverview finnhub_get_earnings — earnings in two modes. `history`: a
 * symbol's past quarters with actual-vs-estimate surprises. `calendar`:
 * market-wide upcoming releases in a date window. Mode-consolidated because both
 * are the same noun (earnings) from two angles.
 * @module mcp-server/tools/definitions/get-earnings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';

/** Format a Date as YYYY-MM-DD (UTC). */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const getEarnings = tool('finnhub_get_earnings', {
  description:
    "Earnings data in two modes. 'history': a symbol's past quarters — actual vs. estimate EPS, surprise %, period (the surprise is the market-moving signal, surfaced prominently); requires `symbol`. 'calendar': upcoming releases across the market in a date window — date, EPS/revenue estimates, symbol; uses `from`/`to`. Resolve a company name with finnhub_search_symbols first for history mode.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    mode: z
      .enum(['history', 'calendar'])
      .describe(
        "'history' = one symbol's past quarters with actual-vs-estimate surprises (requires `symbol`). 'calendar' = market-wide upcoming releases in a date window (uses `from`/`to`).",
      ),
    symbol: z
      .string()
      .optional()
      .describe(
        'Required for `history`. US ticker. Resolve a name with finnhub_search_symbols first. Ignored in `calendar` mode.',
      ),
    from: z
      .string()
      .optional()
      .describe('Calendar mode: window start (YYYY-MM-DD). Defaults to today when omitted.'),
    to: z
      .string()
      .optional()
      .describe(
        'Calendar mode: window end (YYYY-MM-DD). Defaults to today + 14 days when omitted.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Max rows returned (history quarters or calendar entries). Default 50.'),
  }),
  output: z.object({
    mode: z.enum(['history', 'calendar']).describe('The mode used (echo of input).'),
    history: z
      .array(
        z
          .object({
            period: z.string().describe('Fiscal period end (YYYY-MM-DD).'),
            year: z.number().describe('Fiscal year.'),
            quarter: z.number().describe('Fiscal quarter (1–4).'),
            actualEPS: z.number().nullable().describe('Reported EPS. Null if not yet reported.'),
            estimateEPS: z.number().nullable().describe('Consensus estimate EPS.'),
            surprise: z.number().nullable().describe('actual − estimate (absolute).'),
            surprisePercent: z
              .number()
              .nullable()
              .describe(
                'Surprise as % of estimate — the market-moving signal. Positive = beat, negative = miss.',
              ),
          })
          .describe('One past earnings quarter.'),
      )
      .optional()
      .describe('Present in `history` mode. Newest quarter first.'),
    calendar: z
      .array(
        z
          .object({
            symbol: z.string().describe('Stock ticker.'),
            date: z.string().describe('Expected report date (YYYY-MM-DD).'),
            hour: z
              .string()
              .describe('"bmo" (before open) / "amc" (after close) / "" when unknown.'),
            epsEstimate: z
              .number()
              .nullable()
              .describe(
                'Consensus EPS estimate. Null for distant future dates or uncovered symbols.',
              ),
            revenueEstimate: z
              .number()
              .nullable()
              .describe(
                'Consensus revenue estimate in the reporting currency. Null when unavailable.',
              ),
            year: z.number().describe('Fiscal year.'),
            quarter: z.number().describe('Fiscal quarter (1–4).'),
          })
          .describe('One upcoming earnings release.'),
      )
      .optional()
      .describe(
        'Present in `calendar` mode. Sorted by date. Note: `epsActual` and `revenueActual` are not surfaced here — this tool is for the upcoming-releases workflow; actuals are available in `history` mode for a specific symbol.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Total rows available before the limit.'),
    truncated: z.boolean().optional().describe('True when rows were capped at the limit.'),
    shown: z.number().optional().describe('Number of rows returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when the result set is empty.'),
  },

  errors: [
    {
      reason: 'missing_symbol',
      code: JsonRpcErrorCode.InvalidParams,
      when: "mode 'history' was requested without a symbol.",
      recovery:
        'Provide a `symbol` for history mode, or switch to mode: calendar for the market-wide upcoming-releases feed.',
    },
    {
      reason: 'not_us_or_paid',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Upstream HTTP 403 on the symbol.',
      recovery: 'Free tier is US equities only; use a US symbol or a paid plan.',
    },
  ],

  async handler(input, ctx) {
    const service = getFinnhubService();

    if (input.mode === 'history') {
      if (!input.symbol) {
        throw ctx.fail('missing_symbol', undefined, {
          ...ctx.recoveryFor('missing_symbol'),
        });
      }
      const symbol = input.symbol;
      let raw: Awaited<ReturnType<typeof service.earnings>>;
      try {
        raw = await service.earnings(symbol, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.Forbidden) {
          throw ctx.fail('not_us_or_paid', undefined, {
            symbol,
            ...ctx.recoveryFor('not_us_or_paid'),
          });
        }
        throw err;
      }

      const history = raw.map((e) => ({
        period: e.period,
        year: e.year,
        quarter: e.quarter,
        actualEPS: e.actual,
        estimateEPS: e.estimate,
        surprise: e.surprise,
        surprisePercent: e.surprisePercent,
      }));

      ctx.enrich.total(history.length);
      if (history.length === 0) {
        ctx.enrich.notice(
          `No earnings history for "${symbol}". Verify the symbol with finnhub_search_symbols.`,
        );
      }
      const sliced = history.slice(0, input.limit);
      if (history.length > input.limit) {
        ctx.enrich.truncated({ shown: sliced.length, cap: input.limit });
      }

      return { mode: 'history' as const, history: sliced };
    }

    // calendar mode
    const today = new Date();
    const from = input.from || isoDate(today);
    const to = input.to || isoDate(new Date(today.getTime() + 14 * 86_400_000));

    const { earningsCalendar } = await service.earningsCalendar(from, to, ctx);
    const calendar = earningsCalendar
      .map((e) => ({
        symbol: e.symbol,
        date: e.date,
        hour: e.hour,
        epsEstimate: e.epsEstimate,
        revenueEstimate: e.revenueEstimate,
        year: e.year,
        quarter: e.quarter,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    ctx.enrich.total(calendar.length);
    if (calendar.length === 0) {
      ctx.enrich.notice(`No earnings releases between ${from} and ${to}. Widen the date window.`);
    }
    const sliced = calendar.slice(0, input.limit);
    if (calendar.length > input.limit) {
      ctx.enrich.truncated({ shown: sliced.length, cap: input.limit });
    }

    return { mode: 'calendar' as const, calendar: sliced };
  },

  format: (result) => {
    const lines: string[] = [`**Earnings (${result.mode})**`];

    if (result.history) {
      lines.push('**Earnings history** (newest first):');
      for (const q of result.history) {
        const surprise =
          q.surprisePercent == null
            ? 'n/a'
            : `${q.surprisePercent > 0 ? '+' : ''}${q.surprisePercent.toFixed(2)}%`;
        const actual = q.actualEPS == null ? 'n/a' : q.actualEPS;
        const estimate = q.estimateEPS == null ? 'n/a' : q.estimateEPS;
        const abs = q.surprise == null ? 'n/a' : q.surprise;
        lines.push(
          `- ${q.period} (FY${q.year} Q${q.quarter}): actual ${actual} vs est ${estimate} → surprise ${surprise} (${abs} abs)`,
        );
      }
    }

    if (result.calendar) {
      lines.push('**Upcoming earnings** (by date):');
      for (const e of result.calendar) {
        const eps = e.epsEstimate == null ? 'n/a' : e.epsEstimate;
        const rev = e.revenueEstimate == null ? 'n/a' : e.revenueEstimate;
        const hour = e.hour || 'time TBD';
        lines.push(
          `- ${e.date} **${e.symbol}** (FY${e.year} Q${e.quarter}, ${hour}): EPS est ${eps}, revenue est ${rev}`,
        );
      }
    }

    if (lines.length === 0) {
      lines.push('No earnings data.');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
