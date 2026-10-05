# Production deployment (Render)

Coderexic deploys to [Render](https://render.com) as three services (`api`,
`worker`, `web`) plus a managed Postgres database and a managed Redis
(Key Value) instance, all described in `render.yaml` at the repo root. This
doc is the runbook: what's automatic once set up, and the one-time manual
steps Render can't do for you.

## 1. One-time setup

1. **Create a Render account** and connect this GitHub repository to it.
2. **New → Blueprint**, point it at this repo. Render reads `render.yaml`
   and proposes `coderexic-db` (Postgres), `coderexic-redis` (Key Value),
   and the three Docker services. Confirm to create them.
3. **Register the production GitHub App.** Same settings as
   `docs/github-app.md`, with two differences:
   - **Webhook URL**: `https://<coderexic-api's domain>/webhooks/github`
     (Render assigns a `*.onrender.com` URL immediately; switch this once a
     custom domain is attached, step 5).
   - **Where can it be installed**: keep this scoped to your own account or
     org for now (ROADMAP.md Phase 19's beta is 5-10 repos, not a public
     listing) - "Any account" is a later, deliberate decision once Phase 19
     has real feedback, not a default to flip on day one.

   Everything else - permissions (**Issues must be Read and write**, not
   just Pull requests; see `docs/github-app.md`'s own note on why),
   subscribed events, the App icon - is identical. Note the **App ID** and
   generate a **private key** (`.pem`) as usual.
4. **Fill in every secret** Render's dashboard is now asking for (every
   `sync: false` entry in `render.yaml`), one per service:

   | Service | Variable | Value |
   | --- | --- | --- |
   | `coderexic-api` | `GITHUB_WEBHOOK_SECRET` | the secret you set when registering the App |
   | `coderexic-api` | `METRICS_TOKEN` | optional - `openssl rand -hex 32` if you want `/metrics` to actually answer (see §4) |
   | `coderexic-worker` | `GITHUB_APP_ID` | from the App's page |
   | `coderexic-worker` | `GITHUB_PRIVATE_KEY` | the **raw PEM contents** of the `.pem` file, pasted as-is (real newlines, not `\n` escapes - Render's text area handles multi-line values directly). Render's filesystem isn't persistent across deploys, so the `GITHUB_PRIVATE_KEY_PATH` approach `docs/github-app.md` uses for local dev doesn't apply here. |
   | `coderexic-worker` | `GEMINI_API_KEY` | (or swap `MODEL_PROVIDER` + the matching `_API_KEY` for a different provider - see `.env.example`) |
   | `coderexic-worker` *and* `coderexic-web` | `MODEL_CREDENTIALS_MASTER_KEYS` | optional (BYOK, Phase 11) - `{"1":"<base64 32-byte key>"}` from `openssl rand -base64 32`. **Must be the exact same value on both services** - this is the one secret `render.yaml` can't enforce for you; if it ever drifts, every repo-level BYOK credential silently becomes undecryptable. |
   | `coderexic-web` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from the App's **General** page - its own OAuth client, not a separate OAuth App |
   | `coderexic-web` | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `coderexic-web` | `NEXTAUTH_URL` | this service's public URL (the `onrender.com` one to start; update after step 5) |
   | `coderexic-web` | `GITHUB_APP_SLUG` | optional - the App's public page slug, used for an "install the app" link on the dashboard's empty state |

5. **Custom domain + TLS.** Add your domain to `coderexic-web` (and
   `coderexic-api`, since the GitHub webhook needs a stable URL) under each
   service's **Settings → Custom Domains**. Render issues and renews TLS
   automatically once your DNS points at it (a `CNAME`, per Render's
   instructions for your domain). Once live, update the GitHub App's webhook
   URL, OAuth callback URL, and `NEXTAUTH_URL` to use the real domain instead
   of the `onrender.com` one.

## 2. What happens automatically after that

- **Every push to `main`** triggers Render to rebuild and redeploy all
  three services. `coderexic-api`'s `preDeployCommand` (`node
  dist/migrate.js`) runs first - Drizzle tracks which migrations are already
  applied, so this is a no-op most deploys and only does real work when a
  deploy actually adds a migration.
- `.github/workflows/ci.yml`'s `check` job (format/lint/typecheck/tests/
  build) is the merge gate - set it as a required check on `main` in this
  repo's branch protection settings if it isn't already. Render's deploy is
  the delivery step; CI is what decides whether a push is safe to deliver.
- **Rollback**: each service's **Events** tab in Render's dashboard lists
  past deploys with a one-click **Rollback to this deploy**. No extra
  tooling needed.
- **Backups**: Render's managed Postgres takes automatic daily backups once
  on a paid plan (the `0.1c-256mb` plan `render.yaml` specifies qualifies).
  Restore from **coderexic-db → Backups** in the dashboard.

## 3. Health checks

`coderexic-api` (`/health`) and `coderexic-web` (`/api/health`) are wired
into `render.yaml`'s `healthCheckPath` - Render uses these for zero-downtime
deploys (don't route traffic to a new instance until it answers) and to
restart a stuck instance. `coderexic-worker` is a background-worker service,
which Render's Blueprint schema doesn't support a health check path for;
Docker's own `HEALTHCHECK` (in `docker/worker.Dockerfile`) plus Render's own
crash-restart behavior cover it instead.

## 4. Monitoring and alerting (scoped for this launch size)

Render's own dashboard (logs, CPU/memory, deploy history) plus its
deploy-failure and crash email notifications cover the basics with zero
extra setup. For this launch size (Phase 19's 5-10 repos), that's enough to
start:

- Set `METRICS_TOKEN` on `coderexic-api`/`coderexic-worker` and point one
  free external uptime monitor (e.g. UptimeRobot, Better Stack's free tier)
  at `coderexic-api`'s `/health` and `coderexic-web`'s `/api/health`,
  alerting to email or Slack on a failure.
- The existing Prometheus `/metrics` endpoints on both `api` and `worker`
  (ROADMAP.md Phase 14 - webhook delivery outcomes, queue depth, review
  latency/outcome, model token usage, errors by code) aren't scraped by
  anything yet. Wiring them into a real dashboard (a hosted Grafana, or
  Render's own metrics if it adds Prometheus scraping support) is a
  reasonable Phase 19 refinement once there's real traffic worth watching
  closely - not a blocker for getting the first deploy live.

## Why separate `docker/*.Dockerfile` files

The root `Dockerfile` builds three targets (`api`, `worker`, `web`) from one
file, selected with `docker build --target <name>` - that's what
`docker-compose.yml` and CI use. Render's Blueprint has no equivalent of
`--target`: it always builds a Dockerfile's final stage (confirmed against
Render's own docs, which document `dockerfilePath`/`dockerContext`/
`dockerCommand` and nothing for stage selection). `docker/api.Dockerfile`,
`docker/worker.Dockerfile` and `docker/web.Dockerfile` are the same stages,
each duplicated into its own self-contained file so Render can build it
directly. `.github/workflows/ci.yml`'s `docker` job builds all six
(three root-Dockerfile targets, three `docker/*.Dockerfile` files) on every
PR specifically so this duplication can't silently drift without CI
catching it.
