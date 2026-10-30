/**
 * @fileoverview Tests for finnhub_get_recommendations.
 * @module tests/mcp-server/tools/definitions/get-recommendations.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecommendations } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';

function mockRecs(impl: () => unknown): void {
  vi.spyOn(svc, 'getFinnhubService').mockReturnValue({
    recommendations: vi.fn().mockImplementation(async () => {
      const v = impl();
      if (v instanceof Error) throw v;
      return v;
    }),
  } as unknown as svc.FinnhubService);
}

describe('getRecommendations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects whitespace-only recommendation input before fetching', async () => {
    mockRecs(() => []);
    const result = await runToolContract(getRecommendations, { symbol: '   ' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(svc.getFinnhubService().recommendations).not.toHaveBeenCalled();
  });

  it('normalizes the symbol in forbidden recommendation errors', async () => {
    mockRecs(() => forbidden('HTTP 403'));
    const result = await runToolContract(getRecommendations, { symbol: ' sap.de ' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'not_us_or_paid', symbol: 'SAP.DE' },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('paid plan') }),
      ]),
    );
  });

  it('normalizes recommendation requests and the symbol on both surfaces', async () => {
    mockRecs(() => [
      {
        symbol: 'AAPL',
        period: '2026-10-01',
        strongBuy: 1,
        buy: 2,
        hold: 3,
        sell: 0,
        strongSell: 0,
      },
    ]);
    const result = await runToolContract(getRecommendations, { symbol: ' aapl ' });
    expect(svc.getFinnhubService().recommendations).toHaveBeenCalledWith('AAPL', expect.anything());
    expect(result.structuredContent).toMatchObject({ symbol: 'AAPL', totalCount: 1 });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('**AAPL**') }),
      ]),
    );
  });

  it.each([
    ['spy', 'SPY'],
    [' qqq ', 'QQQ'],
    ['zzzzbogus', 'ZZZZBOGUS'],
  ])('keeps %s no-coverage recovery conditional on both surfaces', async (symbol, normalized) => {
    mockRecs(() => []);
    const result = await runToolContract(getRecommendations, { symbol });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_coverage',
          symbol: normalized,
          recovery: { hint: expect.stringContaining('ETFs, funds, or trusts may') },
        },
      },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('finnhub_get_quote');
    expect(text).toContain('finnhub_search_symbols');
    expect(text).toContain('ETFs, funds, or trusts may');
    expect(svc.getFinnhubService().recommendations).toHaveBeenCalledTimes(1);
  });

  it('caps available history without inventing older months and keeps limit bounds', async () => {
    mockRecs(() => [
      {
        symbol: 'AAPL',
        period: '2026-10-01',
        strongBuy: 1,
        buy: 2,
        hold: 3,
        sell: 0,
        strongSell: 0,
      },
    ]);
    const ctx = createMockContext({ errors: getRecommendations.errors });
    const result = await getRecommendations.handler(
      getRecommendations.input.parse({ symbol: 'AAPL', limit: 24 }),
      ctx,
    );
    expect(result.trends).toHaveLength(1);
    expect(getEnrichment(ctx)).toEqual({ totalCount: 1 });
    expect(getRecommendations.input.parse({ symbol: 'AAPL' }).limit).toBe(12);
    expect(() => getRecommendations.input.parse({ symbol: 'AAPL', limit: 0 })).toThrow();
    expect(() => getRecommendations.input.parse({ symbol: 'AAPL', limit: 25 })).toThrow();
    expect(getRecommendations.format!(result)).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('2026-10-01: 1 strong-buy / 2 buy / 3 hold'),
      }),
    ]);
  });

  it('returns analyst trend counts, newest month first', async () => {
    mockRecs(() => [
      {
        symbol: 'AAPL',
        period: '2026-04-01',
        strongBuy: 12,
        buy: 20,
        hold: 16,
        sell: 3,
        strongSell: 1,
      },
      {
        symbol: 'AAPL',
        period: '2026-06-01',
        strongBuy: 14,
        buy: 24,
        hold: 15,
        sell: 2,
        strongSell: 0,
      },
    ]);
    const ctx = createMockContext({ errors: getRecommendations.errors });
    const input = getRecommendations.input.parse({ symbol: 'AAPL' });
    const result = await getRecommendations.handler(input, ctx);

    expect(result.symbol).toBe('AAPL');
    // Newest month (2026-06) sorts first.
    expect(result.trends[0]?.period).toBe('2026-06-01');
    expect(result.trends[0]?.strongBuy).toBe(14);
    // Below the cap: totalCount is set, but the truncation fields stay absent.
    // Declaring them present-and-false (or required) throws -32007 on every
    // non-truncated result — the standing capped-list rule. Verified live: a
    // large-cap with few months returns no truncated/shown/cap.
    const enrich = getEnrichment(ctx);
    expect(enrich.totalCount).toBe(2);
    expect(enrich.truncated).toBeUndefined();
    expect(enrich.shown).toBeUndefined();
    expect(enrich.cap).toBeUndefined();
  });

  it('throws no_coverage when the endpoint returns an empty array', async () => {
    mockRecs(() => []);
    const ctx = createMockContext({ errors: getRecommendations.errors });
    const input = getRecommendations.input.parse({ symbol: 'ZZZZBOGUS' });

    const err = await Promise.resolve(getRecommendations.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('no_coverage');
  });

  it('re-keys an upstream 403 to not_us_or_paid', async () => {
    mockRecs(() => forbidden('HTTP 403'));
    const ctx = createMockContext({ errors: getRecommendations.errors });
    const input = getRecommendations.input.parse({ symbol: 'SAP.DE' });

    const err = await Promise.resolve(getRecommendations.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data.reason).toBe('not_us_or_paid');
  });

  it('discloses truncation when more months exist than the limit', async () => {
    mockRecs(() =>
      Array.from({ length: 20 }, (_, i) => ({
        symbol: 'AAPL',
        period: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
        strongBuy: i,
        buy: i,
        hold: i,
        sell: 0,
        strongSell: 0,
      })),
    );
    const ctx = createMockContext({ errors: getRecommendations.errors });
    const input = getRecommendations.input.parse({ symbol: 'AAPL', limit: 6 });
    const result = await getRecommendations.handler(input, ctx);

    expect(result.trends).toHaveLength(6);
    const enrich = getEnrichment(ctx);
    expect(enrich.totalCount).toBe(20);
    expect(enrich.truncated).toBe(true);
    expect(enrich.cap).toBe(6);
  });

  it('format() renders the per-month rating counts', () => {
    const blocks = getRecommendations.format!({
      symbol: 'AAPL',
      trends: [{ period: '2026-06-01', strongBuy: 14, buy: 24, hold: 15, sell: 2, strongSell: 0 }],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('2026-06-01');
    expect(text).toContain('14 strong-buy');
  });
});
