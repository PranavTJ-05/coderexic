import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

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
  const received = Buffer.from(signatureHeader.slice(PREFIX.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  // A non-hex or truncated signature decodes to a different length.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Produces a signature header value; used by tests and local tooling. */
export function signWebhookPayload(secret: string, rawBody: Buffer | string): string {
  return PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}
