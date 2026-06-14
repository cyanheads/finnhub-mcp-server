/**
 * @fileoverview Tests for finnhub_get_news.
 * @module tests/mcp-server/tools/definitions/get-news.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNews } from '@/mcp-server/tools/definitions/get-news.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';

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

describe('getNews', () => {
  afterEach(() => vi.restoreAllMocks());

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

    const err = await getNews.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('missing_symbol');
  });

  it('company mode re-keys an upstream 403 to not_us_or_paid', async () => {
    mockService({ companyNews: () => forbidden('HTTP 403') });
    const ctx = createMockContext({ errors: getNews.errors });
    const input = getNews.input.parse({ mode: 'company', symbol: 'SHOP.TO' });

    const err = await getNews.handler(input, ctx).catch((e) => e);
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
