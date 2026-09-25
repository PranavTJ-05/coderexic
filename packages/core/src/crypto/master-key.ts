/**
 * BYOK master keys (PRODUCT_SPEC.md §13, DATA_MODEL.md): the key that
 * encrypts a stored provider credential comes from outside the DB, never
 * from a column. Keys are versioned so a compromised or rotated key doesn't
 * invalidate every stored credential at once - `model_credentials.key_version`
 * records which master-key version encrypted that row.
 */

export class MasterKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyConfigError';
  }
}

export type MasterKeyMap = ReadonlyMap<number, Buffer>;

/**
 * Parses `MODEL_CREDENTIALS_MASTER_KEYS`: a JSON object mapping a key
 * version (string, e.g. `"1"`) to a base64-encoded 32-byte AES-256 key
 * (e.g. `openssl rand -base64 32`). Every key is validated to be exactly 32
 * bytes - a wrong-length key fails loudly at startup rather than failing
 * opaquely on the first encrypt/decrypt call.
 */
export function parseMasterKeyMap(raw: string): MasterKeyMap {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MasterKeyConfigError('MODEL_CREDENTIALS_MASTER_KEYS is not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new MasterKeyConfigError(
      'MODEL_CREDENTIALS_MASTER_KEYS must be a JSON object of version -> base64 key',
    );
  }
  const map = new Map<number, Buffer>();
  for (const [versionStr, value] of Object.entries(json)) {
    const version = Number(versionStr);
    if (!Number.isInteger(version) || version < 1) {
      throw new MasterKeyConfigError(
        `MODEL_CREDENTIALS_MASTER_KEYS key "${versionStr}" is not a positive integer version`,
      );
    }
    if (typeof value !== 'string') {
      throw new MasterKeyConfigError(
        `MODEL_CREDENTIALS_MASTER_KEYS version ${version} is not a string`,
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(value, 'base64');
    } catch {
      throw new MasterKeyConfigError(
        `MODEL_CREDENTIALS_MASTER_KEYS version ${version} is not valid base64`,
      );
    }
    if (key.length !== 32) {
      throw new MasterKeyConfigError(
        `MODEL_CREDENTIALS_MASTER_KEYS version ${version} must decode to 32 bytes (got ${key.length})`,
      );
    }
    map.set(version, key);
  }
  if (map.size === 0) {
    throw new MasterKeyConfigError('MODEL_CREDENTIALS_MASTER_KEYS has no entries');
  }
  return map;
}

export function getMasterKey(keys: MasterKeyMap, version: number): Buffer {
  const key = keys.get(version);
  if (!key) {
    throw new MasterKeyConfigError(`no master key configured for version ${version}`);
  }
  return key;
}
