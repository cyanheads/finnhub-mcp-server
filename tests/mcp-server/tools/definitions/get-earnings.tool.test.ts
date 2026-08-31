/**
 * @fileoverview Tests for finnhub_get_earnings.
 * @module tests/mcp-server/tools/definitions/get-earnings.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEarnings } from '@/mcp-server/tools/definitions/get-earnings.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';

interface Mocks {
  earnings?: (...args: unknown[]) => unknown;
  earningsCalendar?: (...args: unknown[]) => unknown;
}

function mockService(mocks: Mocks): void {
  const wrap = (fn?: (...args: unknown[]) => unknown) =>
    vi.fn().mockImplementation(async (...args: unknown[]) => {
      const v = fn?.(...args);
      if (v instanceof Error) throw v;
      return v;
    });
  vi.spyOn(svc, 'getFinnhubService').mockReturnValue({
    earnings: wrap(mocks.earnings),
    earningsCalendar: wrap(mocks.earningsCalendar),
  } as unknown as svc.FinnhubService);
}

describe('getEarnings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('history mode: surfaces actual-vs-estimate surprise %, newest first', async () => {
    mockService({
      earnings: () => [
        {
          actual: 2.01,
          estimate: 1.9884,
          period: '2026-03-31',
          quarter: 2,
          surprise: 0.0216,
          surprisePercent: 1.0863,
          symbol: 'AAPL',
          year: 2026,
        },
        {
          actual: 2.84,
          estimate: 2.7257,
          period: '2025-12-31',
          quarter: 1,
          surprise: 0.1143,
          surprisePercent: 4.1934,
          symbol: 'AAPL',
          year: 2026,
        },
      ],
    });
    const ctx = createMockContext({ errors: getEarnings.errors });
    const input = getEarnings.input.parse({ mode: 'history', symbol: 'AAPL' });
    const result = await getEarnings.handler(input, ctx);

    expect(result.mode).toBe('history');
    expect(result.history?.[0]?.surprisePercent).toBe(1.0863);
    expect(result.history?.[0]?.actualEPS).toBe(2.01);
    expect(result.calendar).toBeUndefined();
  });

  it('history mode without a symbol throws missing_symbol', async () => {
    mockService({});
    const ctx = createMockContext({ errors: getEarnings.errors });
    const input = getEarnings.input.parse({ mode: 'history' });

    const err = await Promise.resolve(getEarnings.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('missing_symbol');
  });

  it('history mode re-keys an upstream 403 to not_us_or_paid', async () => {
    mockService({ earnings: () => forbidden('HTTP 403') });
    const ctx = createMockContext({ errors: getEarnings.errors });
    const input = getEarnings.input.parse({ mode: 'history', symbol: 'SAP.DE' });

    const err = await Promise.resolve(getEarnings.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data.reason).toBe('not_us_or_paid');
  });

  it('calendar mode: returns upcoming releases sorted by date, estimate nulls preserved', async () => {
    const earningsCalendar = vi.fn(() => ({
      earningsCalendar: [
        {
          symbol: 'MSFT',
          date: '2026-06-20',
          hour: 'amc',
          epsActual: null,
          epsEstimate: 3.1,
          revenueActual: null,
          revenueEstimate: 64000000000,
          quarter: 4,
          year: 2026,
        },
        {
          symbol: 'ACN',
          date: '2026-06-18',
          hour: 'bmo',
          epsActual: null,
          epsEstimate: null,
          revenueActual: null,
          revenueEstimate: null,
          quarter: 3,
          year: 2026,
        },
      ],
    }));
    mockService({ earningsCalendar });
    const ctx = createMockContext({ errors: getEarnings.errors });
    const input = getEarnings.input.parse({
      mode: 'calendar',
      from: '2026-06-13',
      to: '2026-06-27',
    });
    const result = await getEarnings.handler(input, ctx);

    expect(result.mode).toBe('calendar');
    // Sorted ascending by date: ACN (06-18) before MSFT (06-20).
    expect(result.calendar?.[0]?.symbol).toBe('ACN');
    // Distant/uncovered estimate stays null, not fabricated.
    expect(result.calendar?.[0]?.epsEstimate).toBeNull();
    expect(getEnrichment(ctx).totalCount).toBe(2);
    expect(earningsCalendar).toHaveBeenCalledWith('2026-06-13', '2026-06-27', undefined, ctx);
  });

  it('calendar mode passes a supplied symbol and formats the filtered result', async () => {
    const earningsCalendar = vi.fn(() => ({
      earningsCalendar: [
        {
          symbol: 'AAPL',
          date: '2026-07-30',
          hour: 'amc',
          epsActual: null,
          epsEstimate: 1.42,
          revenueActual: null,
          revenueEstimate: 92_000_000_000,
          quarter: 3,
          year: 2026,
        },
      ],
    }));
    mockService({ earningsCalendar });
    const ctx = createMockContext({ errors: getEarnings.errors });

    const result = await getEarnings.handler(
      getEarnings.input.parse({
        mode: 'calendar',
        symbol: 'AAPL',
        from: '2026-07-01',
        to: '2026-08-01',
      }),
      ctx,
    );

    expect(earningsCalendar).toHaveBeenCalledWith('2026-07-01', '2026-08-01', 'AAPL', ctx);
    expect(result.calendar).toHaveLength(1);
    expect(result.calendar?.[0]?.symbol).toBe('AAPL');
    const text = getEarnings.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('2026-07-30 **AAPL**');
  });

  it('calendar mode re-keys a symbol-filtered upstream 403 to not_us_or_paid', async () => {
    mockService({ earningsCalendar: () => forbidden('HTTP 403') });
    const ctx = createMockContext({ errors: getEarnings.errors });

    const err = await Promise.resolve(
      getEarnings.handler(
        getEarnings.input.parse({
          mode: 'calendar',
          symbol: 'SAP.DE',
          from: '2026-07-01',
          to: '2026-08-01',
        }),
        ctx,
      ),
    ).catch((error) => error);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'not_us_or_paid',
        symbol: 'SAP.DE',
        recovery: {
          hint: 'Free tier is US equities only; use a US symbol or a paid plan.',
        },
      },
    });
  });

  it('calendar mode defaults to a market-wide 14-day window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T12:00:00.000Z'));
    try {
      const earningsCalendar = vi.fn(() => ({ earningsCalendar: [] }));
      mockService({ earningsCalendar });
      const ctx = createMockContext({ errors: getEarnings.errors });

      const result = await getEarnings.handler(getEarnings.input.parse({ mode: 'calendar' }), ctx);

      expect(result).toEqual({ mode: 'calendar', calendar: [] });
      expect(earningsCalendar).toHaveBeenCalledWith('2026-06-13', '2026-06-27', undefined, ctx);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calendar mode treats an empty symbol as an omitted market-wide filter', async () => {
    const earningsCalendar = vi.fn(() => ({ earningsCalendar: [] }));
    mockService({ earningsCalendar });
    const ctx = createMockContext({ errors: getEarnings.errors });

    const result = await getEarnings.handler(
      getEarnings.input.parse({
        mode: 'calendar',
        symbol: '',
        from: '2026-06-13',
        to: '2026-06-27',
      }),
      ctx,
    );

    expect(result).toEqual({ mode: 'calendar', calendar: [] });
    expect(earningsCalendar).toHaveBeenCalledWith('2026-06-13', '2026-06-27', undefined, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'No earnings releases between 2026-06-13 and 2026-06-27. Widen the date window.',
    );
  });

  it('calendar mode truncates only after sorting the full returned window', async () => {
    mockService({
      earningsCalendar: () => ({
        earningsCalendar: [
          {
            symbol: 'LATE',
            date: '2026-06-20',
            hour: 'amc',
            epsActual: null,
            epsEstimate: 1,
            revenueActual: null,
            revenueEstimate: 1,
            quarter: 2,
            year: 2026,
          },
          {
            symbol: 'EARLY',
            date: '2026-06-18',
            hour: 'bmo',
            epsActual: null,
            epsEstimate: 2,
            revenueActual: null,
            revenueEstimate: 2,
            quarter: 2,
            year: 2026,
          },
          {
            symbol: 'MIDDLE',
            date: '2026-06-19',
            hour: '',
            epsActual: null,
            epsEstimate: 3,
            revenueActual: null,
            revenueEstimate: 3,
            quarter: 2,
            year: 2026,
          },
        ],
      }),
    });
    const ctx = createMockContext({ errors: getEarnings.errors });

    const result = await getEarnings.handler(
      getEarnings.input.parse({
        mode: 'calendar',
        from: '2026-06-18',
        to: '2026-06-20',
        limit: 2,
      }),
      ctx,
    );

    expect(result.calendar?.map((entry) => entry.symbol)).toEqual(['EARLY', 'MIDDLE']);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 3, truncated: true, shown: 2, cap: 2 });
  });

  it('calendar mode emits a notice when the window is empty', async () => {
    mockService({ earningsCalendar: () => ({ earningsCalendar: [] }) });
    const ctx = createMockContext({ errors: getEarnings.errors });
    const input = getEarnings.input.parse({
      mode: 'calendar',
      from: '2030-01-01',
      to: '2030-01-02',
    });
    const result = await getEarnings.handler(input, ctx);

    expect(result.calendar).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('2030-01-01');
  });

  it('calendar mode returns a successful symbol-filtered empty result with scoped guidance', async () => {
    const earningsCalendar = vi.fn(() => ({ earningsCalendar: [] }));
    mockService({ earningsCalendar });
    const ctx = createMockContext({ errors: getEarnings.errors });

    const result = await getEarnings.handler(
      getEarnings.input.parse({
        mode: 'calendar',
        symbol: 'AAPL',
        from: '2030-01-01',
        to: '2030-01-02',
      }),
      ctx,
    );

    expect(result).toEqual({ mode: 'calendar', calendar: [] });
    expect(earningsCalendar).toHaveBeenCalledWith('2030-01-01', '2030-01-02', 'AAPL', ctx);
    expect(getEnrichment(ctx).notice).toContain('AAPL');
  });

  it('calendar mode applies truncation after the upstream symbol filter', async () => {
    mockService({
      earningsCalendar: () => ({
        earningsCalendar: Array.from({ length: 3 }, (_, index) => ({
          symbol: 'AAPL',
          date: `2026-07-${30 - index}`,
          hour: 'amc',
          epsActual: null,
          epsEstimate: 1 + index,
          revenueActual: null,
          revenueEstimate: 92_000_000_000 + index,
          quarter: 3,
          year: 2026,
        })),
      }),
    });
    const ctx = createMockContext({ errors: getEarnings.errors });

    const result = await getEarnings.handler(
      getEarnings.input.parse({
        mode: 'calendar',
        symbol: 'AAPL',
        from: '2026-07-01',
        to: '2026-08-01',
        limit: 2,
      }),
      ctx,
    );

    expect(result.calendar).toHaveLength(2);
    expect(result.calendar?.every((entry) => entry.symbol === 'AAPL')).toBe(true);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 3, truncated: true, shown: 2, cap: 2 });
  });

  it('format() renders the surprise % for history mode', () => {
    const blocks = getEarnings.format!({
      mode: 'history',
      history: [
        {
          period: '2026-03-31',
          year: 2026,
          quarter: 2,
          actualEPS: 2.01,
          estimateEPS: 1.98,
          surprise: 0.03,
          surprisePercent: 1.09,
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('2026-03-31');
    expect(text).toContain('1.09%');
  });

  it('format() renders every field of a calendar result', () => {
    const blocks = getEarnings.format!({
      mode: 'calendar',
      calendar: [
        {
          symbol: 'AAPL',
          date: '2026-07-30',
          hour: 'amc',
          epsEstimate: 1.42,
          revenueEstimate: 92_000_000_000,
          year: 2026,
          quarter: 3,
        },
      ],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');

    expect(text).toContain('2026-07-30 **AAPL**');
    expect(text).toContain('FY2026 Q3, amc');
    expect(text).toContain('EPS est 1.42, revenue est 92000000000');
  });
});
