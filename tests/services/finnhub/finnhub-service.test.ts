/**
 * @fileoverview Tests for FinnhubService — the HTTP/status-classification layer.
 * `fetchWithTimeout` is mocked to mirror the real framework behavior (it THROWS
 * a status-mapped `McpError` on any non-OK response, never returns it), so the
 * error-path classification is exercised, not stubbed away. `withRetry` is kept
 * real via `importOriginal` so retry semantics aren't bypassed.
 * @module tests/services/finnhub/finnhub-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { httpStatusToErrorCode } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the (hoisted) vi.mock factory below can close over it.
const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchWithTimeoutMock };
});

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiKey: 'test-key',
    baseUrl: 'https://finnhub.io/api/v1',
  }),
}));

// Imported after the mocks are registered.
const { FinnhubService } = await import('@/services/finnhub/finnhub-service.js');

/** An OK Response stub whose `.json()` resolves the given body. */
function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * Mirror the real `fetchWithTimeout`: THROW a status-mapped McpError on non-OK.
 * A mock that *returned* a non-OK response would hide the dead error path.
 */
function makeNonOkThrow(status: number): McpError {
  const code = httpStatusToErrorCode(status) ?? JsonRpcErrorCode.InternalError;
  return new McpError(code, `HTTP ${status}`, { status });
}

describe('FinnhubService', () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON on a 200 response and appends the token query param', async () => {
    fetchWithTimeoutMock.mockResolvedValue(okResponse({ count: 1, result: [] }));
    const service = new FinnhubService();
    const ctx = createMockContext();

    const out = await service.search('apple', ctx);

    expect(out).toEqual({ count: 1, result: [] });
    const calledUrl = String(fetchWithTimeoutMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('/search');
    expect(calledUrl).toContain('q=apple');
    expect(calledUrl).toContain('token=test-key');
  });

  it('re-keys a 401 to ConfigurationError (loud bad-key failure, not "no data")', async () => {
    fetchWithTimeoutMock.mockRejectedValue(makeNonOkThrow(401));
    const service = new FinnhubService();
    const ctx = createMockContext();

    const err = await service.quote('AAPL', ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('passes a 403 through as Forbidden (international / paid-only symbol)', async () => {
    fetchWithTimeoutMock.mockRejectedValue(makeNonOkThrow(403));
    const service = new FinnhubService();
    const ctx = createMockContext();

    const err = await service.quote('SHOP.TO', ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
  });

  /**
   * 429 and 503 are retryable, so `withRetry` (kept real) backs off between
   * attempts. Fake timers fast-forward the backoff so the test verifies the
   * final classification without waiting real seconds.
   */
  it('surfaces a 429 as RateLimited (after exhausting retries)', async () => {
    vi.useFakeTimers();
    try {
      fetchWithTimeoutMock.mockRejectedValue(makeNonOkThrow(429));
      const service = new FinnhubService();
      const ctx = createMockContext();

      const promise = service.search('apple', ctx).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await promise;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a 503 as ServiceUnavailable (after exhausting retries)', async () => {
    vi.useFakeTimers();
    try {
      fetchWithTimeoutMock.mockRejectedValue(makeNonOkThrow(503));
      const service = new FinnhubService();
      const ctx = createMockContext();

      const promise = service.peers('AAPL', ctx).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await promise;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the all-zero quote sentinel verbatim — sentinel detection is the tool layer job', async () => {
    const sentinel = { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 };
    fetchWithTimeoutMock.mockResolvedValue(okResponse(sentinel));
    const service = new FinnhubService();
    const ctx = createMockContext();

    const out = await service.quote('ZZZZBOGUS', ctx);
    expect(out).toEqual(sentinel);
  });
});
