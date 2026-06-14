/**
 * @fileoverview Tests for the finnhub://news-categories resource.
 * @module tests/mcp-server/resources/definitions/news-categories.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { newsCategoriesResource } from '@/mcp-server/resources/definitions/news-categories.resource.js';

describe('newsCategoriesResource', () => {
  it('returns the four valid market-news categories', async () => {
    const ctx = createMockContext();
    const params = newsCategoriesResource.params.parse({});
    const result = await newsCategoriesResource.handler(params, ctx);

    const ids = result.categories.map((c) => c.id);
    expect(ids).toEqual(['general', 'forex', 'crypto', 'merger']);
    for (const c of result.categories) {
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('lists itself as a readable resource', async () => {
    const listing = await newsCategoriesResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]?.uri).toBe('finnhub://news-categories');
  });
});
