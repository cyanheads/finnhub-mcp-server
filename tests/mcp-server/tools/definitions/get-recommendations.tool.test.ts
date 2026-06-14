/**
 * @fileoverview Tests for finnhub_get_recommendations.
 * @module tests/mcp-server/tools/definitions/get-recommendations.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

    const err = await getRecommendations.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('no_coverage');
  });

  it('re-keys an upstream 403 to not_us_or_paid', async () => {
    mockRecs(() => forbidden('HTTP 403'));
    const ctx = createMockContext({ errors: getRecommendations.errors });
    const input = getRecommendations.input.parse({ symbol: 'SAP.DE' });

    const err = await getRecommendations.handler(input, ctx).catch((e) => e);
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
