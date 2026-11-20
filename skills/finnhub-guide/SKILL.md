---
name: finnhub-guide
description: Build company and earnings briefings with finnhub_* tools, preserving security identity, quote freshness, and endpoint coverage. Use when combining prices, fundamentals, earnings, news, or analyst recommendations, or investigating missing data across these tools.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use Finnhub for current equity context and financial news. This surface does not provide historical price candles or FX rates; forex and crypto news categories do not imply pricing tools.

## Identifiers

For an unfamiliar company or ambiguous ticker, select the intended security from `finnhub_search_symbols` using its name and security type, then carry the returned `symbol` through the briefing. Exact ticker matches can include several securities. For a US listing, try the US exchange filter. If a company-name search misses an ADR, try its ticker or a global search. Preserve class-share punctuation. Check endpoint coverage separately from the `isLikelyUS` symbol-format heuristic.

## Gates

- Before concluding that data is absent, establish the intended security and name the endpoint and window checked. An empty company-news window, empty earnings calendar, and missing analyst recommendations do not establish that the security is invalid or that no information exists elsewhere.
- Before interpreting missing fundamentals or peers, inspect `partial`. A failed component is unavailable; a null metric is not zero. A quote succeeding does not establish company-profile or analyst coverage for that security, including a fund or trust.
- Before describing a price as current, retain its quote timestamp and market-status context. A false `priceIsLive` alone does not establish a prior-close timestamp; unavailable market status means freshness is unknown. Preserve returned session and holiday information.
- For a calendar or company-news window, compare the dates you requested with the earliest and latest records Finnhub supplied. Follow `nextOffset` using the same filters to read further into that fetched set. Each call retrieves fresh data, so records can shift between pages. For older coverage, query an earlier window. Even a company-news response below 250 articles can omit an entire requested day.

## Workflows

**Company or earnings briefing.** Resolve the security, then use `finnhub_get_quote` and `finnhub_get_company` for price and business context. To check a recent revenue beat or miss, query the earnings calendar by symbol around the release date. Compare reported revenue with the estimate on the same row when both are available. For quarterly EPS surprises, use earnings history. Keep release dates, fiscal periods, quote timestamps, article publication times, and analyst recommendation periods attached to their respective claims.

**Missing data.** Recheck identity before changing the question. Distinguish access denial, an unavailable component, and an empty endpoint result. Widen an empty news or calendar window when the task calls for it; use earnings history to investigate past results. Report the narrow outcome, such as “Finnhub returned no calendar entries for this company in this window,” rather than inferring no scheduled earnings or no company coverage.

**Peer comparison.** Use the default sub-industry grouping for close competitors. Request `sector` for a broader comparison and record the grouping alongside the results. Exclude the queried security itself, fetch the selected peers' company context, and preserve missing values and failed components.
