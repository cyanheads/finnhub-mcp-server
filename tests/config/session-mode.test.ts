/**
 * @fileoverview Session-mode coverage: the configuration artifacts that declare
 * the intended stateless HTTP posture, and the precedence regression for the
 * `createApp({ sessionMode })` declaration in `src/index.ts` — the declared
 * default applies when `MCP_SESSION_MODE` supplies nothing meaningful, and an
 * explicit environment value still wins over it.
 * @module tests/config/session-mode.test
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** An install-time `${…}` reference nothing substituted — assembled so it is not one here. */
const UNSUBSTITUTED_PLACEHOLDER = `\${${'user_config.session_mode'}}`;

/** Booting the entrypoint and polling the status route costs more than the 5 s default. */
const BOOT_TIMEOUT_MS = 30_000;

/** A loopback port the OS just confirmed is free. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('probe socket reported no port')));
        return;
      }
      probe.close(() => resolvePort(address.port));
    });
  });
}

/**
 * Boots `src/index.ts` over HTTP and reads the resolved session mode off the
 * `GET /mcp` status route — the surface that reports what the transport actually
 * runs with, so the assertion covers the declaration rather than the source text.
 *
 * `MCP_SESSION_MODE` is deleted before `sessionMode` is applied, so "unset"
 * means unset regardless of what the parent environment carries.
 */
async function resolvedSessionMode(sessionMode: string | undefined): Promise<string> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: String(port),
    MCP_LOG_LEVEL: 'error',
    FINNHUB_API_KEY: 'test-key',
  };
  delete env.MCP_SESSION_MODE;
  if (sessionMode !== undefined) env.MCP_SESSION_MODE = sessionMode;

  const child = spawn('bun', ['src/index.ts'], { env, stdio: 'ignore' });
  running.push(child);

  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`);
      if (response.ok) {
        const status = (await response.json()) as { server: { sessionMode: string } };
        return status.server.sessionMode;
      }
    } catch {
      // Connection refused until the transport binds; keep polling.
    }
    await new Promise((tick) => setTimeout(tick, 100));
  }
  throw new Error(`server never answered on port ${port}`);
}

const running: ReturnType<typeof spawn>[] = [];

describe('session mode configuration', () => {
  afterEach(() => {
    for (const child of running.splice(0)) child.kill();
  });

  it('keeps the environment example and Docker image explicitly stateless', async () => {
    const [envExample, dockerfile] = await Promise.all([
      readFile(resolve('.env.example'), 'utf8'),
      readFile(resolve('Dockerfile'), 'utf8'),
    ]);

    expect(envExample).toMatch(/^MCP_SESSION_MODE=stateless$/m);
    expect(envExample).toContain('auto | stateful | stateless');
    expect(dockerfile).toContain('ENV MCP_SESSION_MODE="stateless"');
  });

  it(
    'serves the declared stateless default when MCP_SESSION_MODE is unset',
    async () => {
      // Not `stateful` — the framework schema default is `auto`, which resolves there.
      expect(await resolvedSessionMode(undefined)).toBe('stateless');
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'yields to an explicit MCP_SESSION_MODE',
    async () => {
      expect(await resolvedSessionMode('stateful')).toBe('stateful');
    },
    BOOT_TIMEOUT_MS,
  );

  it.each([
    ['an empty string', ''],
    ['an unsubstituted placeholder', UNSUBSTITUTED_PLACEHOLDER],
  ])(
    'falls through to the declared default when MCP_SESSION_MODE is %s',
    async (_label, value) => {
      expect(await resolvedSessionMode(value)).toBe('stateless');
    },
    BOOT_TIMEOUT_MS,
  );
});
