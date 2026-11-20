/**
 * @fileoverview Tests for finnhub_get_news.
 * @module tests/mcp-server/tools/definitions/get-news.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HtmlRenderer, Parser } from 'commonmark';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNews } from '@/mcp-server/tools/definitions/get-news.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';
import type { FinnhubNewsArticle } from '@/services/finnhub/types.js';

interface Mocks {
  companyNews?: () => unknown;
  marketNews?: () => unknown;
}

function mockService(mocks: Mocks): void {
  const wrap = (fn?: () => unknown) =>
    vi.fn().mockImplementation(async () => {
      const v = fn?.();
      if (v instanceof Error) throw v;
      return v;
    });
  vi.spyOn(svc, 'getFinnhubService').mockReturnValue({
    companyNews: wrap(mocks.companyNews),
    marketNews: wrap(mocks.marketNews),
  } as unknown as svc.FinnhubService);
}

function wireText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function article(overrides: Partial<FinnhubNewsArticle> = {}): FinnhubNewsArticle {
  return {
    headline: 'Headline',
    datetime: 1_781_365_360,
    source: 'News * Desk',
    url: 'https://example.com/article?a=1&b=2',
    ...overrides,
  };
}

describe('getNews', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('normalizes the symbol in forbidden company-news errors', async () => {
    mockService({ companyNews: () => forbidden('HTTP 403') });
    const result = await runToolContract(getNews, { mode: 'company', symbol: ' shop.to ' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'not_us_or_paid', symbol: 'SHOP.TO' },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('paid plan') }),
      ]),
    );
  });

  it('normalizes company-news requests and empty guidance on both surfaces', async () => {
    mockService({ companyNews: () => [] });
    const result = await runToolContract(getNews, {
      mode: 'company',
      symbol: ' aapl ',
      from: '2030-01-01',
      to: '2030-01-02',
    });
    expect(svc.getFinnhubService().companyNews).toHaveBeenCalledWith(
      'AAPL',
      '2030-01-01',
      '2030-01-02',
      expect.anything(),
    );
    const notice =
      'No articles for "AAPL" between 2030-01-01 and 2030-01-02. Widen the date range.';
    expect(result.structuredContent).toMatchObject({ articles: [], totalCount: 0, notice });
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(notice) })]),
    );
  });

  it('rejects whitespace-only company symbols before any request', async () => {
    mockService({ companyNews: () => [] });
    const result = await runToolContract(getNews, { mode: 'company', symbol: ' \t ' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'missing_symbol' } },
    });
    expect(svc.getFinnhubService().companyNews).not.toHaveBeenCalled();
  });

  it('ignores symbol in market mode', async () => {
    mockService({ marketNews: () => [] });
    const result = await runToolContract(getNews, { mode: 'market', symbol: ' aapl ' });
    expect(result.structuredContent).toMatchObject({ mode: 'market', articles: [], totalCount: 0 });
    expect(svc.getFinnhubService().marketNews).toHaveBeenCalledWith('general', expect.anything());
    expect(svc.getFinnhubService().companyNews).not.toHaveBeenCalled();
  });

  it('keeps unused market dates and single-line plaintext compatible', async () => {
    mockService({
      marketNews: () => [
        {
          headline: 'Plain financial news',
          datetime: 1_780_000_000,
          source: 'Reuters',
          summary: '0 < x > 1 in the example.',
          url: 'https://example.com/comparison',
        },
      ],
    });
    const result = await runToolContract(getNews, {
      mode: 'market',
      from: 'last week',
      to: 'invalid',
    });
    expect(result.structuredContent).toMatchObject({
      articles: [{ headline: 'Plain financial news', summary: '0 < x > 1 in the example.' }],
      totalCount: 1,
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('0 < x > 1 in the example.'),
    });
  });

  it.each(['company', 'market'] as const)(
    'normalizes rich %s headline and summary with CommonMark round-trip parity',
    async (mode) => {
      const headline = 'Nvidia’s *results* & <watch>';
      const summary = '0 < x > 1 & 4\n\nFirst one\nSecond <b>\n\n> Last #';
      const row = article({
        headline: '<strong>Nvidia&#8217;s *results*</strong> &amp; &lt;watch&gt;',
        summary:
          '<p>0 < x > 1 &amp; &#x34;</p><ul><li>First <em><strong>one</strong></em></li><li>Second &lt;b&gt;</li></ul><p>&gt; Last #</p>',
        category: 'research',
        related: 'BRK.B',
      });
      mockService({
        companyNews: () => [
          row,
          article({ headline: 'Empty summary', datetime: row.datetime - 1 }),
        ],
        marketNews: () => [row, article({ headline: 'Empty summary', datetime: row.datetime - 1 })],
      });
      const result = await runToolContract(getNews, { mode, symbol: 'NVDA' });
      expect(result.structuredContent).toMatchObject({
        mode,
        articles: [
          {
            headline,
            summary,
            url: row.url,
            source: row.source,
            category: 'research',
            related: 'BRK.B',
          },
          { headline: 'Empty summary', summary: '' },
        ],
      });
      const ast = new Parser().parse(wireText(result));
      const walker = ast.walker();
      const parts: string[] = [];
      const destinations: string[] = [];
      for (let event = walker.next(); event; event = walker.next()) {
        if (event.node.type === 'paragraph' && !event.entering) parts.push('\n\n');
        if (!event.entering) continue;
        if (event.node.type === 'text' && event.node.literal) parts.push(event.node.literal);
        if (event.node.type === 'linebreak' || event.node.type === 'softbreak') parts.push('\n');
        if (event.node.type === 'link' && event.node.destination)
          destinations.push(event.node.destination);
      }
      expect(parts.join('')).toContain(headline);
      expect(parts.join('')).toContain(summary);
      expect(parts.join('')).toContain(row.source);
      expect(destinations).toContain(row.url);
    },
  );

  it('preserves a compact comparison at the end of a mixed-markup summary', async () => {
    mockService({ marketNews: () => [article({ summary: '<b>Compare</b> x<y' })] });
    const result = await runToolContract(getNews, { mode: 'market' });
    expect(result.structuredContent).toMatchObject({ articles: [{ summary: 'Compare x<y' }] });
    const html = new HtmlRenderer().render(new Parser().parse(wireText(result)));
    expect(html).toContain('<p>Compare x&lt;y</p>');
  });

  it('normalizes CRLF and CR to the line breaks CommonMark reads', async () => {
    mockService({
      marketNews: () => [article({ headline: 'First\r\nSecond', summary: 'A\r\nB\rC' })],
    });
    const result = await runToolContract(getNews, { mode: 'market' });
    expect(result.structuredContent).toMatchObject({
      articles: [{ headline: 'First\nSecond', summary: 'A\nB\nC' }],
    });
    const html = new HtmlRenderer().render(new Parser().parse(wireText(result)));
    expect(html).toContain('<strong>First<br />\nSecond</strong>');
    expect(html).toContain('<p>A<br />\nB<br />\nC</p>');
  });

  it('preserves compact comparisons beside entities and nested HTML', async () => {
    mockService({
      marketNews: () => [
        article({
          headline: 'ABC &amp; x<y>z',
          summary: '<p>x<b>bold</b>z &amp; x<y>z and x<q>quote</q>z</p>',
        }),
      ],
    });
    const result = await runToolContract(getNews, { mode: 'market' });
    expect(result.structuredContent).toMatchObject({
      articles: [{ headline: 'ABC & x<y>z', summary: 'xboldz & x<y>z and xquotez' }],
    });
    const html = new HtmlRenderer().render(new Parser().parse(wireText(result)));
    expect(html).toContain('<strong>ABC &amp; x&lt;y&gt;z</strong>');
    expect(html).toContain('<p>xboldz &amp; x&lt;y&gt;z and xquotez</p>');
  });

  it('reports observed company coverage below the upstream ceiling and beyond the local page', async () => {
    mockService({
      companyNews: () => [
        article({ datetime: Date.parse('2026-11-18T13:00:00Z') / 1000 }),
        article({ datetime: Date.parse('2026-11-19T19:00:00Z') / 1000 }),
      ],
    });
    const page = await runToolContract(getNews, { mode: 'company', symbol: 'NVDA', limit: 1 });
    expect(page.structuredContent).toMatchObject({
      totalCount: 2,
      fetchedFrom: '2026-11-18T13:00:00.000Z',
      fetchedTo: '2026-11-19T19:00:00.000Z',
      nextOffset: 1,
      notice: expect.stringMatching(/narrower|earlier/i),
    });
    expect(wireText(page)).toContain('2026-11-18T13:00:00.000Z');
    expect(wireText(page)).toContain('2026-11-19T19:00:00.000Z');
    expect(wireText(page)).toMatch(/offset.*1/i);
    expect(wireText(page)).toMatch(/narrower|earlier/i);
  });

  it('pages through timestamp ties above the cap over reshuffled refetches', async () => {
    const rows = Array.from({ length: 102 }, (_, index) =>
      article({ id: index, headline: String(index) }),
    );
    rows.push(article({ headline: 'Fallback B' }), article({ headline: 'Fallback A' }));
    let calls = 0;
    mockService({ companyNews: () => (calls++ % 2 ? Array.from(rows).reverse() : rows) });
    async function getPage(offset: number, limit: number) {
      return runToolContract(getNews, { mode: 'company', symbol: 'NVDA', limit, offset });
    }
    const first = await getPage(0, 100);
    const second = await getPage(100, 2);
    const last = await getPage(102, 2);
    const atEnd = await getPage(104, 100);
    const pastEnd = await getPage(105, 100);
    expect(first.structuredContent).toMatchObject({
      totalCount: 104,
      nextOffset: 100,
      shown: 100,
      cap: 100,
      truncated: true,
    });
    expect(second.structuredContent).toMatchObject({
      totalCount: 104,
      nextOffset: 102,
      articles: [{ headline: '100' }, { headline: '101' }],
    });
    expect(last.structuredContent).toMatchObject({
      totalCount: 104,
      articles: [{ headline: 'Fallback A' }, { headline: 'Fallback B' }],
    });
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
    for (const page of [atEnd, pastEnd]) {
      expect(page.structuredContent).toMatchObject({ articles: [], totalCount: 104 });
      expect(page.structuredContent).not.toHaveProperty('nextOffset');
      expect(wireText(page)).not.toMatch(/widen the date range|next offset/i);
    }
    expect(wireText(first)).toMatch(/offset.*100/i);
    expect(wireText(second)).toMatch(/offset.*102/i);
    expect(wireText(last)).toContain('Fallback B');
    const articles = [first, second, last].flatMap((page) => {
      const data = getNews.output.parse(page.structuredContent);
      return data.articles.map(({ headline }) => headline);
    });
    expect(articles).toEqual([
      ...Array.from({ length: 102 }, (_, i) => String(i)),
      'Fallback A',
      'Fallback B',
    ]);
    expect(svc.getFinnhubService().companyNews).toHaveBeenCalledTimes(5);
  });

  it.each([-1, 1.5])('rejects offset %s without fetching', async (offset) => {
    mockService({ companyNews: () => [] });
    const result = await runToolContract(getNews, { mode: 'company', symbol: 'NVDA', offset });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { issues: [expect.objectContaining({ path: ['offset'] })] } },
    });
    expect(wireText(result)).toContain('offset');
    expect(svc.getFinnhubService().companyNews).not.toHaveBeenCalled();
  });

  it.each([
    [
      { from: 'last week', to: '2026-11-17' },
      { reason: 'invalid_date', field: 'from', value: 'last week' },
    ],
    [
      { from: '2025-02-29', to: '2026-11-17' },
      { reason: 'invalid_date', field: 'from', value: '2025-02-29' },
    ],
    [
      { from: '2026-11-22', to: '2026-11-17' },
      { reason: 'inverted_date_window', from: '2026-11-22', to: '2026-11-17' },
    ],
    [
      { from: '2030-11-22', to: '' },
      { reason: 'inverted_date_window', from: '2030-11-22', to: '2026-11-20' },
    ],
  ] as const)('rejects invalid company date window %j before fetching', async (window, details) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T03:00:00Z'));
    mockService({ companyNews: () => [] });
    const result = await runToolContract(getNews, { mode: 'company', symbol: 'NVDA', ...window });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { ...details, recovery: { hint: expect.any(String) } },
      },
    });
    expect(wireText(result)).toContain(details.reason);
    expect(wireText(result)).toMatch(/YYYY-MM-DD|on or before/i);
    expect(svc.getFinnhubService().companyNews).not.toHaveBeenCalled();
  });

  it('allows leap-day same-day windows and leaves empty bounds absent', async () => {
    mockService({ companyNews: () => [] });
    const result = await runToolContract(getNews, {
      mode: 'company',
      symbol: 'NVDA',
      from: '2024-02-29',
      to: '2024-02-29',
    });
    expect(svc.getFinnhubService().companyNews).toHaveBeenCalledWith(
      'NVDA',
      '2024-02-29',
      '2024-02-29',
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ articles: [], totalCount: 0 });
    expect(result.structuredContent).not.toHaveProperty('fetchedFrom');
    expect(result.structuredContent).not.toHaveProperty('fetchedTo');
    expect(wireText(result)).toContain('Widen the date range');
  });

  it('company mode: returns articles newest-first with epoch→ISO datetime', async () => {
    mockService({
      companyNews: () => [
        {
          category: 'company',
          datetime: 1781000000,
          headline: 'Older',
          source: 'Yahoo',
          summary: '',
          url: 'https://a',
          related: 'AAPL',
        },
        {
          category: 'company',
          datetime: 1781365360,
          headline: 'Newer',
          source: 'Reuters',
          summary: 'sum',
          url: 'https://b',
          related: 'AAPL',
        },
      ],
    });
    const ctx = createMockContext({ errors: getNews.errors });
    const input = getNews.input.parse({ mode: 'company', symbol: 'AAPL' });
    const result = await getNews.handler(input, ctx);

    expect(result.mode).toBe('company');
    expect(result.articles[0]?.headline).toBe('Newer');
    expect(result.articles[0]?.datetime).toBe(new Date(1781365360 * 1000).toISOString());
  });

  it('company mode without a symbol throws missing_symbol', async () => {
    mockService({});
    const ctx = createMockContext({ errors: getNews.errors });
    const input = getNews.input.parse({ mode: 'company' });

    const err = await Promise.resolve(getNews.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('missing_symbol');
  });

  it('company mode re-keys an upstream 403 to not_us_or_paid', async () => {
    mockService({ companyNews: () => forbidden('HTTP 403') });
    const ctx = createMockContext({ errors: getNews.errors });
    const input = getNews.input.parse({ mode: 'company', symbol: 'SHOP.TO' });

    const err = await Promise.resolve(getNews.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data.reason).toBe('not_us_or_paid');
  });

  it('market mode: surfaces the response category tag even when it differs from the request', async () => {
    // Observed quirk: a "general" request returns articles tagged "business".
    mockService({
      marketNews: () => [
        {
          category: 'business',
          datetime: 1781365360,
          headline: 'Markets rally',
          source: 'CNBC',
          summary: '',
          url: 'https://m',
        },
      ],
    });
    const ctx = createMockContext({ errors: getNews.errors });
    const input = getNews.input.parse({ mode: 'market', category: 'general' });
    const result = await getNews.handler(input, ctx);

    expect(result.mode).toBe('market');
    expect(result.articles[0]?.category).toBe('business');
  });

  it('emits a notice when no articles are found', async () => {
    mockService({ marketNews: () => [] });
    const ctx = createMockContext({ errors: getNews.errors });
    const input = getNews.input.parse({ mode: 'market', category: 'crypto' });
    const result = await getNews.handler(input, ctx);

    expect(result.articles).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('crypto');
  });

  it('defaults to 15 articles and preserves total/truncation enrichment', async () => {
    mockService({
      marketNews: () =>
        Array.from({ length: 16 }, (_, index) => ({
          datetime: 1_780_000_000 + index,
          headline: `Headline ${index + 1}`,
          source: 'Reuters',
          summary: '',
          url: `https://example.com/${index + 1}`,
        })),
    });
    const ctx = createMockContext({ errors: getNews.errors });

    const result = await getNews.handler(getNews.input.parse({ mode: 'market' }), ctx);

    expect(result.articles).toHaveLength(15);
    expect(getEnrichment(ctx)).toMatchObject({
      totalCount: 16,
      truncated: true,
      shown: 15,
      cap: 15,
    });
  });

  it('returns and formats all 100 articles at the shared cap', async () => {
    mockService({
      marketNews: () =>
        Array.from({ length: 100 }, (_, index) => ({
          datetime: 1_780_000_000 + index,
          headline: `Headline ${index + 1}`,
          source: 'Reuters',
          summary: `Summary ${index + 1}`,
          url: `https://example.com/${index + 1}`,
        })),
    });
    const ctx = createMockContext({ errors: getNews.errors });

    const result = await getNews.handler(
      getNews.input.parse({ mode: 'market', category: 'general', limit: 100 }),
      ctx,
    );

    expect(result.articles).toHaveLength(100);
    expect(getEnrichment(ctx)).toEqual({ totalCount: 100 });
    const last = result.articles.at(-1);
    expect(last).toBeDefined();
    const text = getNews.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain(last?.headline);
    expect(text).toContain(last?.url);
  });

  it('preserves truncation metadata for a smaller explicit limit', async () => {
    mockService({
      marketNews: () =>
        Array.from({ length: 3 }, (_, index) => ({
          datetime: 1_780_000_000 + index,
          headline: `Headline ${index + 1}`,
          source: 'Reuters',
          summary: '',
          url: `https://example.com/${index + 1}`,
        })),
    });
    const ctx = createMockContext({ errors: getNews.errors });

    const result = await getNews.handler(getNews.input.parse({ mode: 'market', limit: 2 }), ctx);

    expect(result.articles).toHaveLength(2);
    expect(getEnrichment(ctx)).toMatchObject({
      totalCount: 3,
      truncated: true,
      shown: 2,
      cap: 2,
    });
  });

  it('rejects a limit above the shared 100-article cap', () => {
    expect(() => getNews.input.parse({ mode: 'market', limit: 101 })).toThrow();
  });

  it('format() renders the headline, source, and URL', () => {
    const blocks = getNews.format!({
      mode: 'company',
      articles: [
        {
          headline: 'Big news',
          source: 'Reuters',
          datetime: '2026-06-12T00:00:00.000Z',
          summary: 'detail',
          url: 'https://x',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Big news');
    expect(text).toContain('Reuters');
    expect(text).toContain('https://x');
  });
});
