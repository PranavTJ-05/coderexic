import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './signature.js';

const secret = 'test-webhook-secret-0123456789';
const body = Buffer.from('{"action":"opened"}');

describe('verifyWebhookSignature', () => {
  it('accepts a signature made with the same secret over the same bytes', () => {
    expect(verifyWebhookSignature(secret, body, signWebhookPayload(secret, body))).toBe(true);
  });

  it('matches the HMAC from GitHub documentation', () => {
    // https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(
      verifyWebhookSignature("It's a Secret to Everybody", Buffer.from('Hello, World!'), header),
    ).toBe(true);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['sha1 prefix', signWebhookPayload(secret, body).replace('sha256=', 'sha1=')],
    ['wrong secret', signWebhookPayload('another-secret-0123456789', body)],
    ['truncated signature', signWebhookPayload(secret, body).slice(0, -2)],
    ['non-hex signature', 'sha256=' + 'z'.repeat(64)],
  ])('rejects a %s', (_label, header) => {
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it('rejects a body changed after signing', () => {
    const header = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, Buffer.from('{"action":"closed"}'), header)).toBe(false);
  });
});
