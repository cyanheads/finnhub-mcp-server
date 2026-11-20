/**
 * @fileoverview Resolves and validates the UTC date bounds passed to Finnhub.
 * @module services/finnhub/date-window
 */

import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const isoDate = z.iso.date();
const DAY_MS = 86_400_000;

/** Resolve empty or omitted bounds relative to today, then validate the effective window. */
export function dateWindow(
  input: { from?: string | undefined; to?: string | undefined },
  fromDays: number,
  toDays: number,
): { from: string; to: string } {
  const now = Date.now();
  const from = input.from || new Date(now + fromDays * DAY_MS).toISOString().slice(0, 10);
  const to = input.to || new Date(now + toDays * DAY_MS).toISOString().slice(0, 10);

  for (const [field, value] of Object.entries({ from, to })) {
    if (!isoDate.safeParse(value).success) {
      throw validationError(
        `${field} must be a real YYYY-MM-DD date, received ${JSON.stringify(value)}.`,
        {
          reason: 'invalid_date',
          field,
          value,
        },
      );
    }
  }
  if (from > to) {
    throw validationError(`Start date ${from} must be on or before end date ${to}.`, {
      reason: 'inverted_date_window',
      from,
      to,
    });
  }
  return { from, to };
}
