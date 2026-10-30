/**
 * @fileoverview Tests for finnhub_get_company.
 * @module tests/mcp-server/tools/definitions/get-company.tool.test
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCompany } from '@/mcp-server/tools/definitions/get-company.tool.js';
import * as svc from '@/services/finnhub/finnhub-service.js';

interface Mocks {
  metrics?: () => unknown;
  peers?: () => unknown;
  profile?: () => unknown;
}

function mockService(mocks: Mocks): void {
  const wrap = (fn?: () => unknown) =>
    vi.fn().mockImplementation(async () => {
      const v = fn?.();
      if (v instanceof Error) throw v;
      return v;
    });
  vi.spyOn(svc, 'getFinnhubService').mockReturnValue({
    profile: wrap(mocks.profile),
    metrics: wrap(mocks.metrics),
    peers: wrap(mocks.peers),
  } as unknown as svc.FinnhubService);
}

const fullProfile = {
  ticker: 'AAPL',
  name: 'Apple Inc',
  country: 'US',
  currency: 'USD',
  exchange: 'NASDAQ NMS - GLOBAL MARKET',
  ipo: '1980-12-12',
  marketCapitalization: 4275930,
  shareOutstanding: 14687.36,
  logo: 'https://logo',
  weburl: 'https://apple.com',
  finnhubIndustry: 'Technology',
};

const fullMetric = {
  metric: {
    peTTM: 34.8,
    epsTTM: 8.26,
    '52WeekHigh': 317.4,
    '52WeekLow': 195.07,
    beta: 1.1,
    currentDividendYieldTTM: 0.36,
    netProfitMarginTTM: 27.15,
    grossMarginTTM: 47.86,
    revenueGrowthTTMYoy: 12.76,
    roeTTM: 146.69,
  },
};

describe('getCompany', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects whitespace-only company input before the three requests', async () => {
    mockService({});
    const result = await runToolContract(getCompany, { symbol: '   ' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    for (const method of [
      svc.getFinnhubService().profile,
      svc.getFinnhubService().metrics,
      svc.getFinnhubService().peers,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it('normalizes the symbol in forbidden company errors', async () => {
    mockService({
      profile: () => forbidden('HTTP 403'),
      metrics: () => fullMetric,
      peers: () => [],
    });
    const result = await runToolContract(getCompany, { symbol: ' sap.de ' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'not_us_or_paid', symbol: 'SAP.DE' },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('paid Finnhub plan') }),
      ]),
    );
  });

  it('normalizes symbols across all three company requests and both surfaces', async () => {
    mockService({ profile: () => fullProfile, metrics: () => fullMetric, peers: () => [] });
    const service = svc.getFinnhubService();
    const result = await runToolContract(getCompany, { symbol: ' aApL ' });
    for (const method of [service.profile, service.metrics, service.peers])
      expect(method).toHaveBeenCalledWith('AAPL', expect.anything());
    expect(result.structuredContent).toMatchObject({
      symbol: 'AAPL',
      profile: { name: 'Apple Inc' },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('(AAPL)') }),
      ]),
    );
  });

  it.each([
    [' spy ', 'SPY'],
    ['qqq', 'QQQ'],
    ['zzzzbogus', 'ZZZZBOGUS'],
  ])(
    'keeps %s empty-profile errors conditional with recovery on both surfaces',
    async (symbol, normalized) => {
      mockService({ profile: () => ({}), metrics: () => fullMetric, peers: () => [] });
      const result = await runToolContract(getCompany, { symbol });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'symbol_not_found',
            symbol: normalized,
            recovery: { hint: expect.stringContaining('ETFs, funds, or trusts may') },
          },
        },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('finnhub_get_quote');
      expect(text).toContain('finnhub_search_symbols');
      expect(text).toContain('ETFs, funds, or trusts may');
      expect(svc.getFinnhubService().profile).toHaveBeenCalledTimes(1);
    },
  );

  it('assembles profile + fundamentals + peers in one call', async () => {
    mockService({
      profile: () => fullProfile,
      metrics: () => fullMetric,
      peers: () => ['AAPL', 'DELL', 'HPQ'],
    });
    const ctx = createMockContext({ errors: getCompany.errors });
    const input = getCompany.input.parse({ symbol: 'AAPL' });
    const result = await getCompany.handler(input, ctx);

    expect(result.profile.name).toBe('Apple Inc');
    expect(result.profile.industry).toBe('Technology');
    expect(result.fundamentals.peTTM).toBe(34.8);
    expect(result.fundamentals.roeTTM).toBe(146.69);
    expect(result.peers).toContain('DELL');
    expect(result.partial).toBeUndefined();
  });

  it('keeps sparse fundamentals null (never zero-filled) and degrades to partial', async () => {
    // Thinly-covered name: profile present, metrics endpoint fails, peers empty.
    mockService({
      profile: () => ({ ticker: 'TINY', name: 'Tiny Co', country: 'US', currency: 'USD' }),
      metrics: () => new Error('metrics unavailable'),
      peers: () => [],
    });
    const ctx = createMockContext({ errors: getCompany.errors });
    const input = getCompany.input.parse({ symbol: 'TINY' });
    const result = await getCompany.handler(input, ctx);

    expect(result.profile.name).toBe('Tiny Co');
    // Absent metrics surface as null, not 0.
    expect(result.fundamentals.peTTM).toBeNull();
    expect(result.fundamentals.epsTTM).toBeNull();
    expect(result.profile.marketCapitalization).toBeNull();
    expect(result.partial).toContain('metrics');
  });

  it('throws symbol_not_found when /stock/profile2 returns an empty object', async () => {
    mockService({ profile: () => ({}), metrics: () => fullMetric, peers: () => [] });
    const ctx = createMockContext({ errors: getCompany.errors });
    const input = getCompany.input.parse({ symbol: 'ZZZZBOGUS' });

    const err = await Promise.resolve(getCompany.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('symbol_not_found');
  });

  it('re-keys an upstream 403 on the profile leg to not_us_or_paid', async () => {
    mockService({
      profile: () => forbidden('HTTP 403'),
      metrics: () => fullMetric,
      peers: () => [],
    });
    const ctx = createMockContext({ errors: getCompany.errors });
    const input = getCompany.input.parse({ symbol: 'SAP.DE' });

    const err = await Promise.resolve(getCompany.handler(input, ctx)).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data.reason).toBe('not_us_or_paid');
  });

  it('format() renders unknown fundamentals honestly for a sparse company', () => {
    const blocks = getCompany.format!({
      symbol: 'TINY',
      profile: {
        name: 'Tiny Co',
        exchange: '',
        industry: '',
        country: 'US',
        currency: 'USD',
        marketCapitalization: null,
        shareOutstanding: null,
        ipo: null,
        weburl: null,
        logo: null,
      },
      fundamentals: {
        peTTM: null,
        epsTTM: null,
        week52High: null,
        week52Low: null,
        beta: null,
        dividendYieldTTM: null,
        netProfitMarginTTM: null,
        grossMarginTTM: null,
        revenueGrowthTTMYoy: null,
        roeTTM: null,
      },
      peers: [],
      partial: ['metrics'],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Tiny Co');
    expect(text).toContain('Not available');
    expect(text).toContain('partial');
  });
});
