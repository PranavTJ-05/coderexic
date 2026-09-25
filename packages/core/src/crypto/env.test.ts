import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvValidationError } from '../env.js';
import { loadModelCredentialsConfig } from './env.js';
import { MasterKeyConfigError } from './master-key.js';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');

describe('loadModelCredentialsConfig', () => {
  it('loads the master-key map and defaults the key version to 1', () => {
    const config = loadModelCredentialsConfig({
      MODEL_CREDENTIALS_MASTER_KEYS: JSON.stringify({ '1': KEY_V1 }),
    });
    expect(config.currentKeyVersion).toBe(1);
    expect(config.masterKeys.get(1)?.length).toBe(32);
  });

  it('honors an explicit key version', () => {
    const config = loadModelCredentialsConfig({
      MODEL_CREDENTIALS_MASTER_KEYS: JSON.stringify({ '1': KEY_V1, '2': KEY_V2 }),
      MODEL_CREDENTIALS_KEY_VERSION: '2',
    });
    expect(config.currentKeyVersion).toBe(2);
  });

  it('fails at startup when MODEL_CREDENTIALS_MASTER_KEYS is missing', () => {
    expect(() => loadModelCredentialsConfig({})).toThrow(EnvValidationError);
  });

  it('fails at startup when the key map is malformed', () => {
    expect(() => loadModelCredentialsConfig({ MODEL_CREDENTIALS_MASTER_KEYS: 'not json' })).toThrow(
      MasterKeyConfigError,
    );
  });

  it('fails at startup when the configured key version has no matching key', () => {
    expect(() =>
      loadModelCredentialsConfig({
        MODEL_CREDENTIALS_MASTER_KEYS: JSON.stringify({ '1': KEY_V1 }),
        MODEL_CREDENTIALS_KEY_VERSION: '2',
      }),
    ).toThrow(MasterKeyConfigError);
  });
});
