---
name: finnhub-guide
description: Build company and earnings briefings with finnhub_* tools, preserving security identity, quote freshness, and endpoint coverage. Use when combining prices, fundamentals, earnings, news, or analyst recommendations, or investigating missing data across these tools.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Finnhub for current equity context and financial news. This surface does not provide historical price candles or FX rates; forex and crypto news categories do not imply pricing tools.

## Identifiers

For an unfamiliar company or ambiguous ticker, select the intended security from `finnhub_search_symbols` using its name and security type, then carry the returned `symbol` through the briefing. Do not substitute its display label or rewrite class-share punctuation. `isLikelyUS` is a symbol-format heuristic; a successful search does not establish access to every endpoint.

## Gates

- Before concluding that data is absent, establish the intended security and name the endpoint and window checked. An empty company-news window, empty earnings calendar, and missing analyst recommendations do not establish that the security is invalid or that no information exists elsewhere.
- Before interpreting missing fundamentals or peers, inspect `partial`. A failed component is unavailable; a null metric is not zero. A quote succeeding does not establish company-profile or analyst coverage for that security, including a fund or trust.
- Before describing a price as current, retain its quote timestamp and market-status context. A false `priceIsLive` alone does not establish a prior-close timestamp; unavailable market status means freshness is unknown. Preserve returned session and holiday information.
- Before claiming a list is complete, inspect truncation and totals. Increasing a limit can expose more of the fetched response, not establish exhaustive historical coverage. Do not promise a fixed depth of analyst history.

## Workflows

**Company or earnings briefing.** Resolve the security, then use `finnhub_get_quote` and `finnhub_get_company` for price and business context. For a company's next release, use its symbol with `finnhub_get_earnings` calendar mode; use history separately for reported EPS and surprises. Add `finnhub_get_news` company news for the relevant event window and `finnhub_get_recommendations` when analyst context is needed. Keep quote timestamps, fiscal periods, expected release dates, article publication times, and recommendation periods attached to their respective claims.

**Missing data.** Recheck identity before changing the question. Distinguish access denial, an unavailable component, and an empty endpoint result. Widen an empty news or calendar window when the task calls for it; use earnings history to investigate past results. Report the narrow outcome, such as “Finnhub returned no calendar entries for this company in this window,” rather than inferring no scheduled earnings or no company coverage.

**Peer comparison.** Start from the company response's peer symbols and exclude the queried security itself. Fetch the chosen peers' company context before comparing fundamentals; preserve missing values and failed components in the comparison.
