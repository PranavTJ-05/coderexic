import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getMasterKey, type MasterKeyMap } from './master-key.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDecryptError';
  }
}

/**
 * Binds a ciphertext to the DB row it belongs to, as AES-GCM additional
 * authenticated data: copying `encrypted_secret` into a different row (a
 * different user, repo, or provider) makes decryption fail instead of
 * silently succeeding with the wrong plaintext (PRODUCT_SPEC.md §17.10, no
 * cross-user leakage).
 */
export function credentialAad(input: {
  userId: string;
  repositoryId: string | null;
  provider: string;
}): Buffer {
  return Buffer.from(`${input.userId}|${input.repositoryId ?? ''}|${input.provider}`, 'utf8');
}

/**
 * Encrypts a plaintext provider API key under the given master-key version.
 * Returns a single base64 string (`iv | authTag | ciphertext`) suitable for
 * `model_credentials.encrypted_secret`.
 */
export function encryptCredential(
  masterKeys: MasterKeyMap,
  keyVersion: number,
  plaintext: string,
  aad: Buffer,
): string {
  const key = getMasterKey(masterKeys, keyVersion);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypts a stored `encrypted_secret`. The only function in this module
 * that returns plaintext - callers must be the single internal
 * "decrypt-for-provider-call" path (`db/store/model-credentials.ts`'s
 * `resolveDecryptedCredential`), never a store CRUD function that returns
 * row metadata to a caller outside the crypto/store boundary.
 */
export function decryptCredential(
  masterKeys: MasterKeyMap,
  keyVersion: number,
  encryptedSecret: string,
  aad: Buffer,
): string {
  const key = getMasterKey(masterKeys, keyVersion);
  const raw = Buffer.from(encryptedSecret, 'base64');
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new CredentialDecryptError('encrypted_secret is too short to contain an iv and auth tag');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  decipher.setAAD(aad);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialDecryptError(
      'credential decryption failed (wrong key, wrong AAD, or tampered ciphertext)',
    );
  }
}
