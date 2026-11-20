/**
 * @fileoverview finnhub_get_earnings — earnings in two modes. `history`: a
 * symbol's past quarters with actual-vs-estimate surprises. `calendar`:
 * releases in a date window, optionally filtered by symbol.
 * Mode-consolidated because both are the same noun (earnings) from two angles.
 * @module mcp-server/tools/definitions/get-earnings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { dateWindow } from '@/services/finnhub/date-window.js';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';
import { pageWindow, windowPageEnrichment } from './window-page.js';

const CALENDAR_PAGE_LIMIT = 100;
const CALENDAR_UPSTREAM_CAP = 1500;

export const getEarnings = tool('finnhub_get_earnings', {
  description:
    "Earnings data in two modes. 'history': a symbol's past quarters with reported vs. estimated EPS and surprise; requires `symbol`. 'calendar': releases in a date window with EPS and revenue estimates and actuals where Finnhub provides them for recently reported releases. Uses `from`/`to` and optionally filters by `symbol`. Resolve a company name with finnhub_search_symbols first.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    mode: z
      .enum(['history', 'calendar'])
      .describe(
        "'history' = one symbol's past quarters with actual-vs-estimate surprises (requires `symbol`). 'calendar' = releases in a date window, optionally filtered by `symbol` (uses `from`/`to`).",
      ),
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .optional()
      .describe(
        'US ticker, trimmed and uppercased with punctuation preserved. Required and nonblank for `history`; optionally filters `calendar`, where blank means market-wide. Resolve a name with finnhub_search_symbols first.',
      ),
    from: z
      .string()
      .optional()
      .describe(
        'Calendar mode: window start (YYYY-MM-DD). Omitted or empty defaults to today (UTC).',
      ),
    to: z
      .string()
      .optional()
      .describe(
        'Calendar mode: window end (YYYY-MM-DD). Omitted or empty defaults to today + 14 days (UTC).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(50)
      .describe(
        `Max rows returned. Default 50. Calendar mode allows at most ${CALENDAR_PAGE_LIMIT} per page.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Calendar mode: zero-based offset in fetched rows. Omitted starts at the first row.',
      ),
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
            date: z.string().describe('Report date (YYYY-MM-DD).'),
            hour: z
              .string()
              .describe(
                '"bmo" (before open) / "amc" (after close) / "dmh" (during market hours) / "" when unknown.',
              ),
            epsActual: z.number().nullable().describe('Reported EPS. Null when unavailable.'),
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
            revenueActual: z
              .number()
              .nullable()
              .describe('Reported revenue in the reporting currency. Null when unavailable.'),
            year: z.number().describe('Fiscal year.'),
            quarter: z.number().describe('Fiscal quarter (1–4).'),
          })
          .describe('One earnings release.'),
      )
      .optional()
      .describe(
        'Present in `calendar` mode, sorted by date then symbol. Actuals can be available for recently reported releases.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Number of rows fetched from Finnhub before local paging.'),
    truncated: z.boolean().optional().describe('True when rows were capped at the limit.'),
    shown: z.number().optional().describe('Number of rows returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance about empty windows, coverage, or continuation.'),
    ...windowPageEnrichment,
  },

  errors: [
    {
      reason: 'missing_symbol',
      code: JsonRpcErrorCode.ValidationError,
      when: "mode 'history' was requested without a symbol.",
      recovery:
        'Provide a `symbol` for history mode, or switch to calendar mode for market-wide releases.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A calendar bound is not a real YYYY-MM-DD date.',
      recovery: 'Use YYYY-MM-DD for a real calendar date.',
      thrownBy: 'service',
    },
    {
      reason: 'inverted_date_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved calendar start date is later than the end date.',
      recovery: 'Choose a start date on or before the end date.',
      thrownBy: 'service',
    },
    {
      reason: 'calendar_limit_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: `Calendar mode requested more than ${CALENDAR_PAGE_LIMIT} rows per page.`,
      recovery: `Use a limit of ${CALENDAR_PAGE_LIMIT} or less and continue with nextOffset.`,
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
          `No earnings history for "${symbol}". Verify the ticker with finnhub_search_symbols. ETFs, funds, or trusts may lack earnings history; try finnhub_get_quote for price data.`,
        );
      }
      const sliced = history.slice(0, input.limit);
      if (history.length > input.limit) {
        ctx.enrich.truncated({ shown: sliced.length, cap: input.limit });
      }

      return { mode: 'history' as const, history: sliced };
    }

    if (input.limit > CALENDAR_PAGE_LIMIT) {
      throw ctx.fail('calendar_limit_exceeded');
    }
    const { from, to } = dateWindow(input, 0, 14);
    const symbol = input.symbol || undefined;

    let raw: Awaited<ReturnType<typeof service.earningsCalendar>>;
    try {
      raw = await service.earningsCalendar(from, to, symbol, ctx);
    } catch (err) {
      if (symbol && err instanceof McpError && err.code === JsonRpcErrorCode.Forbidden) {
        throw ctx.fail('not_us_or_paid', undefined, {
          symbol,
          ...ctx.recoveryFor('not_us_or_paid'),
        });
      }
      throw err;
    }

    const { earningsCalendar } = raw;
    const calendar = earningsCalendar
      .map((e) => ({
        symbol: e.symbol,
        date: e.date,
        hour: e.hour,
        epsActual: e.epsActual ?? null,
        epsEstimate: e.epsEstimate,
        revenueEstimate: e.revenueEstimate,
        revenueActual: e.revenueActual ?? null,
        year: e.year,
        quarter: e.quarter,
      }))
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.symbol.localeCompare(b.symbol) ||
          a.year - b.year ||
          a.quarter - b.quarter ||
          a.hour.localeCompare(b.hour) ||
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );

    const first = calendar[0];
    const last = calendar.at(-1);
    if (!first || !last) {
      ctx.enrich.notice(
        symbol
          ? `No earnings releases for "${symbol}" between ${from} and ${to}. Widen the date window.`
          : `No earnings releases between ${from} and ${to}. Widen the date window.`,
      );
    }
    const page = pageWindow(
      calendar,
      input,
      ctx,
      first && last
        ? {
            fetchedFrom: first.date,
            fetchedTo: last.date,
            ...(calendar.length >= CALENDAR_UPSTREAM_CAP && {
              warning:
                'The upstream calendar reached its row ceiling and may omit releases. Narrow the window or move to an earlier end date to look for older rows.',
            }),
          }
        : undefined,
    );

    return { mode: 'calendar' as const, calendar: page };
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
        const actual = q.actualEPS ?? 'n/a';
        const estimate = q.estimateEPS ?? 'n/a';
        const abs = q.surprise ?? 'n/a';
        lines.push(
          `- ${q.period} (FY${q.year} Q${q.quarter}): actual ${actual} vs est ${estimate} → surprise ${surprise} (${abs} abs)`,
        );
      }
    }

    if (result.calendar) {
      lines.push('**Earnings calendar** (by date):');
      for (const e of result.calendar) {
        const eps = e.epsEstimate ?? 'n/a';
        const rev = e.revenueEstimate ?? 'n/a';
        const hour = e.hour || 'time TBD';
        lines.push(
          `- ${e.date} **${e.symbol}** (FY${e.year} Q${e.quarter}, ${hour}): EPS est ${eps}, revenue est ${rev}, EPS actual ${e.epsActual ?? 'n/a'}, revenue actual ${e.revenueActual ?? 'n/a'}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
