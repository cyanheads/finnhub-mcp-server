/**
 * @fileoverview finnhub_get_news — financial news in two modes. `company`:
 * recent articles for one symbol over a date range. `market`: broad market
 * headlines by category. Mode-consolidated; both share the article shape.
 * @module mcp-server/tools/definitions/get-news.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { dateWindow } from '@/services/finnhub/date-window.js';
import { getFinnhubService } from '@/services/finnhub/finnhub-service.js';
import { normalizeArticleText } from '@/services/finnhub/normalize-article-text.js';
import type { FinnhubNewsArticle } from '@/services/finnhub/types.js';
import { pageWindow, windowPageEnrichment } from './window-page.js';

function isoTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function articleTie(a: FinnhubNewsArticle, b: FinnhubNewsArticle): number {
  const idOrder = a.id === b.id ? 0 : (a.id ?? Infinity) - (b.id ?? Infinity);
  return (
    idOrder ||
    compareText(a.headline, b.headline) ||
    compareText(a.url, b.url) ||
    compareText(a.source, b.source) ||
    compareText(a.summary ?? '', b.summary ?? '') ||
    compareText(a.category ?? '', b.category ?? '') ||
    compareText(a.related ?? '', b.related ?? '')
  );
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
    headline: normalizeArticleText(a.headline),
    source: a.source,
    datetime: isoTimestamp(a.datetime),
    summary: normalizeArticleText(a.summary ?? ''),
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
      .trim()
      .toUpperCase()
      .optional()
      .describe(
        'Required and nonblank for `company` mode. US ticker, trimmed and uppercased with punctuation preserved. Ignored in `market` mode.',
      ),
    from: z
      .string()
      .optional()
      .describe(
        'Company mode: window start (YYYY-MM-DD). Omitted or empty defaults to today − 7 days in UTC.',
      ),
    to: z
      .string()
      .optional()
      .describe(
        'Company mode: window end (YYYY-MM-DD). Omitted or empty defaults to today in UTC.',
      ),
    category: z
      .enum(['general', 'forex', 'crypto', 'merger'])
      .default('general')
      .describe('Market mode: news category. See finnhub://news-categories.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(15)
      .describe('Max articles (1–100). Default 15 — news lists run long; keep context lean.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Company mode only. Zero-based article offset (default 0). Use nextOffset to continue. Each page refetches Finnhub, so results may shift.',
      ),
  }),
  output: z.object({
    mode: z.enum(['company', 'market']).describe('The mode used (echo of input).'),
    articles: z
      .array(
        z
          .object({
            headline: z.string().describe('Article headline as text.'),
            source: z.string().describe('Publisher name.'),
            datetime: z.string().describe('Publish time, ISO 8601.'),
            summary: z.string().describe('Article summary as text (may be empty).'),
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
    ...windowPageEnrichment,
    totalCount: z.number().describe('Articles fetched from Finnhub before local paging.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when fetched articles remain after this page.'),
    shown: z.number().optional().describe('Number of articles returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Empty-result, upstream coverage, or paging guidance.'),
  },

  errors: [
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A company-news date bound is not a real YYYY-MM-DD calendar date.',
      recovery: 'Use YYYY-MM-DD for a real calendar date.',
      thrownBy: 'service',
    },
    {
      reason: 'inverted_date_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved company-news start date is later than the end date.',
      recovery: 'Choose a start date on or before the end date.',
      thrownBy: 'service',
    },
    {
      reason: 'missing_symbol',
      code: JsonRpcErrorCode.ValidationError,
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
    let page: FinnhubNewsArticle[];
    let total: number;

    if (input.mode === 'company') {
      if (!input.symbol) {
        throw ctx.fail('missing_symbol', undefined, {
          ...ctx.recoveryFor('missing_symbol'),
        });
      }
      const symbol = input.symbol;
      const { from, to } = dateWindow(input, -7, 0);
      let raw: FinnhubNewsArticle[];
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
      const rows = raw.toSorted((a, b) => b.datetime - a.datetime || articleTie(a, b));
      const newest = rows[0];
      const oldest = rows.at(-1);
      page = pageWindow(
        rows,
        input,
        ctx,
        newest && oldest
          ? {
              fetchedFrom: isoTimestamp(oldest.datetime),
              fetchedTo: isoTimestamp(newest.datetime),
              warning:
                'Finnhub may omit articles in the requested window. Try a narrower window or an earlier to date for older articles.',
            }
          : undefined,
      );
      total = rows.length;
    } else {
      const rows = await service.marketNews(input.category, ctx);
      total = rows.length;
      if (total === 0) {
        ctx.enrich.notice(`No articles in the "${input.category}" category right now.`);
      }
      ctx.enrich.total(total);
      page = rows.toSorted((a, b) => b.datetime - a.datetime).slice(0, input.limit);
      if (total > input.limit) ctx.enrich.truncated({ shown: page.length, cap: input.limit });
    }

    ctx.log.info('News fetched', {
      mode: input.mode,
      total,
      returned: page.length,
    });

    return { mode: input.mode, articles: page.map(normalizeArticle) };
  },

  format: (result) => {
    const header = `**${result.mode} news**`;
    if (result.articles.length === 0) {
      return [{ type: 'text', text: `${header}\nNo articles.` }];
    }
    const lines: string[] = [header, ''];
    for (const a of result.articles) {
      const headline = a.headline ? `**${escapeMarkdownInline(a.headline)}** ` : '';
      const tag = a.category ? ` ${escapeMarkdownInline(`[${a.category}]`)}` : '';
      const related = a.related ? ` · related: ${escapeMarkdownInline(a.related)}` : '';
      lines.push(`${headline}— ${escapeMarkdownInline(a.source)}, ${a.datetime}${tag}${related}`);
      if (a.summary) lines.push('', escapeMarkdownInline(a.summary));
      lines.push('', markdownLink(a.url, a.url));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
