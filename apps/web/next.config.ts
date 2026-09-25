import type { NextConfig } from 'next';

/**
 * @coderexic/core pulls in Node-only packages (pino, postgres, bullmq,
 * octokit) that Next's bundler can't (and shouldn't) bundle for a server
 * component / route handler - they run in the Node.js runtime already.
 * `serverExternalPackages` tells Next to require() them instead of
 * bundling, the same way apps/api and apps/worker consume them directly.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['@coderexic/core', 'pino', 'postgres', 'bullmq', 'ioredis', 'octokit'],
};

export default nextConfig;
