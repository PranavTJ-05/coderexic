import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, lines, records };
}

describe('createLogger', () => {
  it('writes structured JSON with the service name', () => {
    const out = capture();
    const logger = createLogger({ name: 'test-service', destination: out.stream });
    logger.info({ reviewId: 'r-1' }, 'hello');
    expect(out.records()[0]).toMatchObject({ name: 'test-service', msg: 'hello', reviewId: 'r-1' });
  });

  it('redacts secrets at the top level and one level deep', () => {
    const out = capture();
    const logger = createLogger({ name: 't', destination: out.stream });
    logger.info(
      {
        apiKey: 'sk-top-level-secret',
        provider: { apiKey: 'sk-nested-secret', name: 'gemini' },
        github: { privateKey: '-----BEGIN RSA PRIVATE KEY-----', appId: 42 },
      },
      'calling provider',
    );
    const raw = out.lines.join('');
    expect(raw).not.toContain('sk-top-level-secret');
    expect(raw).not.toContain('sk-nested-secret');
    expect(raw).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out.records()[0]).toMatchObject({
      apiKey: '[REDACTED]',
      provider: { apiKey: '[REDACTED]', name: 'gemini' },
      github: { privateKey: '[REDACTED]', appId: 42 },
    });
  });

  it('redacts secrets at any depth and inside arrays', () => {
    const out = capture();
    const logger = createLogger({ name: 't', destination: out.stream });
    logger.info({
      request: { body: { credentials: { apiKey: 'sk-deeply-nested', provider: 'gemini' } } },
      keys: [{ ApiKey: 'sk-in-array-mixed-case' }],
    });
    const raw = out.lines.join('');
    expect(raw).not.toContain('sk-deeply-nested');
    expect(raw).not.toContain('sk-in-array-mixed-case');
    expect(out.records()[0]).toMatchObject({
      request: { body: { credentials: { apiKey: '[REDACTED]', provider: 'gemini' } } },
    });
  });

  it('redacts secret keys in child logger bindings', () => {
    const out = capture();
    const logger = createLogger({ name: 't', destination: out.stream }).child({
      token: 'child-top-secret',
      github: { privateKey: 'child-nested-secret', appId: 42 },
    });
    logger.info('bound');
    const raw = out.lines.join('');
    expect(raw).not.toContain('child-top-secret');
    expect(raw).not.toContain('child-nested-secret');
    expect(out.records()[0]).toMatchObject({ github: { appId: 42 } });
  });

  it('handles circular objects and keeps errors serialized', () => {
    const out = capture();
    const logger = createLogger({ name: 't', destination: out.stream });
    const loop: Record<string, unknown> = { token: 'loop-secret' };
    loop.self = loop;
    logger.error({ loop, err: new Error('boom') }, 'failed');
    const record = out.records()[0];
    expect(record).toMatchObject({ loop: { token: '[REDACTED]', self: '[Circular]' } });
    expect(record?.err).toMatchObject({ message: 'boom', type: 'Error' });
  });

  it('redacts credential and signature headers on requests', () => {
    const out = capture();
    const logger = createLogger({ name: 't', destination: out.stream });
    logger.info({
      req: {
        headers: {
          authorization: 'Bearer ghs_installation_token',
          'x-hub-signature-256': 'sha256=abc123',
          'user-agent': 'GitHub-Hookshot',
        },
      },
    });
    const raw = out.lines.join('');
    expect(raw).not.toContain('ghs_installation_token');
    expect(raw).not.toContain('sha256=abc123');
    expect(raw).toContain('GitHub-Hookshot');
  });

  it('respects the configured level', () => {
    const out = capture();
    const logger = createLogger({ name: 't', level: 'warn', destination: out.stream });
    logger.info('dropped');
    logger.warn('kept');
    expect(out.records().map((r) => r.msg)).toEqual(['kept']);
  });
});
