/**
 * @fileoverview Preserve dependency runtime modules while pruning package-root agent docs.
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleanerPattern } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linterPattern } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation selectors', () => {
  for (const pattern of [cleanerPattern, linterPattern]) {
    it('preserves SDK skills runtime modules', () => {
      expect(
        pattern.test('node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js'),
      ).toBe(false);
      expect(pattern.test('node_modules/unscoped/dist/skills/loader.js')).toBe(false);
    });

    it('removes package-root development and agent skill trees', () => {
      expect(
        pattern.test('node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md'),
      ).toBe(true);
      expect(pattern.test('node_modules/unscoped/skills/example/SKILL.md')).toBe(true);
      expect(pattern.test('node_modules/unscoped/.claude/skills/example/SKILL.md')).toBe(true);
    });
  }
});
