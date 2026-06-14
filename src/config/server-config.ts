/**
 * @fileoverview Server-specific configuration for finnhub-mcp-server.
 * Lazy-parsed Zod schema, separate from the framework's core config. Maps the
 * server's domain env vars (`FINNHUB_API_KEY`, `FINNHUB_BASE_URL`) so a missing
 * or invalid value fails loudly at startup, naming the variable.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Domain configuration schema. `apiKey` is required — the server cannot reach
 * Finnhub without it. `baseUrl` is overridable for local testing or a proxy.
 */
const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe(
      'Finnhub API key from https://finnhub.io/register. Required — server fails to start without it. Free tier: 60 req/min, US real-time.',
    ),
  baseUrl: z
    .string()
    .default('https://finnhub.io/api/v1')
    .describe('Finnhub REST API base URL. Override for local testing or a proxy.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server configuration. Reads env vars via the
 * framework's `parseEnvConfig` so a validation failure names the variable
 * (`FINNHUB_API_KEY`) rather than the schema path.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'FINNHUB_API_KEY',
    baseUrl: 'FINNHUB_BASE_URL',
  });
  return _config;
}
