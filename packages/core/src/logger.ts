import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

/**
 * Field paths whose values are replaced before a log line is written.
 * Covers top-level and one level of nesting (pino wildcards match one level),
 * plus the HTTP headers that carry credentials or signatures.
 */
const SECRET_KEYS = [
  'authorization',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'privateKey',
  'private_key',
  'clientSecret',
  'webhookSecret',
  'encryptionKey',
];

export const REDACT_PATHS: readonly string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  name: string;
  level?: LevelWithSilent;
  destination?: DestinationStream;
}

export function createLogger({ name, level = 'info', destination }: LoggerOptions): Logger {
  const options = {
    name,
    level,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
