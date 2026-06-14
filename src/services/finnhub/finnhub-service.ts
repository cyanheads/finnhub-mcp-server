/**
 * @fileoverview FinnhubService — the single authenticated, rate-aware,
 * status-classifying HTTP client for the Finnhub REST API. One typed method per
 * upstream endpoint the tool surface needs. Owns auth (the `token` query param),
 * resilience (`withRetry` around the full fetch+parse pipeline via
 * `fetchWithTimeout`), and the status classification that gives every tool
 * identical, correct error semantics.
 * @module services/finnhub/finnhub-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  FinnhubEarning,
  FinnhubEarningsCalendar,
  FinnhubMarketStatus,
  FinnhubMetricResponse,
  FinnhubNewsArticle,
  FinnhubProfile,
  FinnhubQuote,
  FinnhubRecommendation,
  FinnhubSearchResponse,
} from './types.js';

/** Per-request timeout for a single Finnhub call. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Retry backoff calibrated to a rate-limited upstream — the 60 req/min free-tier
 * cap is the realistic failure mode under burst, so a ~1s base gives the window
 * time to roll over.
 */
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Authenticated client for the Finnhub REST API. Initialized once in
 * `createApp`'s `setup()` and accessed via {@link getFinnhubService}.
 */
export class FinnhubService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.baseUrl.replace(/\/$/, '');
    this.apiKey = serverConfig.apiKey;
  }

  /** `GET /search?q={query}` — resolve a name/ticker fragment to symbols. */
  search(query: string, ctx: RequestContextLike): Promise<FinnhubSearchResponse> {
    return this.request<FinnhubSearchResponse>('/search', { q: query }, 'search', ctx);
  }

  /** `GET /quote?symbol={symbol}` — real-time price snapshot. */
  quote(symbol: string, ctx: RequestContextLike): Promise<FinnhubQuote> {
    return this.request<FinnhubQuote>('/quote', { symbol }, 'quote', ctx);
  }

  /** `GET /stock/market-status?exchange={exchange}` — live market-open flag. */
  marketStatus(exchange: string, ctx: RequestContextLike): Promise<FinnhubMarketStatus> {
    return this.request<FinnhubMarketStatus>(
      '/stock/market-status',
      { exchange },
      'marketStatus',
      ctx,
    );
  }

  /** `GET /stock/profile2?symbol={symbol}` — company profile (`{}` if unknown). */
  profile(symbol: string, ctx: RequestContextLike): Promise<FinnhubProfile> {
    return this.request<FinnhubProfile>('/stock/profile2', { symbol }, 'profile', ctx);
  }

  /** `GET /stock/metric?symbol={symbol}&metric=all` — fundamentals (~100 keys). */
  metrics(symbol: string, ctx: RequestContextLike): Promise<FinnhubMetricResponse> {
    return this.request<FinnhubMetricResponse>(
      '/stock/metric',
      { symbol, metric: 'all' },
      'metrics',
      ctx,
    );
  }

  /** `GET /stock/peers?symbol={symbol}` — sector peer symbols (includes the query). */
  peers(symbol: string, ctx: RequestContextLike): Promise<string[]> {
    return this.request<string[]>('/stock/peers', { symbol }, 'peers', ctx);
  }

  /** `GET /stock/earnings?symbol={symbol}` — past quarters, newest first. */
  earnings(symbol: string, ctx: RequestContextLike): Promise<FinnhubEarning[]> {
    return this.request<FinnhubEarning[]>('/stock/earnings', { symbol }, 'earnings', ctx);
  }

  /** `GET /calendar/earnings?from={from}&to={to}` — upcoming releases window. */
  earningsCalendar(
    from: string,
    to: string,
    ctx: RequestContextLike,
  ): Promise<FinnhubEarningsCalendar> {
    return this.request<FinnhubEarningsCalendar>(
      '/calendar/earnings',
      { from, to },
      'earningsCalendar',
      ctx,
    );
  }

  /** `GET /company-news?symbol={symbol}&from={from}&to={to}`. */
  companyNews(
    symbol: string,
    from: string,
    to: string,
    ctx: RequestContextLike,
  ): Promise<FinnhubNewsArticle[]> {
    return this.request<FinnhubNewsArticle[]>(
      '/company-news',
      { symbol, from, to },
      'companyNews',
      ctx,
    );
  }

  /** `GET /news?category={category}` — market-wide headlines. */
  marketNews(category: string, ctx: RequestContextLike): Promise<FinnhubNewsArticle[]> {
    return this.request<FinnhubNewsArticle[]>('/news', { category }, 'marketNews', ctx);
  }

  /** `GET /stock/recommendation?symbol={symbol}` — analyst trends, empty if no coverage. */
  recommendations(symbol: string, ctx: RequestContextLike): Promise<FinnhubRecommendation[]> {
    return this.request<FinnhubRecommendation[]>(
      '/stock/recommendation',
      { symbol },
      'recommendations',
      ctx,
    );
  }

  /**
   * Core request pipeline: build the authenticated URL, fetch, and parse — all
   * wrapped in `withRetry` so transient failures (429/5xx/network) back off and
   * retry while deterministic failures (401/403) fail fast.
   *
   * `fetchWithTimeout` throws a classified `McpError` on any non-OK status and
   * reduces URLs in errors/logs to origin + pathname, so the `token` query
   * param never reaches a client or a log line. Its default status mapping
   * matches the design for 403 (→ `Forbidden`), 429 (→ `RateLimited`), and 5xx
   * (→ `ServiceUnavailable`); only 401 is re-keyed below from `Unauthorized` to
   * `ConfigurationError` so a bad/missing key fails loud as misconfiguration
   * rather than "no data".
   */
  private request<T>(
    path: string,
    params: Record<string, string>,
    operation: string,
    ctx: RequestContextLike,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('token', this.apiKey);
    const signal = (ctx as { signal?: AbortSignal }).signal;

    return withRetry(
      async () => {
        try {
          const response = await fetchWithTimeout(url.toString(), REQUEST_TIMEOUT_MS, ctx, {
            headers: { Accept: 'application/json' },
            ...(signal && { signal }),
          });
          return (await response.json()) as T;
        } catch (err) {
          throw this.reclassify(err, operation, path);
        }
      },
      {
        operation: `FinnhubService.${operation}`,
        context: ctx,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        ...(signal && { signal }),
      },
    );
  }

  /**
   * Re-key a thrown `McpError` so a 401 (which `fetchWithTimeout` classifies as
   * `Unauthorized`) becomes a `ConfigurationError` — a bad/missing Finnhub key
   * is a misconfiguration that should fail loud, not a per-request auth failure.
   * Every other error passes through unchanged: `Forbidden` (403),
   * `RateLimited` (429), and `ServiceUnavailable` (5xx/network) already match
   * the design's classification table.
   */
  private reclassify(err: unknown, operation: string, path: string): unknown {
    if (err instanceof McpError && err.code === JsonRpcErrorCode.Unauthorized) {
      return configurationError(
        'Finnhub rejected the API key (HTTP 401). Set a valid FINNHUB_API_KEY from https://finnhub.io/register.',
        { operation, path },
        { cause: err },
      );
    }
    return err;
  }
}

// --- Init/accessor pattern ---

let _service: FinnhubService | undefined;

/**
 * Initialize the singleton. Called from `createApp`'s `setup()`. The
 * `(config, storage)` signature matches the framework's `setup(core)` call
 * convention; this service reads its own config via `getServerConfig()` and
 * holds no tenant state, so neither is retained.
 */
export function initFinnhubService(_config: AppConfig, _storage: StorageService): void {
  _service = new FinnhubService();
}

/** Access the singleton. Throws if `setup()` did not initialize it. */
export function getFinnhubService(): FinnhubService {
  if (!_service) {
    throw new Error('FinnhubService not initialized — call initFinnhubService() in setup()');
  }
  return _service;
}
