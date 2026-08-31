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
    mockService({
      quote: () => liveQuote,
      marketStatus: () => ({ holiday: null, isOpen: true, session: 'regular' }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'AAPL' });
    const result = await getQuote.handler(input, ctx);

    expect(result.symbol).toBe('AAPL');
    expect(result.current).toBe(291.13);
    expect(result.percentChange).toBe(-1.5222);
    expect(result.marketOpen).toBe(true);
    expect(result.priceIsLive).toBe(true);
    expect(result).toMatchObject({ session: 'regular', holiday: null });
    expect(result).toEqual(expect.schemaMatching(getQuote.output));
    expect(result.quoteTime).toBe(new Date(1781294400 * 1000).toISOString());

    const text = getQuote.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('(regular — live)');
    expect(text).toContain('Market session: regular');
  });

  it('marks priceIsLive=false (prior close) when the market is closed', async () => {
    mockService({
      quote: () => liveQuote,
      marketStatus: () => ({ holiday: null, isOpen: false, session: null }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'AAPL' });
    const result = await getQuote.handler(input, ctx);

    expect(result.marketOpen).toBe(false);
    expect(result.priceIsLive).toBe(false);
  });

  it('returns and formats pre-market status without treating the quote as live', async () => {
    mockService({
      quote: () => liveQuote,
      marketStatus: () => ({ holiday: null, isOpen: false, session: 'pre-market' }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });

    const result = await getQuote.handler(getQuote.input.parse({ symbol: 'AAPL' }), ctx);

    expect(result).toMatchObject({
      marketOpen: false,
      priceIsLive: false,
      session: 'pre-market',
      holiday: null,
    });
    const text = getQuote.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('(pre-market — prior close)');
    expect(text).toContain('Market session: pre-market');
  });

  it('returns and formats a named holiday closure without inventing a session', async () => {
    mockService({
      quote: () => liveQuote,
      marketStatus: () => ({ holiday: 'Christmas Day', isOpen: false, session: null }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });

    const result = await getQuote.handler(getQuote.input.parse({ symbol: 'AAPL' }), ctx);

    expect(result).toMatchObject({
      marketOpen: false,
      priceIsLive: false,
      session: null,
      holiday: 'Christmas Day',
    });
    const text = getQuote.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('(prior close — market closed)');
    expect(text).toContain('Holiday: Christmas Day');
    expect(text).not.toContain('Market session:');
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
    expect(result).toMatchObject({ session: null, holiday: null });
    expect(result).toEqual(expect.schemaMatching(getQuote.output));

    const text = getQuote.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('(freshness unknown)');
    expect(text).not.toContain('Market session:');
    expect(text).not.toContain('Holiday:');
  });

  it('throws symbol_not_found on the all-zero sentinel (c=0, t=0, d/dp null)', async () => {
    mockService({
      quote: () => ({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }),
      marketStatus: () => ({ holiday: null, isOpen: false, session: null }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'ZZZZBOGUS' });

    const err = await Promise.resolve(getQuote.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('symbol_not_found');
  });

  it('re-keys an upstream 403 to not_us_or_paid (Forbidden)', async () => {
    mockService({
      quote: () => forbidden('HTTP 403'),
      marketStatus: () => ({ holiday: null, isOpen: false, session: null }),
    });
    const ctx = createMockContext({ errors: getQuote.errors });
    const input = getQuote.input.parse({ symbol: 'SHOP.TO' });

    const err = await Promise.resolve(getQuote.handler(input, ctx)).catch((e) => e);
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
      session: null,
      holiday: null,
      priceIsLive: false,
    });
    const text = closed.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toBe(
      '**AAPL** $291.13 ▼ -1.52% (prior close — market closed)\n' +
        'Change: -4.50 | Open: 296 | High: 297 | Low: 289 | Prev close: 295.63\n' +
        'Quote time: 2026-06-12T00:00:00.000Z | Market open: no',
    );
  });

  it('format() preserves the existing unknown-freshness wording', () => {
    const blocks = getQuote.format!({
      symbol: 'AAPL',
      current: 291.13,
      change: -4.5,
      percentChange: -1.52,
      high: 297,
      low: 289,
      open: 296,
      previousClose: 295.63,
      quoteTime: '2026-06-12T00:00:00.000Z',
      marketOpen: null,
      session: null,
      holiday: null,
      priceIsLive: false,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(text).toContain('(freshness unknown)');
    expect(text).not.toContain('Market open:');
  });
});
