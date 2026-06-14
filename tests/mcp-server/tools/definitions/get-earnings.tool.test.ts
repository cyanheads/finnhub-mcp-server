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
  earnings?: () => unknown;
  earningsCalendar?: () => unknown;
}

function mockService(mocks: Mocks): void {
  const wrap = (fn?: () => unknown) =>
    vi.fn().mockImplementation(async () => {
      const v = fn?.();
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

    const err = await getEarnings.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('missing_symbol');
  });

  it('history mode re-keys an upstream 403 to not_us_or_paid', async () => {
    mockService({ earnings: () => forbidden('HTTP 403') });
    const ctx = createMockContext({ errors: getEarnings.errors });
    const input = getEarnings.input.parse({ mode: 'history', symbol: 'SAP.DE' });

    const err = await getEarnings.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data.reason).toBe('not_us_or_paid');
  });

  it('calendar mode: returns upcoming releases sorted by date, estimate nulls preserved', async () => {
    mockService({
      earningsCalendar: () => ({
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
      }),
    });
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
});
