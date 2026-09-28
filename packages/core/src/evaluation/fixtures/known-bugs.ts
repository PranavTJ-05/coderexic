import type { EvalCase } from '../types.js';
import { modifiedFile } from './patch-builder.js';

/**
 * Known-bug fixture cases (ROADMAP.md Phase 15).
 *
 * Every hunk starts at a varied, non-trivial line number (`modifiedFile`'s
 * `oldStart`/`newStart`) and opens with three no-op leading comment lines
 * before the actual bug, deliberately: a scorer that rewards a model for
 * pointing at line 3 of the first changed file, or at the first added line
 * of any hunk, would be measuring "did the model point at new code", not
 * review quality. `fixtures.test.ts`'s guesser tests assert both of those
 * degenerate strategies score far below a real model on this suite - if
 * you add a case, keep the leading no-op lines (or otherwise vary the
 * bug's position within its hunk) so that stays true. Real PRs are
 * messier than any of this; the goal here is fixtures that actually
 * discriminate a model that finds bugs from one that doesn't, not
 * photorealism of diff shape.
 */
export const KNOWN_BUG_CASES: EvalCase[] = [
  {
    id: 'off-by-one-loop-bound',
    title: 'Off-by-one loop bound reads past the array',
    category: 'known-bug',
    description: 'Changes `i < n` to `i <= n`, reading one element past the end of `arr`.',
    pullRequestTitle: 'Fix sumFirstN edge case',
    pullRequestBody: 'Handles n === arr.length correctly.',
    files: [
      modifiedFile('src/math/sum-first-n.ts', 1, 1, [
        ' function sumFirstN(arr: number[], n: number): number {',
        '   let total = 0;',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  for (let i = 0; i <= n; i++) {',
        '+    total += arr[i];',
        '+  }',
        '   return total;',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/math/sum-first-n.ts',
        startLine: 6,
        endLine: 8,
        severity: 'high',
        description: '`i <= n` reads `arr[n]`, one past the last valid index.',
      },
    ],
  },
  {
    id: 'missing-await-unhandled-promise',
    title: 'Missing await drops an unhandled promise rejection',
    category: 'known-bug',
    description:
      'Calls an async cleanup function without awaiting it, so a rejection is unhandled and errors are silently lost.',
    pullRequestTitle: 'Clean up temp files after export',
    pullRequestBody: 'Removes the temp directory once the export completes.',
    files: [
      modifiedFile('src/export/finish-export.ts', 42, 42, [
        ' export async function finishExport(jobId: string): Promise<void> {',
        '   await writeManifest(jobId);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  cleanupTempDir(jobId);',
        '+  markExportComplete(jobId);',
        '+  return;',
        '   // export finished',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/export/finish-export.ts',
        startLine: 47,
        endLine: 47,
        severity: 'medium',
        description: '`cleanupTempDir` returns a promise that is never awaited or caught.',
      },
    ],
  },
  {
    id: 'null-deref-optional-user',
    title: 'Dereferences an optional field without a null check',
    category: 'known-bug',
    description:
      '`user.profile` is optional but is accessed directly, throwing for users with no profile.',
    pullRequestTitle: 'Show profile bio on the settings page',
    pullRequestBody: 'Adds the bio field to the settings response.',
    files: [
      modifiedFile('src/api/settings.ts', 1, 1, [
        ' export function buildSettingsResponse(user: User): SettingsDto {',
        '   const base = { id: user.id, email: user.email };',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  return {',
        '+    ...base,',
        '+    bio: user.profile.bio,',
        '   };',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/api/settings.ts',
        startLine: 6,
        endLine: 8,
        severity: 'high',
        description:
          '`user.profile` can be `undefined`; `.bio` throws for users without a profile.',
      },
    ],
  },
  {
    id: 'sql-injection-string-concat',
    title: 'SQL query built with string concatenation',
    category: 'known-bug',
    description:
      'Interpolates a user-supplied username directly into a SQL string instead of using a parameter.',
    pullRequestTitle: 'Add lookup-by-username admin endpoint',
    pullRequestBody: 'Lets support look up a user by username.',
    files: [
      modifiedFile('src/admin/find-user.ts', 77, 77, [
        ' export async function findUserByUsername(db: Db, username: string) {',
        '   const table = "users";',
        "+  const query = `SELECT * FROM ${table} WHERE username = '${username}'`;",
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const rows = await db.query(query);',
        '+  return rows[0] ?? null;',
        '   // done',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/admin/find-user.ts',
        startLine: 82,
        endLine: 82,
        severity: 'critical',
        description: 'Unsanitized `username` is concatenated into SQL; use a parameterized query.',
      },
    ],
  },
  {
    id: 'command-injection-exec',
    title: 'Shell command built from unsanitized input',
    category: 'known-bug',
    description: 'Passes a user-controlled filename to `exec` inside a shell string.',
    pullRequestTitle: 'Add thumbnail generation on upload',
    pullRequestBody: 'Generates a thumbnail via imagemagick after upload.',
    files: [
      modifiedFile('src/uploads/thumbnail.ts', 15, 15, [
        ' export async function generateThumbnail(filename: string): Promise<void> {',
        '   const dir = "/tmp/uploads";',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const cmd = `convert ${dir}/${filename} -thumbnail 200x200 ${dir}/thumb-${filename}`;',
        '+  await exec(cmd);',
        '+  return;',
        '   // thumbnail written',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/uploads/thumbnail.ts',
        startLine: 20,
        endLine: 21,
        severity: 'critical',
        description: 'Unsanitized `filename` is interpolated into a shell command run via `exec`.',
      },
    ],
  },
  {
    id: 'leaked-db-connection',
    title: 'Database connection is never released on the error path',
    category: 'known-bug',
    description:
      'Acquires a pooled connection, but an early return on error skips `connection.release()`.',
    pullRequestTitle: 'Validate order before charging',
    pullRequestBody: 'Rejects orders with an invalid total before running the charge.',
    files: [
      modifiedFile('src/billing/charge-order.ts', 60, 60, [
        ' export async function chargeOrder(pool: Pool, order: Order): Promise<void> {',
        '   const connection = await pool.acquire();',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  if (order.total <= 0) {',
        '+    throw new Error("invalid order total");',
        '+  }',
        '   await connection.query("UPDATE orders SET charged = true WHERE id = $1", [order.id]);',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/billing/charge-order.ts',
        startLine: 65,
        endLine: 67,
        severity: 'medium',
        description: 'Throwing here skips `connection.release()`, leaking the pooled connection.',
      },
    ],
  },
  {
    id: 'wrong-comparison-operator-assignment',
    title: 'Assignment used where a comparison was intended',
    category: 'known-bug',
    description:
      'Uses `=` instead of `===` inside an `if`, so the condition is always truthy and also mutates state.',
    pullRequestTitle: 'Skip retry when job is already done',
    pullRequestBody: 'Adds a short-circuit for already-completed jobs.',
    files: [
      modifiedFile('src/jobs/retry.ts', 9, 9, [
        ' export function shouldRetry(job: Job): boolean {',
        '   let status = job.status;',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  if (status = "done") {',
        '+    return false;',
        '+  }',
        '   return job.attempts < job.maxAttempts;',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/jobs/retry.ts',
        startLine: 14,
        endLine: 14,
        severity: 'high',
        description:
          '`status = "done"` is an assignment, not a comparison; the branch always taken.',
      },
    ],
  },
  {
    id: 'unescaped-html-injection',
    title: 'User content rendered without escaping',
    category: 'known-bug',
    description: 'Interpolates a comment body directly into an HTML string sent to the client.',
    pullRequestTitle: 'Render comment preview server-side',
    pullRequestBody: 'Adds a server-rendered preview of the comment before posting.',
    files: [
      modifiedFile('src/comments/preview.ts', 33, 33, [
        ' export function renderCommentPreview(comment: Comment): string {',
        '   const author = escapeHtml(comment.author);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const body = comment.body;',
        '+  return `<div class="comment"><b>${author}</b><p>${body}</p></div>`;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/comments/preview.ts',
        startLine: 38,
        endLine: 39,
        severity: 'high',
        description:
          '`comment.body` is interpolated unescaped, unlike `author` above it; stored XSS.',
      },
    ],
  },
  {
    id: 'hardcoded-api-secret',
    title: 'API secret hardcoded instead of read from config',
    category: 'known-bug',
    description:
      'Commits a live-looking API key as a string literal instead of reading it from env/config.',
    pullRequestTitle: 'Wire up the payments webhook client',
    pullRequestBody: 'Adds the outbound client used to notify the payments provider.',
    files: [
      modifiedFile('src/payments/webhook-client.ts', 5, 5, [
        ' export function createWebhookClient(): WebhookClient {',
        '   const baseUrl = "https://api.payments.example.com";',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const apiKey = "REPLACE_ME_not_a_real_key_but_looks_like_one_51Hc9x2";',
        '+  return new WebhookClient(baseUrl, apiKey);',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/payments/webhook-client.ts',
        startLine: 10,
        endLine: 10,
        severity: 'critical',
        description: 'A live-looking secret is hardcoded rather than loaded from config/env.',
      },
    ],
  },
  {
    id: 'array-index-no-bounds-check',
    title: 'Array access with no bounds check after a search',
    category: 'known-bug',
    description: '`indexOf` can return -1, but the result is used directly as an array index.',
    pullRequestTitle: 'Look up the next queue item after the current one',
    pullRequestBody: 'Returns the item following the given one in the queue.',
    files: [
      modifiedFile('src/queue/next-item.ts', 20, 20, [
        ' export function nextItem(queue: Item[], current: Item): Item {',
        '   const currentIndex = queue.indexOf(current);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const nextIndex = currentIndex + 1;',
        '+  return queue[nextIndex];',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/queue/next-item.ts',
        startLine: 25,
        endLine: 26,
        severity: 'medium',
        description:
          'If `current` is not in `queue`, `currentIndex` is -1 and `queue[0]` is returned silently.',
      },
    ],
  },
  {
    id: 'path-traversal-static-file',
    title: 'Static file handler does not resolve `..` out of the base directory',
    category: 'known-bug',
    description:
      'Joins a request path onto a base directory without checking the result stays inside it.',
    pullRequestTitle: 'Serve uploaded attachments by filename',
    pullRequestBody: 'Adds a route that streams an uploaded file back by name.',
    files: [
      modifiedFile('src/attachments/serve.ts', 90, 90, [
        ' export function attachmentPath(baseDir: string, requestedName: string): string {',
        '   const decoded = decodeURIComponent(requestedName);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const fullPath = path.join(baseDir, decoded);',
        '+  return fullPath;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/attachments/serve.ts',
        startLine: 95,
        endLine: 96,
        severity: 'critical',
        description: '`decoded` can contain `../`, letting a request read files outside `baseDir`.',
      },
    ],
  },
  {
    id: 'weak-random-token',
    title: 'Session token generated with Math.random',
    category: 'known-bug',
    description: 'Uses `Math.random()` (not cryptographically secure) to build a session token.',
    pullRequestTitle: 'Add lightweight session tokens',
    pullRequestBody: 'Issues a session token on login.',
    files: [
      modifiedFile('src/auth/session-token.ts', 2, 2, [
        ' export function issueSessionToken(userId: string): string {',
        '   const suffix = userId.slice(0, 4);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const random = Math.random().toString(36).slice(2);',
        '+  return `${suffix}-${random}`;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/auth/session-token.ts',
        startLine: 7,
        endLine: 8,
        severity: 'high',
        description:
          '`Math.random()` is predictable; session tokens need a CSPRNG (`crypto.randomBytes`).',
      },
    ],
  },
  {
    id: 'insecure-deserialize-eval',
    title: 'Untrusted config parsed with eval instead of JSON.parse',
    category: 'known-bug',
    description: 'Loads a user-editable config file with `eval` rather than a JSON parser.',
    pullRequestTitle: 'Load per-project overrides from a config file',
    pullRequestBody: 'Reads project-local overrides at startup.',
    files: [
      modifiedFile('src/config/load-overrides.ts', 50, 50, [
        ' export function loadOverrides(raw: string): Record<string, unknown> {',
        '   const trimmed = raw.trim();',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  // eslint-disable-next-line no-eval',
        '+  const parsed = eval(`(${trimmed})`);',
        '+  return parsed;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/config/load-overrides.ts',
        startLine: 56,
        endLine: 56,
        severity: 'critical',
        description:
          '`eval` on file content lets a malicious config file run arbitrary code; use `JSON.parse`.',
      },
    ],
  },
  {
    id: 'divide-by-zero-average',
    title: 'Average computed without guarding an empty list',
    category: 'known-bug',
    description: 'Divides by `scores.length` with no check for an empty array, producing `NaN`.',
    pullRequestTitle: 'Add average score to the report',
    pullRequestBody: 'Adds the mean score alongside the existing total.',
    files: [
      modifiedFile('src/reports/average.ts', 4, 4, [
        ' export function averageScore(scores: number[]): number {',
        '   const total = scores.reduce((a, b) => a + b, 0);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const average = total / scores.length;',
        '+  return average;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/reports/average.ts',
        startLine: 9,
        endLine: 9,
        severity: 'low',
        description:
          'An empty `scores` array makes `total / scores.length` divide by zero, returning `NaN`.',
      },
    ],
  },
  {
    id: 'event-listener-never-removed',
    title: 'Event listener added on every render, never removed',
    category: 'known-bug',
    description:
      'Registers a resize listener inside a function called repeatedly, with no matching removal.',
    pullRequestTitle: 'Recalculate layout on window resize',
    pullRequestBody: 'Keeps the layout in sync when the window is resized.',
    files: [
      modifiedFile('src/ui/layout-sync.ts', 66, 66, [
        ' export function attachLayoutSync(panel: Panel): void {',
        '   const recalc = () => panel.recalculateLayout();',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  window.addEventListener("resize", recalc);',
        '+  recalc();',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/ui/layout-sync.ts',
        startLine: 71,
        endLine: 71,
        severity: 'medium',
        description:
          'Listener is added with no way to remove it if `attachLayoutSync` is called again; accumulates listeners.',
      },
    ],
  },
  {
    id: 'swallowed-error-no-rethrow',
    title: 'Error caught and dropped instead of handled or rethrown',
    category: 'known-bug',
    description:
      'A `catch` block logs nothing and swallows the error, so callers see silent success on failure.',
    pullRequestTitle: 'Make notification sending best-effort',
    pullRequestBody: 'Notification failures should not block the main request.',
    files: [
      modifiedFile('src/notify/send.ts', 6, 6, [
        ' export async function sendBestEffort(notification: Notification): Promise<void> {',
        '   const client = getNotifyClient();',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  try {',
        '+    await client.send(notification);',
        '+  } catch {}',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/notify/send.ts',
        startLine: 11,
        endLine: 13,
        severity: 'low',
        description: 'The catch block is empty; failures are invisible with no logging at all.',
      },
    ],
  },
  {
    id: 'race-condition-check-then-act',
    title: 'Check-then-act race on a shared counter',
    category: 'known-bug',
    description:
      'Reads a counter, awaits an unrelated call, then writes the counter back - a concurrent call can interleave and lose an update.',
    pullRequestTitle: 'Enforce a per-user rate limit',
    pullRequestBody: 'Rejects a request once the user exceeds their limit.',
    files: [
      modifiedFile('src/ratelimit/check.ts', 28, 28, [
        ' export async function checkAndIncrement(store: Store, userId: string): Promise<boolean> {',
        '   const limit = 100;',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const current = await store.get(userId);',
        '+  await auditLog(userId, current);',
        '+  await store.set(userId, current + 1);',
        '   return current < limit;',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/ratelimit/check.ts',
        startLine: 33,
        endLine: 35,
        severity: 'medium',
        description:
          'Two concurrent requests can both read the same `current` before either writes it back, losing an increment.',
      },
    ],
  },
  {
    id: 'incorrect-type-coercion-loose-equals',
    title: 'Loose equality lets a string bypass a numeric check',
    category: 'known-bug',
    description:
      'Uses `==` against `0`, so the string `"0"` and `false` both pass a check meant to guard a numeric amount.',
    pullRequestTitle: 'Reject zero-amount transfers',
    pullRequestBody: 'Blocks transfers with a zero amount at the API boundary.',
    files: [
      modifiedFile('src/transfers/validate.ts', 8, 8, [
        ' export function validateTransfer(amount: unknown): void {',
        '   if (amount === null || amount === undefined) throw new Error("amount required");',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  if (amount == 0) {',
        '+    throw new Error("amount must be nonzero");',
        '+  }',
        '   // continue validating',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/transfers/validate.ts',
        startLine: 13,
        endLine: 15,
        severity: 'medium',
        description:
          '`amount == 0` loosely coerces; a non-numeric `amount` like `"abc"` silently passes this check.',
      },
    ],
  },
  {
    id: 'missing-null-check-api-response',
    title: 'API response field accessed before checking the response shape',
    category: 'known-bug',
    description:
      'Reads `response.data.user` without checking `response.data` exists, throwing on an error response.',
    pullRequestTitle: 'Show the current user after login',
    pullRequestBody: 'Fetches and displays the logged-in user after auth completes.',
    files: [
      modifiedFile('src/auth/current-user.ts', 110, 110, [
        ' export async function fetchCurrentUser(client: ApiClient): Promise<User> {',
        '   const response = await client.get("/me");',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const user = response.data.user;',
        '+  return user;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/auth/current-user.ts',
        startLine: 115,
        endLine: 115,
        severity: 'medium',
        description:
          'An error response has no `data`, so `response.data.user` throws instead of surfacing the API error.',
      },
    ],
  },
  {
    id: 'unbounded-recursion-no-base-case-guard',
    title: 'Recursive retry with no attempt limit',
    category: 'known-bug',
    description:
      'Retries a failed fetch by calling itself again with no cap on attempts, risking a stack overflow or infinite loop on a persistent failure.',
    pullRequestTitle: 'Retry flaky health checks',
    pullRequestBody: 'Retries the health check request on failure.',
    files: [
      modifiedFile('src/health/check.ts', 1, 1, [
        ' export async function checkHealth(client: ApiClient): Promise<boolean> {',
        '   try {',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+    const response = await client.get("/health");',
        '+    return response.ok;',
        '+  } catch {',
        '+    return checkHealth(client);',
        '   }',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/health/check.ts',
        startLine: 9,
        endLine: 9,
        severity: 'medium',
        description:
          'The catch block retries with no attempt count or backoff, recursing forever on a persistent failure.',
      },
    ],
  },
  {
    id: 'go-nil-pointer-deref',
    title: 'Go: dereferences a pointer that a prior call can leave nil',
    category: 'known-bug',
    description:
      '`FindUser` returns `(nil, nil)` on a miss, but the field is read before checking for nil.',
    pullRequestTitle: 'Log the found username',
    pullRequestBody: 'Adds a log line with the username once a user is found.',
    files: [
      modifiedFile('internal/users/lookup.go', 2, 2, [
        ' func LogUsername(store *Store, id string) {',
        '   user, _ := store.FindUser(id)',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  name := user.Name',
        '+  log.Printf("found user: %s", name)',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'internal/users/lookup.go',
        startLine: 7,
        endLine: 7,
        severity: 'high',
        description:
          '`FindUser` can return a nil `user` on a miss; `.Name` panics on the nil pointer.',
      },
    ],
  },
  {
    id: 'python-mutable-default-argument',
    title: 'Python: mutable default argument shared across calls',
    category: 'known-bug',
    description:
      'A module-level function is given a `list` default argument, which Python evaluates once at import time and shares across every call that omits it.',
    pullRequestTitle: 'Collect validation warnings',
    pullRequestBody: 'Adds a helper that appends warnings for a record.',
    files: [
      modifiedFile('app/validation/warnings.py', 120, 120, [
        ' def build_summary(record) -> str:',
        '     return f"record {record[\'id\']}"',
        '+  # Look up related context before proceeding.',
        '+  # This mirrors the pattern used elsewhere in this module.',
        '+  # No behavior change expected from this step alone.',
        '+def collect_warnings(record, warnings=[]):',
        '+    if record.get("legacy"):',
        '+        warnings.append("legacy record")',
        '+    return warnings',
        ' ',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'app/validation/warnings.py',
        startLine: 125,
        endLine: 128,
        severity: 'medium',
        description:
          '`warnings=[]` is evaluated once at import time; warnings appended on one call to `collect_warnings` persist into the next call that omits the argument.',
      },
    ],
  },
  {
    id: 'unvalidated-redirect',
    title: 'Open redirect via an unvalidated `next` parameter',
    category: 'known-bug',
    description:
      'Redirects to a URL taken directly from a query parameter with no allowlist check.',
    pullRequestTitle: 'Redirect back to the originating page after login',
    pullRequestBody: 'Uses the `next` query parameter to return the user to where they started.',
    files: [
      modifiedFile('src/auth/redirect-after-login.ts', 12, 12, [
        ' export function redirectAfterLogin(res: Response, query: Query): void {',
        '   const fallback = "/dashboard";',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const target = query.next ?? fallback;',
        '+  res.redirect(target);',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/auth/redirect-after-login.ts',
        startLine: 17,
        endLine: 18,
        severity: 'high',
        description:
          '`query.next` is attacker-controlled; redirecting to it unchecked enables an open-redirect phishing vector.',
      },
    ],
  },
  {
    id: 'timing-unsafe-token-compare',
    title: 'Secret token compared with `===` instead of a constant-time check',
    category: 'known-bug',
    description:
      'Compares a webhook signature with plain string equality, which short-circuits and leaks timing information.',
    pullRequestTitle: 'Verify inbound webhook signatures',
    pullRequestBody: 'Rejects webhook deliveries with a bad signature.',
    files: [
      modifiedFile('src/webhooks/verify.ts', 7, 7, [
        ' export function verifySignature(expected: string, provided: string): boolean {',
        '   if (!provided) return false;',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const valid = provided === expected;',
        '+  return valid;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/webhooks/verify.ts',
        startLine: 12,
        endLine: 12,
        severity: 'medium',
        description:
          '`===` on secrets is not constant-time; use `crypto.timingSafeEqual` to avoid a timing side channel.',
      },
    ],
  },
  {
    id: 'promise-all-fails-fast-loses-partial-results',
    title: 'Promise.all abandons completed work when one item fails',
    category: 'known-bug',
    description:
      'Uses `Promise.all` to send several independent notifications; one failure discards the results of the ones that already succeeded, with no per-item error handling.',
    pullRequestTitle: 'Send digest emails to a batch of subscribers',
    pullRequestBody: 'Sends the weekly digest to every subscriber in a batch.',
    files: [
      modifiedFile('src/digest/send-batch.ts', 1, 1, [
        ' export async function sendDigestBatch(subscribers: Subscriber[]): Promise<void> {',
        '   const client = getMailClient();',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  await Promise.all(',
        '+    subscribers.map((s) => client.send(s.email, buildDigest(s))),',
        '+  );',
        '   // batch sent',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/digest/send-batch.ts',
        startLine: 6,
        endLine: 8,
        severity: 'low',
        description:
          'One rejected send aborts `Promise.all` and the outcome of every other send is discarded; use `allSettled` and report per-subscriber failures.',
      },
    ],
  },
  {
    id: 'decoy-clean-second-file',
    title: 'A real bug in one file, alongside a genuinely clean second file',
    category: 'known-bug',
    description:
      'The PR touches two files in one commit; only the first has a bug. Exercises that matching is keyed by filename, not just line proximity - a prediction on the clean second file is a false positive, not a match.',
    pullRequestTitle: 'Add scratch-file cleanup helpers',
    pullRequestBody: 'Adds a helper to create a temp scratch file and one to remove it.',
    files: [
      modifiedFile('src/tmp/scratch-file.ts', 25, 25, [
        ' export function createScratchFile(prefix: string): string {',
        '   const dir = "/tmp/app-scratch";',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const name = `${prefix}-${Date.now()}.tmp`;',
        '+  const fullPath = `${dir}/${name}`;',
        '+  fs.writeFileSync(fullPath, "");',
        '   return fullPath;',
        ' }',
      ]),
      modifiedFile('src/tmp/cleanup.ts', 1, 1, [
        ' export function removeScratchFile(path: string): void {',
        '   if (!fs.existsSync(path)) return;',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  fs.unlinkSync(path);',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/tmp/scratch-file.ts',
        startLine: 30,
        endLine: 32,
        severity: 'medium',
        description:
          'The scratch filename is predictable (prefix + timestamp only), letting another process race to create the same path first (symlink/TOCTOU risk).',
      },
    ],
  },
  {
    id: 'two-findings-different-files',
    title: 'Two independent bugs in the same PR, in different files',
    category: 'known-bug',
    description:
      'Exercises one-to-one matching across files in a single case: a missing-await bug in one file and a hardcoded secret in another, both real and both expected to be caught.',
    pullRequestTitle: 'Add event dispatch and a feature-flag override',
    pullRequestBody: 'Dispatches notification events and reads a feature-flag override token.',
    files: [
      modifiedFile('src/notifications/dispatch.ts', 8, 8, [
        ' export async function dispatchNotification(event: Event): Promise<void> {',
        '   const channel = resolveChannel(event.type);',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  channel.send(event.payload);',
        '+  recordDispatch(event.id);',
        '   return;',
        ' }',
      ]),
      modifiedFile('src/config/read-flag.ts', 45, 45, [
        ' export function readFeatureFlag(name: string): boolean {',
        '   const flags = loadFlagsFromEnv();',
        '+  // Look up related context before proceeding.',
        '+  // This mirrors the pattern used elsewhere in this module.',
        '+  // No behavior change expected from this step alone.',
        '+  const overrideToken = "flagtoken_live_9f8a7b6c5d4e3f2a1b0c";',
        '+  return flags[name] ?? Boolean(overrideToken);',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [
      {
        filename: 'src/notifications/dispatch.ts',
        startLine: 13,
        endLine: 13,
        severity: 'medium',
        description: '`channel.send` returns a promise that is never awaited or caught.',
      },
      {
        filename: 'src/config/read-flag.ts',
        startLine: 50,
        endLine: 50,
        severity: 'critical',
        description:
          'A live-looking override token is hardcoded rather than loaded from config/env.',
      },
    ],
  },
];
