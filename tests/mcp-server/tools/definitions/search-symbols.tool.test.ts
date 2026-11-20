/**
 * @fileoverview Tests for finnhub_search_symbols.
 * @module tests/mcp-server/tools/definitions/search-symbols.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('resolves a company name to symbols, likely-US Common Stock first', async () => {
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

    // Likely-US Common Stock surfaces first; isLikelyUS reflects the symbol heuristic.
    expect(result.results[0]?.symbol).toBe('AAPL');
    expect(result.results[0]?.isLikelyUS).toBe(true);
    const intl = result.results.find((r) => r.symbol === '603020.SS');
    expect(intl?.isLikelyUS).toBe(false);
    expect(getEnrichment(ctx).totalCount).toBe(3);
  });

  it('preserves Finnhub order within each result rank', async () => {
    mockSearch(() => ({
      count: 4,
      result: [
        { symbol: 'FIRST.L', displaySymbol: 'FIRST.L', description: 'First', type: 'REIT' },
        { symbol: 'MSFT', displaySymbol: 'MSFT', description: 'Microsoft', type: 'Common Stock' },
        { symbol: 'AAPL', displaySymbol: 'AAPL', description: 'Apple', type: 'Common Stock' },
        { symbol: 'SECOND.L', displaySymbol: 'SECOND.L', description: 'Second', type: 'REIT' },
      ],
    }));

    const result = await searchSymbols.handler(
      searchSymbols.input.parse({ query: 'technology' }),
      createMockContext(),
    );

    expect(result.results.map(({ symbol }) => symbol)).toEqual([
      'MSFT',
      'AAPL',
      'FIRST.L',
      'SECOND.L',
    ]);
  });

  it.each([
    { query: 'sPy', symbol: 'SPY', displaySymbol: 'SPY', type: 'ETP' },
    { query: 'tM', symbol: 'TM', displaySymbol: 'TM', type: 'ADR' },
    { query: 'tOy', symbol: 'EXAMPLE.T', displaySymbol: 'TOY', type: 'ADR' },
  ])('returns the exact $query match before applying a one-row limit', async (row) => {
    const { query, ...exact } = row;
    mockSearch(() => ({
      count: 2,
      result: [
        { ...exact, description: 'Exact match' },
        { symbol: 'OTHER', displaySymbol: 'OTHER', description: 'Other', type: 'Common Stock' },
      ],
    }));

    const result = await runToolContract(searchSymbols, { query, limit: 1 });

    expect(result.structuredContent).toMatchObject({
      results: [exact],
      totalCount: 2,
      truncated: true,
      shown: 1,
      cap: 1,
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(`**${exact.symbol}**`),
    });
  });

  it('retains Finnhub order for duplicate exact matches across security types', async () => {
    mockSearch(() => ({
      count: 2,
      result: ['ADR', 'Common Stock'].map((type) => ({
        symbol: 'BABA',
        displaySymbol: 'BABA',
        description: 'Alibaba',
        type,
      })),
    }));

    const result = await runToolContract(searchSymbols, { query: 'BABA' });

    expect(result.structuredContent).toMatchObject({
      results: [{ type: 'ADR' }, { type: 'Common Stock' }],
    });
  });

  it.each([true, false])(
    'echoes the applied exchange with matches present: %s',
    async (matched) => {
      const results = matched
        ? [
            {
              symbol: 'BAC',
              displaySymbol: 'BAC',
              description: 'Bank of America',
              type: 'Common Stock',
            },
          ]
        : [];
      mockSearch(() => ({ count: results.length, result: results }));

      const result = await runToolContract(searchSymbols, { query: 'bank', exchange: ' us ' });

      expect(svc.getFinnhubService().search).toHaveBeenCalledWith('bank', expect.anything(), 'US');
      expect(result.structuredContent).toMatchObject({ exchange: 'US', results });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Exchange: US') });
    },
  );

  it.each([undefined, '', '   '])('searches globally when the exchange is %j', async (exchange) => {
    mockSearch(() => ({ count: 0, result: [] }));

    const result = await runToolContract(searchSymbols, { query: 'bank', exchange });

    expect(svc.getFinnhubService().search).toHaveBeenCalledWith(
      'bank',
      expect.anything(),
      undefined,
    );
    expect(result.structuredContent).not.toHaveProperty('exchange');
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('No matching symbols.'),
    });
  });

  it('rejects a non-string exchange before making an upstream request', async () => {
    const serviceGetter = vi.spyOn(svc, 'getFinnhubService');

    const result = await runToolContract(
      searchSymbols,
      JSON.parse('{"query":"bank","exchange":{"code":"US"}}'),
    );

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(serviceGetter).not.toHaveBeenCalled();
  });

  it('accepts an exact 20-character query', async () => {
    const search = vi.fn().mockResolvedValue({ count: 0, result: [] });
    vi.spyOn(svc, 'getFinnhubService').mockReturnValue({ search } as unknown as svc.FinnhubService);

    const input = searchSymbols.input.parse({ query: 'abcdefghijklmnopqrst' });
    await searchSymbols.handler(input, createMockContext());

    expect(search).toHaveBeenCalledOnce();
  });

  it('classifies US class-share symbols separately from exchange suffixes and ranks them first', async () => {
    mockSearch(() => ({
      count: 10,
      result: [
        {
          symbol: '603020.SS',
          displaySymbol: '603020.SS',
          description: 'China Co',
          type: 'Common Stock',
        },
        {
          symbol: '2788.T',
          displaySymbol: '2788.T',
          description: 'Japan Co',
          type: 'Common Stock',
        },
        { symbol: 'SHEL.L', displaySymbol: 'SHEL.L', description: 'UK Co', type: 'Common Stock' },
        ...['BRK.A', 'BRK.B', 'BF.A', 'BF.B', 'HEI.A', 'LEN.B', 'MOG.A'].map((symbol) => ({
          symbol,
          displaySymbol: symbol,
          description: `${symbol} class share`,
          type: 'Common Stock',
        })),
      ],
    }));

    const result = await searchSymbols.handler(
      searchSymbols.input.parse({ query: 'class shares' }),
      createMockContext(),
    );

    expect(result.results.map(({ symbol }) => symbol)).toEqual([
      'BRK.A',
      'BRK.B',
      'BF.A',
      'BF.B',
      'HEI.A',
      'LEN.B',
      'MOG.A',
      '603020.SS',
      '2788.T',
      'SHEL.L',
    ]);
    expect(result.results.slice(0, 7).every(({ isLikelyUS }) => isLikelyUS)).toBe(true);
    expect(result.results.slice(7).every(({ isLikelyUS }) => !isLikelyUS)).toBe(true);

    const blocks = searchSymbols.format!({ results: result.results });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain('**BRK.A**');
    expect(text).toContain('likely US');
    expect(text).not.toContain('international');
  });

  it('rejects a 21-character query before resolving the Finnhub service', () => {
    const serviceGetter = vi.spyOn(svc, 'getFinnhubService');
    const parsed = searchSymbols.input.safeParse({ query: 'abcdefghijklmnopqrstu' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('20 characters');
    expect(parsed.error?.issues[0]?.message).toContain('shorter company name or ticker fragment');
    expect(serviceGetter).not.toHaveBeenCalled();
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

  it('format() renders the symbol, description, and likely-US heuristic', () => {
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
