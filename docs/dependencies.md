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

## typescript (Phase 6, runtime dependency of @coderexic/core)
1. **What problem does it solve?** Extracts imports/exports/requires from
   TypeScript and JavaScript source for the dependency graph
   (`graph/extract/typescript.ts`), and parses `tsconfig.json`'s JSONC
   syntax for path-alias resolution (`graph/tsconfig.ts`).
2. **Why not the existing stack?** `typescript` was already a devDependency
   for building the project itself. Its compiler API
   (`ts.preProcessFile`, `ts.parseConfigFileTextToJson`) is the real parser
   GitHub's own files were written against, so it handles ES imports,
   `export ... from`, dynamic `import()`, CommonJS `require()`, and
   JSONC comments/trailing commas correctly in one pass, instead of a
   hand-rolled regex extractor per import style.
3. **Operational cost:** adds the TypeScript compiler to the worker's
   runtime bundle; it's a pure, synchronous, in-process parse, no network
   or extra services.
4. **Local dev:** nothing to configure.
5. **Production:** file content is untrusted repository input, so the
   indexer caps each file at `MAX_FILE_BYTES` and the whole tree crawl at
   `DEFAULT_MAX_FILES` before ever calling into the parser; a parse
   failure on one file is caught per-file and that file is simply
   skipped (no edges), never crashing the run.
6. **Can we remove it?** No, without replacing the TS/JS extractor and
   the tsconfig alias resolver; it was moved from a devDependency to a
   runtime `dependencies` entry in `packages/core/package.json`
   specifically because `graph/extract/typescript.ts` and
   `graph/tsconfig.ts` import it at runtime, not just at build time.

## next + react + react-dom (Phase 13a)
1. **What problem does it solve?** The hosted web UI (`apps/web`) -
   server-rendered pages, route handlers for OAuth callbacks and
   authorized data APIs. ARCHITECTURE §21 named Next.js, Tailwind and
   shadcn/ui as the frontend stack; Tailwind/shadcn are deferred to Phase
   13b, since 13a has no design surface to style yet.
2. **Why not the existing stack?** The rest of the monorepo is Fastify
   (API/worker), which has no browser UI story; there was no frontend
   framework in the project before this phase.
3. **Operational cost:** one more deployable process (`apps/web`), same
   shape as `apps/api`/`apps/worker` - stateless, horizontally scalable,
   reads `packages/core`'s DB store functions directly (no new service to
   run; see ARCHITECTURE §4's Phase 13a decisions for why it doesn't go
   through `apps/api`).
4. **Local dev:** `pnpm dev:web` (`next dev`). Next reads env from its own
   `apps/web/.env.local`/`.env`, not the root `.env` the other apps share
   via `tsx --env-file-if-exists=../../.env` - a real asymmetry, noted in
   AGENTS.md.
5. **Production:** `next build` then `next start`, or a static/standalone
   output later if needed. `@coderexic/core` must be built first
   (`pnpm --filter @coderexic/core build`) - Next resolves it via its
   `exports` map's `default` (built `dist/`) condition, not TypeScript
   source. `next.config.ts`'s `serverExternalPackages` keeps
   `@coderexic/core` and its own Node-only dependencies (pino, postgres,
   bullmq, ioredis, octokit) un-bundled, since they're already
   process-local Node code, not browser-bundlable.
6. **Can we remove it?** Yes, in principle - `apps/web` is a separate
   deployable that only imports `packages/core`'s public API, the same as
   `apps/api`/`apps/worker`. Removing it drops the hosted UI, not any
   review-pipeline functionality.

## next-auth (Phase 13a)
1. **What problem does it solve?** GitHub OAuth (specifically: authorizing
   this GitHub App itself, to get a user-to-server access token - see
   `apps/web/src/auth.ts`), session issuance and verification for the web
   UI.
2. **Why not the existing stack?** Hand-rolling OAuth (the authorization
   code exchange, CSRF/state validation, session cookie signing and
   encryption) is exactly the kind of security-sensitive code a
   battle-tested library should own, matching `octokit`'s justification in
   Phase 3.
3. **Operational cost:** none beyond the library itself - no adapter, no
   extra tables. Configured with the JWT session strategy (`session:
   {strategy: 'jwt'}`), not the database strategy, so it never creates its
   own schema; the app's own `users` table (Phase 2) is upserted by hand in
   the `jwt` callback via `@coderexic/core`'s `upsertUser`.
4. **Local dev:** needs `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (the
   GitHub App's own OAuth client, not a separate OAuth App) and
   `AUTH_SECRET` in `apps/web/.env.local`.
5. **Production:** the GitHub access token lives only in the encrypted
   session JWT (read server-side via `getToken`, e.g.
   `app/api/repos/route.ts`) - the `session` callback deliberately never
   copies it onto the `session` object, since anything there is readable
   by client JS via `/api/auth/session`.
6. **Can we remove it?** Yes - confined to `apps/web/src/auth.ts` and the
   `app/api/auth/[...nextauth]` route. **Note for whoever revisits this:**
   the stable release line is v4 (`4.24.15`); the v5/"Auth.js" rebrand has
   been in beta for an extended period as of this writing. v4 is the
   correct choice today, but check its release history before assuming
   that's still true.

## tailwindcss + @tailwindcss/postcss (Phase 13b)
1. **What problem does it solve?** Styling for `apps/web`'s dashboard/
   repository/review pages - Phase 13a shipped intentionally unstyled,
   with nothing to style yet.
2. **Why not the existing stack?** No existing styling layer; a utility-CSS
   approach avoids hand-rolling a component stylesheet per page, and
   matches ARCHITECTURE.md §21's original plan.
3. **Operational cost:** `postcss.config.mjs` (one plugin) and
   `app/globals.css` (an `@import "tailwindcss"` plus a handful of CSS
   custom properties for light/dark theming). No build step beyond what
   `next build` already runs.
4. **Local dev:** none - Tailwind v4's PostCSS plugin scans source files
   automatically, no content-glob config needed.
5. **Production:** verified empirically, not assumed - after `next build`,
   grepped `.next/static/css` for classes actually used in `apps/web`'s
   source (e.g. `max-w-4xl`, `rounded-lg`) to confirm class detection
   works in this monorepo layout, not just in a standalone Next app.
6. **Can we remove it?** Yes, confined to `apps/web` - would mean
   rewriting its components with hand-written CSS or another library.

## clsx + tailwind-merge + class-variance-authority (Phase 13b)
1. **What problem does it solve?** Composing Tailwind utility classes
   conditionally and resolving conflicts (e.g. a caller-supplied
   `className` overriding a component's own padding) without string
   concatenation bugs - the same `cn()` + `cva()` pattern the `shadcn/ui`
   ecosystem is built on.
2. **Why not the existing stack?** Nothing else in the stack composes
   class names; each library is tiny and does exactly one thing
   (`clsx`: conditional joining, `tailwind-merge`: Tailwind-aware conflict
   resolution, `class-variance-authority`: typed variant props).
3. **Operational cost:** none - `apps/web/src/lib/cn.ts` (a few lines) and
   `apps/web/src/components/ui.tsx` (hand-authored primitives; see
   ARCHITECTURE.md's Phase 13b decisions for why these are hand-written
   rather than generated by the `shadcn` CLI).
4. **Local dev / production:** no configuration.
5. **Can we remove it?** Yes, confined to `apps/web/src/lib/cn.ts` and
   `apps/web/src/components/ui.tsx`.
