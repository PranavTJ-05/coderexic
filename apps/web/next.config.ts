import path from 'node:path';
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
  // ROADMAP.md Phase 18: a self-contained server bundle (its own minimal
  // node_modules, traced from actual imports) for the Dockerfile's `web`
  // target, the same shape apps/api/apps/worker already get from `pnpm
  // deploy --prod` - standalone output is Next's own equivalent for an app
  // that can't use that command.
  output: 'standalone',
  // Without this, Next's output tracer roots itself at apps/web and can't
  // see outside the workspace to correctly trace the @coderexic/core
  // dependency (and the root pnpm-lock.yaml it needs to resolve pnpm's
  // symlinked node_modules layout) into the standalone bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
};

export default nextConfig;
