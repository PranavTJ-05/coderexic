# GitHub App setup

Coderexic runs as a GitHub App. For development, register your own App and
install it only on a throwaway repository.

## 1. Register the App
Open <https://github.com/settings/apps/new> and fill in:

| Setting | Value |
| --- | --- |
| Name | `coderexic-dev-<you>` (names are unique across GitHub) |
| Homepage URL | the repository URL |
| Webhook | Active |
| Webhook URL | your smee.io channel (step 3) |
| Webhook secret | output of `openssl rand -hex 32` |
| Where can it be installed | Only on this account |

**Repository permissions** (least privilege, PRODUCT_SPEC §7.1):

| Permission | Access |
| --- | --- |
| Contents | Read-only |
| Pull requests | Read and write |
| Issues | Read-only |
| Metadata | Read-only |

**Subscribe to events:** Pull request, Push, Issue comment. GitHub sends
`installation` and `installation_repositories` automatically.

## 2. Credentials
1. Note the **App ID** on the App's page.
2. Under **Private keys**, generate a key. Save it outside the repository:

   ```bash
   mkdir -p ~/.config/coderexic
   mv ~/Downloads/<app>.*.private-key.pem ~/.config/coderexic/app.pem
   chmod 600 ~/.config/coderexic/app.pem
   ```

3. Put the values in `.env` and never commit them:

   ```
   GITHUB_APP_ID=123456
   GITHUB_PRIVATE_KEY_PATH=/home/you/.config/coderexic/app.pem
   GITHUB_WEBHOOK_SECRET=<the secret from step 1>
   ```

4. **Install App** → Only select repositories → your test repository.

## 3. Receive webhooks locally
GitHub can't reach localhost, so smee.io relays deliveries.

```bash
docker compose up -d postgres && pnpm db:migrate
pnpm dev:api
pnpm dlx smee-client --url "$SMEE_URL" --target http://127.0.0.1:3000/webhooks/github
```

Open or push to a pull request in the test repository. The API logs
`review job created`, and a `review_jobs` row appears with status `PENDING`.
Workers pick jobs up from Phase 4.

Your App's **Advanced** tab lists recent deliveries and can redeliver them.
Redeliveries of already-processed events are acknowledged without being
applied twice.

## 4. Check GitHub API access

```bash
pnpm github:smoke --repo you/test-repo --pr 1          # read-only
pnpm github:smoke --repo you/test-repo --pr 1 --post   # also posts a test review
```

This prints the PR metadata, changed files, one file's content and the
repository tree. With `--post`, it publishes a review with one inline
comment.

## Security notes
- The private key never leaves `GITHUB_PRIVATE_KEY_PATH` (or the secret
  manager). A key file readable by other users triggers a warning.
- Webhooks are rejected unless the `X-Hub-Signature-256` HMAC of the raw body
  matches, compared in constant time.
- Installation tokens are short-lived, scoped to one installation, and cached
  by Octokit. They never appear in logs.
- Rate limits: requests wait and retry at most twice, and only when GitHub
  asks for a pause of 60 seconds or less.
