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

## bullmq + ioredis (Phase 4)
1. **What problem does it solve?** The job queue between the API (produces
   review jobs) and the worker (consumes them), with retries, backoff and
   per-job idempotency. ARCHITECTURE §4 named Redis + BullMQ as the
   decision over a Postgres-backed queue or SQS.
2. **Why not the existing stack?** Postgres has no built-in queue with
   blocking consumption, retries and backoff; building one is exactly the
   "do not build a custom queue" ARCHITECTURE §4 warns against.
3. **Operational cost:** one more service, Redis, already required from
   Phase 1 for future caching and already in `docker-compose.yml`.
4. **Local dev:** `docker compose up -d redis` (already required).
5. **Production:** BullMQ's Redis connection needs
   `maxRetriesPerRequest: null` on the ioredis client, or Workers throw at
   construction; `createRedisConnection` sets this once.
6. **Can we remove it?** Yes. Queue access is confined to
   `packages/core/src/queue/` and `apps/worker/src/worker.ts`.

## Google Gemini (Phase 4)
1. **What problem does it solve?** The first model provider
   (ARCHITECTURE §12, project decision: Gemini before OpenAI). Called
   directly over `fetch`, not through a Google SDK, matching how the
   provider-neutral `ReviewModel` interface is meant to be used: SDKs stay
   out of the agent/review logic (ARCHITECTURE §12).
2. **Why not the existing stack?** There is no model provider yet.
3. **Operational cost:** none locally; in production, cost is per token
   (PRODUCT_SPEC §20's "cost per review" metric) and rate limits, which the
   adapter retries with backoff.
4. **Local dev:** a `GEMINI_API_KEY` from https://aistudio.google.com/apikey.
5. **Production:** the key is a secret, read once at startup
   (`GEMINI_API_KEY`), sent in the `x-goog-api-key` header, never in a URL
   or a log line. `GEMINI_MODEL` is pinned to a specific, non-preview model
   rather than a `-latest` alias, so a provider-side default change cannot
   silently change review behaviour.
6. **Can we remove it?** Yes. `packages/core/src/llm/gemini.ts` is the only
   file that knows about Gemini's request shape; the rest of the app uses
   the `ReviewModel` interface.

## yaml (Phase 5)
1. **What problem does it solve?** Parses `.coderexic.yml`/`.verix.yml`
   (PRODUCT_SPEC §11). ARCHITECTURE §16 explicitly says "never use a
   home-grown YAML parser" for repo config, since it's untrusted input.
2. **Why not the existing stack?** No YAML parser exists in the project;
   Node has no built-in one. `yaml` is the most widely used pure-JS
   implementation, with no native dependencies to audit.
3. **Operational cost:** none; parsing is synchronous and in-process.
4. **Local dev:** nothing to configure.
5. **Production:** config files are untrusted repository input, so the
   loader calls `parse()` with an explicit `maxAliasCount` bound (the
   library's own guard against a "billion laughs" style alias-expansion
   file) and a byte cap on the file fetch itself
   (`getFileContent(..., maxBytes)`), and treats any parse error as bad
   config rather than a crash (PRODUCT_SPEC §18).
6. **Can we remove it?** Yes. Only `packages/core/src/config/loader.ts`
   imports it.
