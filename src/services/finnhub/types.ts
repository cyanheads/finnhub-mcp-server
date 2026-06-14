/**
 * @fileoverview Raw upstream response shapes for the Finnhub REST API (v1).
 * One type per endpoint the service calls, mirroring the verified live payloads
 * (probed 2026-06-13). Fields the free tier may omit are optional/nullable so
 * normalization preserves absence as "unknown" rather than fabricating values.
 * @module services/finnhub/types
 */

/** A single match from `GET /search`. */
export interface FinnhubSearchMatch {
  description: string;
  displaySymbol: string;
  symbol: string;
  /** Security type, e.g. "Common Stock", "ETP". Finnhub returns "" when unknown. */
  type: string;
}

/** `GET /search?q={query}`. */
export interface FinnhubSearchResponse {
  count: number;
  result: FinnhubSearchMatch[];
}

/**
 * `GET /quote?symbol={symbol}`. An unknown US symbol returns the all-zero
 * sentinel `{c:0, d:null, dp:null, h:0, l:0, o:0, pc:0, t:0}` at HTTP 200 —
 * `d`/`dp` are null, `c`/`t` are zero.
 */
export interface FinnhubQuote {
  /** Current price. */
  c: number;
  /** Change vs. previous close. Null in the unknown-symbol sentinel. */
  d: number | null;
  /** Percent change vs. previous close. Null in the sentinel. */
  dp: number | null;
  /** Session high. */
  h: number;
  /** Session low. */
  l: number;
  /** Session open. */
  o: number;
  /** Previous close. */
  pc: number;
  /** Quote time, Unix epoch seconds. Zero in the sentinel. */
  t: number;
}

/** `GET /stock/market-status?exchange={exchange}`. */
export interface FinnhubMarketStatus {
  exchange: string;
  holiday: string | null;
  isOpen: boolean;
  session: string | null;
  t: number;
  timezone: string;
}

/**
 * `GET /stock/profile2?symbol={symbol}`. An unknown symbol returns `{}`, so
 * every field is optional — presence of `name`/`ticker` distinguishes a real
 * profile from the empty sentinel.
 */
export interface FinnhubProfile {
  country?: string;
  currency?: string;
  estimateCurrency?: string;
  exchange?: string;
  finnhubIndustry?: string;
  floatingShare?: number;
  ipo?: string;
  logo?: string;
  marketCapitalization?: number;
  name?: string;
  phone?: string;
  shareOutstanding?: number;
  ticker?: string;
  weburl?: string;
}

/**
 * `GET /stock/metric?symbol={symbol}&metric=all`. The `metric` object carries
 * ~100 keys; only the curated subset surfaced by `finnhub_get_company` is typed
 * here. Every value is optional — Finnhub omits metrics for thinly-covered
 * names.
 */
export interface FinnhubMetricResponse {
  metric?: {
    peTTM?: number;
    epsTTM?: number;
    '52WeekHigh'?: number;
    '52WeekLow'?: number;
    beta?: number;
    currentDividendYieldTTM?: number;
    netProfitMarginTTM?: number;
    grossMarginTTM?: number;
    revenueGrowthTTMYoy?: number;
    roeTTM?: number;
    [key: string]: number | string | undefined;
  };
  metricType?: string;
  symbol?: string;
}

/** A single quarter from `GET /stock/earnings`. */
export interface FinnhubEarning {
  actual: number | null;
  estimate: number | null;
  period: string;
  quarter: number;
  surprise: number | null;
  surprisePercent: number | null;
  symbol: string;
  year: number;
}

/** A single entry from `GET /calendar/earnings`. */
export interface FinnhubEarningsCalendarEntry {
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  /** "bmo" (before open) / "amc" (after close) / "" when unknown. */
  hour: string;
  quarter: number;
  revenueActual: number | null;
  revenueEstimate: number | null;
  symbol: string;
  year: number;
}

/** `GET /calendar/earnings?from={from}&to={to}`. */
export interface FinnhubEarningsCalendar {
  earningsCalendar: FinnhubEarningsCalendarEntry[];
}

/** A single article from `GET /company-news` or `GET /news`. */
export interface FinnhubNewsArticle {
  category?: string;
  datetime: number;
  headline: string;
  id?: number;
  image?: string;
  related?: string;
  source: string;
  summary?: string;
  url: string;
}

/** A single month from `GET /stock/recommendation`. */
export interface FinnhubRecommendation {
  buy: number;
  hold: number;
  period: string;
  sell: number;
  strongBuy: number;
  strongSell: number;
  symbol: string;
}
