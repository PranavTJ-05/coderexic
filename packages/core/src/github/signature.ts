import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
/**
 * Exactly 64 hex characters (a SHA-256 digest). `Buffer.from(s, 'hex')`
 * silently stops decoding at the first invalid character rather than
 * erroring, so `sha256=<64 valid hex chars>zzz` would otherwise decode to
 * the same 32 bytes as the valid signature and could pass the length check
 * below for the wrong reason - this guards the exact shape instead of
 * relying on the decoded length alone (ROADMAP.md Phase 16).
 */
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Verifies GitHub's `X-Hub-Signature-256` header: an HMAC-SHA256 of the exact
 * request bytes, keyed with the webhook secret. Constant-time comparison.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith(PREFIX)) return false;
  const digest = signatureHeader.slice(PREFIX.length);
  if (!HEX_DIGEST_PATTERN.test(digest)) return false;
  const received = Buffer.from(digest, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  // Lengths always match now that the shape is validated above; kept as a
  // defensive guard before timingSafeEqual, which throws on a mismatch.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Produces a signature header value; used by tests and local tooling. */
export function signWebhookPayload(secret: string, rawBody: Buffer | string): string {
  return PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}
