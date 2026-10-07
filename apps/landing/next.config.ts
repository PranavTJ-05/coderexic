import type { NextConfig } from 'next';

/**
 * Deliberately minimal: unlike apps/web, this app has no Node-only
 * dependency to externalize (no @coderexic/core, no DB/queue clients) and
 * is never built into a Docker image, so no `output: 'standalone'` either -
 * Vercel has its own build/packaging pipeline.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
