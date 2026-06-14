/**
 * @fileoverview finnhub_get_company — full company context for one US symbol in
 * a single call: profile, headline fundamentals, and sector peers. Combines
 * three endpoints so "tell me about Apple" needs one tool call, not three. The
 * profile is the spine (drives errors); metrics and peers degrade to partial.
 * @module mcp-server/tools/definitions/get-company.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';
import type { FinnhubMetricResponse } from '@/services/finnhub/types.js';

/** Pick a numeric metric, preserving absence as null (never zero-filled). */
function metricNum(metric: FinnhubMetricResponse['metric'], key: string): number | null {
  const value = metric?.[key];
  return typeof value === 'number' ? value : null;
}

export const getCompany = tool('finnhub_get_company', {
  description:
    'Full company context for one US symbol in a single call: profile (name, exchange, industry, country, market cap, shares outstanding, IPO date, website, logo), headline fundamentals (P/E, EPS, 52-week range, beta, dividend yield, margins, growth), and sector peers. Combines three endpoints so "tell me about Apple" needs one tool call, not three. Resolve a company name with finnhub_search_symbols first. International symbols are not on the free tier.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    symbol: z
      .string()
      .min(1)
      .describe(
        'US stock ticker (e.g., "AAPL"). Resolve a company name with finnhub_search_symbols first. International symbols are not on the free tier.',
      ),
  }),
  output: z.object({
    symbol: z.string().describe('The symbol queried (echo of input).'),
    profile: z
      .object({
        name: z.string().describe('Company name.'),
        exchange: z.string().describe('Listing exchange (e.g., "NASDAQ NMS - GLOBAL MARKET").'),
        industry: z.string().describe('Finnhub industry classification.'),
        country: z.string().describe('Country code (e.g., "US").'),
        currency: z.string().describe('Reporting currency.'),
        marketCapitalization: z
          .number()
          .nullable()
          .describe('Market cap in millions of `currency`. Null when omitted.'),
        shareOutstanding: z
          .number()
          .nullable()
          .describe('Shares outstanding in millions. Null when omitted.'),
        ipo: z.string().nullable().describe('IPO date (YYYY-MM-DD). Null when omitted.'),
        weburl: z.string().nullable().describe('Company website. Null when omitted.'),
        logo: z.string().nullable().describe('Logo image URL. Null when omitted.'),
      })
      .describe(
        'Company profile: name, exchange, industry, country, currency, market cap, shares, IPO date, website, and logo.',
      ),
    fundamentals: z
      .object({
        peTTM: z.number().nullable().describe('Price/earnings, trailing twelve months.'),
        epsTTM: z.number().nullable().describe('Earnings per share, TTM.'),
        week52High: z.number().nullable().describe('52-week high price.'),
        week52Low: z.number().nullable().describe('52-week low price.'),
        beta: z.number().nullable().describe('Beta vs. the market.'),
        dividendYieldTTM: z.number().nullable().describe('Current dividend yield %, TTM.'),
        netProfitMarginTTM: z.number().nullable().describe('Net profit margin %, TTM.'),
        grossMarginTTM: z.number().nullable().describe('Gross margin %, TTM.'),
        revenueGrowthTTMYoy: z.number().nullable().describe('Revenue growth % YoY, TTM.'),
        roeTTM: z.number().nullable().describe('Return on equity %, TTM.'),
      })
      .describe(
        'Curated headline fundamentals: P/E, EPS, 52-week range, beta, dividend yield, margins, and growth. Every field nullable — Finnhub omits metrics for thinly-covered names.',
      ),
    peers: z
      .array(z.string())
      .describe('Sector peer symbols from Finnhub (includes the queried symbol). Empty when none.'),
    partial: z
      .array(z.string())
      .optional()
      .describe(
        'Names of the sub-fetches that failed (e.g., ["metrics"]) when the call partially degraded. Absent on a full success.',
      ),
  }),

  errors: [
    {
      reason: 'symbol_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: '/stock/profile2 returned an empty object for the symbol.',
      recovery:
        'Verify the ticker, or call finnhub_search_symbols to resolve the company name first.',
    },
    {
      reason: 'not_us_or_paid',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Upstream HTTP 403 — international or paid-only symbol.',
      recovery:
        "Free tier is US equities only; international symbols need a paid Finnhub plan. Try the company's US listing.",
    },
  ],

  async handler(input, ctx) {
    const service = getFinnhubService();
    const [profileResult, metricsResult, peersResult] = await Promise.allSettled([
      service.profile(input.symbol, ctx),
      service.metrics(input.symbol, ctx),
      service.peers(input.symbol, ctx),
    ]);

    // Profile leg drives errors.
    if (profileResult.status === 'rejected') {
      const err = profileResult.reason;
      if (err instanceof McpError && err.code === JsonRpcErrorCode.Forbidden) {
        throw ctx.fail('not_us_or_paid', undefined, {
          symbol: input.symbol,
          ...ctx.recoveryFor('not_us_or_paid'),
        });
      }
      throw err;
    }

    const rawProfile = profileResult.value;
    // Unknown symbol → empty object. Presence of name/ticker marks a real profile.
    if (!rawProfile.name && !rawProfile.ticker) {
      throw ctx.fail('symbol_not_found', `No profile for symbol "${input.symbol}".`, {
        symbol: input.symbol,
        ...ctx.recoveryFor('symbol_not_found'),
      });
    }

    const partial: string[] = [];
    const metric = metricsResult.status === 'fulfilled' ? metricsResult.value.metric : undefined;
    if (metricsResult.status === 'rejected') partial.push('metrics');
    const peers = peersResult.status === 'fulfilled' ? peersResult.value : [];
    if (peersResult.status === 'rejected') partial.push('peers');

    const profile = {
      name: rawProfile.name ?? '',
      exchange: rawProfile.exchange ?? '',
      industry: rawProfile.finnhubIndustry ?? '',
      country: rawProfile.country ?? '',
      currency: rawProfile.currency ?? '',
      marketCapitalization: rawProfile.marketCapitalization ?? null,
      shareOutstanding: rawProfile.shareOutstanding ?? null,
      ipo: rawProfile.ipo ?? null,
      weburl: rawProfile.weburl ?? null,
      logo: rawProfile.logo ?? null,
    };

    const fundamentals = {
      peTTM: metricNum(metric, 'peTTM'),
      epsTTM: metricNum(metric, 'epsTTM'),
      week52High: metricNum(metric, '52WeekHigh'),
      week52Low: metricNum(metric, '52WeekLow'),
      beta: metricNum(metric, 'beta'),
      dividendYieldTTM: metricNum(metric, 'currentDividendYieldTTM'),
      netProfitMarginTTM: metricNum(metric, 'netProfitMarginTTM'),
      grossMarginTTM: metricNum(metric, 'grossMarginTTM'),
      revenueGrowthTTMYoy: metricNum(metric, 'revenueGrowthTTMYoy'),
      roeTTM: metricNum(metric, 'roeTTM'),
    };

    ctx.log.info('Company context assembled', {
      symbol: input.symbol,
      partial,
    });

    return {
      symbol: input.symbol,
      profile,
      fundamentals,
      peers,
      ...(partial.length > 0 && { partial }),
    };
  },

  format: (result) => {
    const p = result.profile;
    const lines: string[] = [
      `## ${p.name || result.symbol} (${result.symbol})`,
      `**Exchange:** ${p.exchange || 'Not available'} | **Industry:** ${p.industry || 'Not available'} | **Country:** ${p.country || 'Not available'}`,
    ];
    const mcap =
      p.marketCapitalization == null ? 'Not available' : `${p.marketCapitalization}M ${p.currency}`;
    lines.push(
      `**Market cap:** ${mcap} | **Shares out:** ${
        p.shareOutstanding == null ? 'Not available' : `${p.shareOutstanding}M`
      } | **Currency:** ${p.currency || 'Not available'}`,
    );
    lines.push(
      `**IPO:** ${p.ipo ?? 'Not available'} | **Website:** ${p.weburl ?? 'Not available'} | **Logo:** ${p.logo ?? 'Not available'}`,
    );

    const f = result.fundamentals;
    const rows: [string, number | null, string][] = [
      ['P/E (TTM)', f.peTTM, ''],
      ['EPS (TTM)', f.epsTTM, ''],
      ['52-week high', f.week52High, ''],
      ['52-week low', f.week52Low, ''],
      ['Beta', f.beta, ''],
      ['Dividend yield (TTM)', f.dividendYieldTTM, '%'],
      ['Net profit margin (TTM)', f.netProfitMarginTTM, '%'],
      ['Gross margin (TTM)', f.grossMarginTTM, '%'],
      ['Revenue growth YoY (TTM)', f.revenueGrowthTTMYoy, '%'],
      ['Return on equity (TTM)', f.roeTTM, '%'],
    ];
    const present = rows.filter(([, v]) => v != null);
    if (present.length > 0) {
      lines.push('\n**Fundamentals:**');
      for (const [label, value, unit] of present) {
        lines.push(`- ${label}: ${value}${unit}`);
      }
    } else {
      lines.push('\n**Fundamentals:** Not available (thinly covered).');
    }

    lines.push(`\n**Peers:** ${result.peers.length > 0 ? result.peers.join(', ') : 'None'}`);

    if (result.partial && result.partial.length > 0) {
      lines.push(`\n⚠ partial: ${result.partial.join(', ')} unavailable`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
