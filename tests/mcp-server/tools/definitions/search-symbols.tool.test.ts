/**
 * @fileoverview Tests for finnhub_search_symbols.
 * @module tests/mcp-server/tools/definitions/search-symbols.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchSymbols } from '@/mcp-server/tools/definitions/search-symbols.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';

function mockSearch(impl: () => unknown): void {
  vi.spyOn(svc, 'getFinnhubService').mockReturnValue({
    search: vi.fn().mockImplementation(async () => impl()),
  } as unknown as svc.FinnhubService);
}

describe('searchSymbols', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves a company name to symbols, US Common Stock first', async () => {
    mockSearch(() => ({
      count: 3,
      result: [
        // Intl common-stock listed before a US one upstream — must be re-sorted.
        {
          symbol: '603020.SS',
          displaySymbol: '603020.SS',
          description: 'Apple Flavor Group',
          type: 'Common Stock',
        },
        { symbol: 'AAPL', displaySymbol: 'AAPL', description: 'Apple Inc', type: 'Common Stock' },
        { symbol: 'APLE', displaySymbol: 'APLE', description: 'Apple Hospitality', type: 'REIT' },
      ],
    }));
    const ctx = createMockContext();
    const input = searchSymbols.input.parse({ query: 'apple' });
    const result = await searchSymbols.handler(input, ctx);

    // US Common Stock surfaces first; isLikelyUS reflects the dot-suffix heuristic.
    expect(result.results[0]?.symbol).toBe('AAPL');
    expect(result.results[0]?.isLikelyUS).toBe(true);
    const intl = result.results.find((r) => r.symbol === '603020.SS');
    expect(intl?.isLikelyUS).toBe(false);
    expect(getEnrichment(ctx).totalCount).toBe(3);
  });

  it('emits a notice and zero total when nothing matches', async () => {
    mockSearch(() => ({ count: 0, result: [] }));
    const ctx = createMockContext();
    const input = searchSymbols.input.parse({ query: 'zzzznotarealco' });
    const result = await searchSymbols.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrich = getEnrichment(ctx);
    expect(enrich.totalCount).toBe(0);
    expect(enrich.notice).toContain('zzzznotarealco');
  });

  it('discloses truncation when more matches exist than the limit', async () => {
    mockSearch(() => ({
      count: 25,
      result: Array.from({ length: 25 }, (_, i) => ({
        symbol: `SYM${i}`,
        displaySymbol: `SYM${i}`,
        description: `Co ${i}`,
        type: 'Common Stock',
      })),
    }));
    const ctx = createMockContext();
    const input = searchSymbols.input.parse({ query: 'bank', limit: 5 });
    const result = await searchSymbols.handler(input, ctx);

    expect(result.results).toHaveLength(5);
    const enrich = getEnrichment(ctx);
    expect(enrich.totalCount).toBe(25);
    expect(enrich.truncated).toBe(true);
    expect(enrich.shown).toBe(5);
    expect(enrich.cap).toBe(5);
  });

  it('format() renders the symbol, description, and US/international signal', () => {
    const blocks = searchSymbols.format!({
      results: [
        {
          symbol: 'AAPL',
          displaySymbol: 'AAPL',
          description: 'Apple Inc',
          type: 'Common Stock',
          isLikelyUS: true,
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('AAPL');
    expect(text).toContain('Apple Inc');
    expect(text).toContain('likely US');
  });
});
