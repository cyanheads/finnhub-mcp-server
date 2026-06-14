/**
 * @fileoverview finnhub_get_news — financial news in two modes. `company`:
 * recent articles for one symbol over a date range. `market`: broad market
 * headlines by category. Mode-consolidated; both share the article shape.
 * @module mcp-server/tools/definitions/get-news.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';
import type { FinnhubNewsArticle } from '@/services/finnhub/types.js';

/** Format a Date as YYYY-MM-DD (UTC). */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Normalize a raw Finnhub article to the output shape (epoch → ISO). */
function normalizeArticle(a: FinnhubNewsArticle): {
  headline: string;
  source: string;
  datetime: string;
  summary: string;
  url: string;
  category?: string;
  related?: string;
} {
  return {
    headline: a.headline,
    source: a.source,
    datetime: new Date(a.datetime * 1000).toISOString(),
    summary: a.summary ?? '',
    url: a.url,
    ...(a.category ? { category: a.category } : {}),
    ...(a.related ? { related: a.related } : {}),
  };
}

export const getNews = tool('finnhub_get_news', {
  description:
    "Financial news in two modes. 'company': recent articles for one symbol over a date range — headline, source, datetime, summary, URL (\"what's driving AAPL today?\"); requires `symbol`. 'market': broad market headlines by category (general, forex, crypto, merger); uses `category`. Resolve a company name with finnhub_search_symbols first for company mode.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    mode: z
      .enum(['company', 'market'])
      .describe(
        "'company' = recent articles for one symbol over a date range (requires `symbol`). 'market' = broad headlines by `category`.",
      ),
    symbol: z
      .string()
      .optional()
      .describe('Required for `company` mode. US ticker. Ignored in `market` mode.'),
    from: z
      .string()
      .optional()
      .describe('Company mode: window start (YYYY-MM-DD). Defaults to today − 7 days.'),
    to: z.string().optional().describe('Company mode: window end (YYYY-MM-DD). Defaults to today.'),
    category: z
      .enum(['general', 'forex', 'crypto', 'merger'])
      .default('general')
      .describe('Market mode: news category. See finnhub://news-categories.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .describe('Max articles. Default 15 — news lists run long; keep context lean.'),
  }),
  output: z.object({
    mode: z.enum(['company', 'market']).describe('The mode used (echo of input).'),
    articles: z
      .array(
        z
          .object({
            headline: z.string().describe('Article headline.'),
            source: z.string().describe('Publisher name.'),
            datetime: z.string().describe('Publish time, ISO 8601.'),
            summary: z.string().describe('Article summary (may be empty).'),
            url: z.string().describe('Link to the article.'),
            category: z
              .string()
              .optional()
              .describe(
                'Finnhub category tag (market mode). Note: the response category may differ from the requested category (e.g., "business" for a "general" request).',
              ),
            related: z.string().optional().describe('Related symbol(s) Finnhub tagged.'),
          })
          .describe('A single news article.'),
      )
      .describe('Articles, newest first.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total articles available before the limit.'),
    truncated: z.boolean().optional().describe('True when articles were capped at the limit.'),
    shown: z.number().optional().describe('Number of articles returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when no articles were found.'),
  },

  errors: [
    {
      reason: 'missing_symbol',
      code: JsonRpcErrorCode.InvalidParams,
      when: "mode 'company' was requested without a symbol.",
      recovery: 'Provide a `symbol` for company mode, or switch to mode: market with a category.',
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
    let raw: FinnhubNewsArticle[];

    if (input.mode === 'company') {
      if (!input.symbol) {
        throw ctx.fail('missing_symbol', undefined, {
          ...ctx.recoveryFor('missing_symbol'),
        });
      }
      const symbol = input.symbol;
      const today = new Date();
      const from = input.from || isoDate(new Date(today.getTime() - 7 * 86_400_000));
      const to = input.to || isoDate(today);
      try {
        raw = await service.companyNews(symbol, from, to, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.Forbidden) {
          throw ctx.fail('not_us_or_paid', undefined, {
            symbol,
            ...ctx.recoveryFor('not_us_or_paid'),
          });
        }
        throw err;
      }
      if (raw.length === 0) {
        ctx.enrich.notice(
          `No articles for "${symbol}" between ${from} and ${to}. Widen the date range.`,
        );
      }
    } else {
      raw = await service.marketNews(input.category, ctx);
      if (raw.length === 0) {
        ctx.enrich.notice(`No articles in the "${input.category}" category right now.`);
      }
    }

    const articles = raw.map(normalizeArticle).sort((a, b) => b.datetime.localeCompare(a.datetime));

    ctx.enrich.total(articles.length);
    const sliced = articles.slice(0, input.limit);
    if (articles.length > input.limit) {
      ctx.enrich.truncated({ shown: sliced.length, cap: input.limit });
    }

    ctx.log.info('News fetched', {
      mode: input.mode,
      total: articles.length,
      returned: sliced.length,
    });

    return { mode: input.mode, articles: sliced };
  },

  format: (result) => {
    const header = `**${result.mode} news**`;
    if (result.articles.length === 0) {
      return [{ type: 'text', text: `${header}\nNo articles.` }];
    }
    const lines: string[] = [header, ''];
    for (const a of result.articles) {
      const tag = a.category ? ` [${a.category}]` : '';
      const related = a.related ? ` · related: ${a.related}` : '';
      lines.push(`**${a.headline}** — ${a.source}, ${a.datetime}${tag}${related}`);
      if (a.summary) lines.push(a.summary);
      lines.push(a.url);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
