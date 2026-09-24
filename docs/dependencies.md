# Dependency decisions

Every runtime or tooling dependency added after Phase 1 answers the six
questions in ARCHITECTURE.md §22.

## drizzle-orm + drizzle-kit (Phase 2)
1. **What problem does it solve?** Typed schema, queries and SQL migrations
   for Postgres.
2. **Why not the existing stack?** There was no database layer. Raw SQL
   would mean hand-written types and a home-grown migration runner.
3. **Operational cost:** None at runtime. It's a thin query builder, not a
   separate service. drizzle-kit is a dev dependency only.
4. **Local dev:** `pnpm db:generate` and `pnpm db:migrate`.
5. **Production:** plain SQL files, applied by an explicit one-shot migrate
   step, never at startup.
6. **Can we remove it?** Yes. The migrations are plain SQL, and queries are
   confined to `packages/core/src/db/store/`.

## postgres (postgres.js driver, Phase 2)
1. **What problem does it solve?** Connecting to Postgres from Node.
2. **Why not the existing stack?** Node has no built-in Postgres client.
3. **Operational cost:** None. It's pure JS with no native build.
4. **Local dev:** nothing extra.
5. **Production:** a per-process pool, sized by `maxConnections`.
6. **Can we remove it?** Yes. Drizzle also supports `pg`, and the driver
   appears only in `db/client.ts` and `db/migrate.ts`.

## octokit (Phase 3)
1. **What problem does it solve?** GitHub App authentication (a JWT, then
   installation tokens with caching and refresh), typed REST calls,
   pagination, retries, and rate-limit throttling.
2. **Why not the existing stack?** Doing this by hand means reimplementing
   JWT signing, token caching and rate-limit handling, all of it
   security-sensitive. ARCHITECTURE §21 names Octokit.
3. **Operational cost:** none. It's a library, with no service to run.
4. **Local dev:** nothing extra. Tests inject a fake `fetch`.
5. **Production:** it runs in-process. Throttling protects us from secondary
   rate limits.
6. **Can we remove it?** Yes. Only `packages/core/src/github/client.ts` uses
   it, behind the `GitHubClient` interface (ARCHITECTURE §5).

Webhook signature verification uses `node:crypto`, not a library.
