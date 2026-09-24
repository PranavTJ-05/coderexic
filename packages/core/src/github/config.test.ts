import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvValidationError } from '../env.js';
import { loadGitHubAppCredentials } from './config.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function keyFile(mode: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'coderexic-')), 'app.pem');
  writeFileSync(path, privateKey);
  chmodSync(path, mode);
  return path;
}

describe('loadGitHubAppCredentials', () => {
  it('reads the private key from a file', () => {
    const creds = loadGitHubAppCredentials({
      GITHUB_APP_ID: '123',
      GITHUB_PRIVATE_KEY_PATH: keyFile(0o600),
    });
    expect(creds).toEqual({ appId: 123, privateKey });
  });

  it('warns when the key file is readable by other users', () => {
    const warnings: string[] = [];
    loadGitHubAppCredentials(
      { GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY_PATH: keyFile(0o644) },
      (message) => warnings.push(message),
    );
    expect(warnings).toEqual([expect.stringContaining('chmod 600')]);
  });

  it('accepts an inline key with escaped newlines', () => {
    const inline = privateKey.replace(/\n/g, '\\n');
    expect(
      loadGitHubAppCredentials({ GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: inline }).privateKey,
    ).toBe(privateKey);
  });

  it('requires one of the key variables', () => {
    expect(() => loadGitHubAppCredentials({ GITHUB_APP_ID: '1' })).toThrow(/GITHUB_PRIVATE_KEY/);
  });

  it('rejects content that is not a PEM key without echoing it', () => {
    let error: unknown;
    try {
      loadGitHubAppCredentials({
        GITHUB_APP_ID: '1',
        GITHUB_PRIVATE_KEY: 'super-secret-not-a-key',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect(String(error)).not.toContain('super-secret-not-a-key');
  });

  it('reports an unreadable key file by variable name', () => {
    expect(() =>
      loadGitHubAppCredentials({
        GITHUB_APP_ID: '1',
        GITHUB_PRIVATE_KEY_PATH: '/nonexistent/app.pem',
      }),
    ).toThrow(/GITHUB_PRIVATE_KEY_PATH: file cannot be read/);
  });

  it('rejects a non-numeric app ID', () => {
    expect(() =>
      loadGitHubAppCredentials({ GITHUB_APP_ID: 'abc', GITHUB_PRIVATE_KEY: privateKey }),
    ).toThrow(/GITHUB_APP_ID/);
  });
});
