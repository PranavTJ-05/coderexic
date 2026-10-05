import { NextResponse } from 'next/server';

/**
 * Liveness only, no dependency checks - matching apps/api's `/health`
 * (apps/api/src/routes/health.ts), not its `/ready`: a database or Redis
 * outage must never get this process restarted by the platform's health
 * check. Exists so Render's web-service health check (ROADMAP.md Phase 18)
 * has a cheap, dependency-free path to hit instead of `/`, which would
 * otherwise run the dashboard's own auth/session logic on every probe.
 */
export function GET() {
  return NextResponse.json({ status: 'ok', service: 'web' });
}
