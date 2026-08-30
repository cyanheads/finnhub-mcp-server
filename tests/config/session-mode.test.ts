/**
 * @fileoverview Configuration artifact checks for the intended stateless HTTP posture.
 * @module tests/config/session-mode.test
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('session mode configuration', () => {
  it('keeps the environment example and Docker image explicitly stateless', async () => {
    const [envExample, dockerfile] = await Promise.all([
      readFile(resolve('.env.example'), 'utf8'),
      readFile(resolve('Dockerfile'), 'utf8'),
    ]);

    expect(envExample).toMatch(/^MCP_SESSION_MODE=stateless$/m);
    expect(envExample).toContain('auto | stateful | stateless');
    expect(dockerfile).toContain('ENV MCP_SESSION_MODE="stateless"');
  });
});
