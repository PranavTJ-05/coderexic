import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { EnvValidationError, parseEnv } from '../env.js';

/** Secret shared with GitHub for webhook signatures. Needed by the API. */
export const githubWebhookEnvSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
});

/**
 * GitHub App credentials, needed wherever the GitHub API is called. The
 * private key comes from a file (GITHUB_PRIVATE_KEY_PATH, preferred locally)
 * or inline (GITHUB_PRIVATE_KEY, for secret managers; `\n` escapes allowed).
 */
export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().min(1).optional(),
});

export interface GitHubAppCredentials {
  appId: number;
  privateKey: string;
}

const PEM = /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----/;

/**
 * Loads App credentials from the environment. Errors name the variable,
 * never the key material. `warn` receives a notice if the key file is
 * readable by other users.
 */
export function loadGitHubAppCredentials(
  source: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = () => undefined,
): GitHubAppCredentials {
  const env = parseEnv(githubAppEnvSchema, source);
  let privateKey: string;
  if (env.GITHUB_PRIVATE_KEY_PATH) {
    const path = env.GITHUB_PRIVATE_KEY_PATH;
    try {
      if ((statSync(path).mode & 0o077) !== 0) {
        warn('GITHUB_PRIVATE_KEY_PATH is readable by other users; run chmod 600 on it');
      }
      privateKey = readFileSync(path, 'utf8');
    } catch {
      throw new EnvValidationError(['GITHUB_PRIVATE_KEY_PATH: file cannot be read']);
    }
  } else if (env.GITHUB_PRIVATE_KEY) {
    privateKey = env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else {
    throw new EnvValidationError(['GITHUB_PRIVATE_KEY_PATH or GITHUB_PRIVATE_KEY: required']);
  }
  if (!PEM.test(privateKey)) {
    throw new EnvValidationError(['GitHub App private key: not a PEM private key']);
  }
  return { appId: env.GITHUB_APP_ID, privateKey };
}
