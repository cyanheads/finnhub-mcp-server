/**
 * @fileoverview Pages a sorted Finnhub response and reports its fetched bounds.
 * @module mcp-server/tools/definitions/window-page
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';

/** Bounds and continuation for a paged, date-windowed tool response. */
export const windowPageEnrichment = {
  fetchedFrom: z.string().optional().describe('Earliest date or timestamp among all fetched rows.'),
  fetchedTo: z.string().optional().describe('Latest date or timestamp among all fetched rows.'),
  nextOffset: z
    .number()
    .int()
    .optional()
    .describe('Offset for the next page of fetched rows. Each page refetches upstream data.'),
};

/** Slice the already sorted rows, preserving upstream warnings alongside paging guidance. */
export function pageWindow<T>(
  rows: T[],
  input: { limit: number; offset?: number | undefined },
  ctx: Pick<Context, 'enrich'>,
  coverage?: { fetchedFrom: string; fetchedTo: string; warning?: string },
): T[] {
  const offset = input.offset ?? 0;
  const page = rows.slice(offset, offset + input.limit);
  ctx.enrich.total(rows.length);
  if (coverage) {
    ctx.enrich({ fetchedFrom: coverage.fetchedFrom, fetchedTo: coverage.fetchedTo });
  }

  const nextOffset = offset + page.length;
  if (nextOffset < rows.length) {
    const continuation = `Use offset ${nextOffset} with the same query to continue through the fetched rows.`;
    ctx.enrich({ nextOffset });
    ctx.enrich.truncated({
      shown: page.length,
      cap: input.limit,
      guidance: coverage?.warning ? `${coverage.warning} ${continuation}` : continuation,
    });
  } else if (coverage?.warning) {
    ctx.enrich.notice(coverage.warning);
  }
  return page;
}
