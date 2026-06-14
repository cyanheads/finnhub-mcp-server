/**
 * @fileoverview Tests for finnhub_get_quote.
 * @module tests/mcp-server/tools/definitions/get-quote.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQuote } from '@/mcp-server/tools/definitions/get-quote.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';

interface Mocks {
  marketStatus?: () => unknown;
  quote?: () => unknown;
}

function mockService(mocks: Mocks): void {
  vi.spyOn(svc, 'getFinnhubService').mockReturnValue({
    quote: vi.fn().mockImplementation(async () => {
      const v = mocks.quote?.();
      if (v instanceof Error) throw v;
      return v;
    }),
    marketStatus: vi.fn().mockImplementation(async () => {
      const v = mocks.marketStatus?.();
      if (v instanceof Error) throw v;
      return v;
    }),
  } as unknown as svc.FinnhubService);
}

const liveQuote = {
  c: 291.13,
  d: -4.5,
  dp: -1.5222,
  h: 297.14,
  l: 289.62,
  o: 296.03,
  pc: 295.63,
  t: 1781294400,
};

describe('getQuote', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a live quote with priceIsLive=true when the market is open', async () => {
    mockService({ quote: () => liveQuote, marketStatus: () => ({ isOpen: true }) });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'AAPL' });
    const result = await getQuote.handler(input, ctx);

    expect(result.symbol).toBe('AAPL');
    expect(result.current).toBe(291.13);
    expect(result.percentChange).toBe(-1.5222);
    expect(result.marketOpen).toBe(true);
    expect(result.priceIsLive).toBe(true);
    expect(result.quoteTime).toBe(new Date(1781294400 * 1000).toISOString());
  });

  it('marks priceIsLive=false (prior close) when the market is closed', async () => {
    mockService({ quote: () => liveQuote, marketStatus: () => ({ isOpen: false }) });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'AAPL' });
    const result = await getQuote.handler(input, ctx);

    expect(result.marketOpen).toBe(false);
    expect(result.priceIsLive).toBe(false);
  });

  it('degrades to marketOpen=null / priceIsLive=false when market-status fails', async () => {
    mockService({
      quote: () => liveQuote,
      marketStatus: () => new Error('status endpoint down'),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'AAPL' });
    const result = await getQuote.handler(input, ctx);

    expect(result.current).toBe(291.13);
    expect(result.marketOpen).toBeNull();
    expect(result.priceIsLive).toBe(false);
  });

  it('throws symbol_not_found on the all-zero sentinel (c=0, t=0, d/dp null)', async () => {
    mockService({
      quote: () => ({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }),
      marketStatus: () => ({ isOpen: false }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'ZZZZBOGUS' });

    const err = await getQuote.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('symbol_not_found');
  });

  it('re-keys an upstream 403 to not_us_or_paid (Forbidden)', async () => {
    mockService({
      quote: () => forbidden('HTTP 403'),
      marketStatus: () => ({ isOpen: false }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'SHOP.TO' });

    const err = await getQuote.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data.reason).toBe('not_us_or_paid');
  });

  it('format() states live vs. prior-close in the rendered text', () => {
    const closed = getQuote.format!({
      symbol: 'AAPL',
      current: 291.13,
      change: -4.5,
      percentChange: -1.52,
      high: 297,
      low: 289,
      open: 296,
      previousClose: 295.63,
      quoteTime: '2026-06-12T00:00:00.000Z',
      marketOpen: false,
      priceIsLive: false,
    });
    const text = closed.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('AAPL');
    expect(text).toContain('prior close');
  });
});
