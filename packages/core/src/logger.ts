import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

/** Object keys whose values never reach a log line, at any depth. */
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
  'encryptedSecret',
  'encrypted_secret',
  'plaintext',
  'masterKey',
  'master_key',
];

const CENSOR = '[REDACTED]';
const SECRET_KEY_SET = new Set(SECRET_KEYS.map((key) => key.toLowerCase()));
const MAX_REDACT_DEPTH = 10;

/**
 * Pino path redaction for fields that serializers produce after the log
 * formatter runs (Fastify's `req`/`res`), plus the configured secret keys
 * at the top level and one level deep.
 */
export const REDACT_PATHS: readonly string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a copy of `value` with every secret key replaced, at any depth.
 * Only plain objects and arrays are walked, so errors and class instances
 * keep their own serializers. Cycles and very deep nesting are cut off.
 */
export function redactSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_REDACT_DEPTH) return '[Truncated]';
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redactSecrets(item, depth + 1, seen));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = SECRET_KEY_SET.has(key.toLowerCase())
        ? CENSOR
        : redactSecrets(item, depth + 1, seen);
    }
    result = copy;
  }
  seen.delete(value);
  return result;
}

const redactRecord = (record: Record<string, unknown>) =>
  redactSecrets(record) as Record<string, unknown>;

export interface LoggerOptions {
  name: string;
  level?: LevelWithSilent;
  destination?: DestinationStream;
}

export function createLogger({ name, level = 'info', destination }: LoggerOptions): Logger {
  const options = {
    name,
    level,
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    // Deep redaction covers each log call's object. Child logger bindings only
    // get REDACT_PATHS (pino skips formatters for them): bind IDs, not secrets.
    formatters: { log: redactRecord },
  };
  return destination ? pino(options, destination) : pino(options);
}
