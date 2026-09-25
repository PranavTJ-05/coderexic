import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialDecryptError,
  credentialAad,
  decryptCredential,
  encryptCredential,
} from './credential-crypto.js';
import { MasterKeyConfigError, parseMasterKeyMap } from './master-key.js';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');
const masterKeys = parseMasterKeyMap(JSON.stringify({ '1': KEY_V1, '2': KEY_V2 }));

const aad = credentialAad({ userId: 'user-1', repositoryId: 'repo-1', provider: 'openai' });

describe('parseMasterKeyMap', () => {
  it('parses a version -> base64 32-byte key map', () => {
    expect(masterKeys.get(1)?.length).toBe(32);
    expect(masterKeys.get(2)?.length).toBe(32);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseMasterKeyMap('not json')).toThrow(MasterKeyConfigError);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() =>
      parseMasterKeyMap(JSON.stringify({ '1': Buffer.from('short').toString('base64') })),
    ).toThrow(MasterKeyConfigError);
  });

  it('rejects a non-integer version', () => {
    expect(() => parseMasterKeyMap(JSON.stringify({ x: KEY_V1 }))).toThrow(MasterKeyConfigError);
  });

  it('rejects an empty map', () => {
    expect(() => parseMasterKeyMap('{}')).toThrow(MasterKeyConfigError);
  });
});

describe('encryptCredential / decryptCredential', () => {
  it('round-trips a plaintext secret', () => {
    const encrypted = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    expect(decryptCredential(masterKeys, 1, encrypted, aad)).toBe('sk-super-secret');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    const b = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    expect(a).not.toBe(b);
  });

  it('never leaks the plaintext in the encrypted output', () => {
    const encrypted = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    expect(encrypted).not.toContain('sk-super-secret');
  });

  it('decrypts with the key version it was encrypted under, not the current default', () => {
    const encrypted = encryptCredential(masterKeys, 1, 'sk-old', aad);
    expect(decryptCredential(masterKeys, 1, encrypted, aad)).toBe('sk-old');
  });

  it('fails to decrypt under the wrong key version', () => {
    const encrypted = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    expect(() => decryptCredential(masterKeys, 2, encrypted, aad)).toThrow(CredentialDecryptError);
  });

  it('fails to decrypt with mismatched AAD (row-binding: wrong user/repo/provider)', () => {
    const encrypted = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    const otherAad = credentialAad({
      userId: 'user-2',
      repositoryId: 'repo-1',
      provider: 'openai',
    });
    expect(() => decryptCredential(masterKeys, 1, encrypted, otherAad)).toThrow(
      CredentialDecryptError,
    );
  });

  it('fails to decrypt tampered ciphertext', () => {
    const encrypted = encryptCredential(masterKeys, 1, 'sk-super-secret', aad);
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptCredential(masterKeys, 1, bytes.toString('base64'), aad)).toThrow(
      CredentialDecryptError,
    );
  });

  it('handles a null repositoryId in the AAD (user-level credential)', () => {
    const userAad = credentialAad({ userId: 'user-1', repositoryId: null, provider: 'groq' });
    const encrypted = encryptCredential(masterKeys, 1, 'sk-user-level', userAad);
    expect(decryptCredential(masterKeys, 1, encrypted, userAad)).toBe('sk-user-level');
  });
});
