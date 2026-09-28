import type { EvalCase } from '../types.js';
import { modifiedFile } from './patch-builder.js';

/**
 * False-positive trap cases (ROADMAP.md Phase 15): code that looks
 * suspicious but is correct. `expectedFindings` is empty for every one of
 * these - any prediction on them counts against precision.
 */
export const FALSE_POSITIVE_CASES: EvalCase[] = [
  {
    id: 'fp-unsafe-named-but-escaped',
    title: '`unsafe` prefix on a value that is actually escaped',
    category: 'false-positive',
    description:
      'The variable is named `unsafeInput` (tempting to flag), but it is escaped before use.',
    pullRequestTitle: 'Render the search term in the results header',
    pullRequestBody: 'Shows what the user searched for above the results.',
    files: [
      modifiedFile('src/search/results-header.ts', 1, 1, [
        ' export function renderResultsHeader(rawQuery: string): string {',
        '   const unsafeInput = rawQuery;',
        '+  const safeInput = escapeHtml(unsafeInput);',
        '+  return `<h1>Results for ${safeInput}</h1>`;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-greedy-looking-but-anchored-regex',
    title: 'Regex looks greedy but is fully anchored',
    category: 'false-positive',
    description:
      'The trailing `[a-zA-Z0-9.]*` group looks like it could over-match, but the whole pattern is anchored with `^` and `$` and the group only covers the optional pre-release suffix, so it cannot match anything outside a well-formed version string.',
    pullRequestTitle: 'Validate semantic version strings',
    pullRequestBody: 'Rejects malformed version strings before parsing.',
    files: [
      modifiedFile('src/versioning/validate.ts', 20, 20, [
        ' export function isValidVersion(input: string): boolean {',
        '   const trimmed = input.trim();',
        '+  const pattern = /^\\d+\\.\\d+\\.\\d+(-[a-zA-Z0-9.]*)?$/;',
        '+  return pattern.test(trimmed);',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-parameterized-query-looks-like-concat',
    title: 'Query text is built with concatenation, but values are bound as parameters',
    category: 'false-positive',
    description:
      'The SQL string has `$1`/`$2` placeholders; user input is passed separately as bound parameters, not concatenated into the string.',
    pullRequestTitle: 'Add order lookup by customer and status',
    pullRequestBody: 'Adds a filtered order lookup for support.',
    files: [
      modifiedFile('src/orders/lookup.ts', 1, 1, [
        ' export async function findOrders(db: Db, customerId: string, status: string) {',
        '   const table = "orders";',
        '+  const query = `SELECT * FROM ${table} WHERE customer_id = $1 AND status = $2`;',
        '+  return db.query(query, [customerId, status]);',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-json-parse-not-eval',
    title: 'Parses JSON with JSON.parse, not eval, despite an eval-like name nearby',
    category: 'false-positive',
    description:
      'A helper named `evaluateConfig` only calls `JSON.parse` internally; no dynamic code execution happens.',
    pullRequestTitle: 'Parse the per-project config file',
    pullRequestBody: 'Reads project config as strict JSON.',
    files: [
      modifiedFile('src/config/evaluate-config.ts', 1, 1, [
        ' export function evaluateConfig(raw: string): Record<string, unknown> {',
        '   const trimmed = raw.trim();',
        '+  const parsed = JSON.parse(trimmed) as Record<string, unknown>;',
        '+  return parsed;',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-sync-function-no-await-needed',
    title: 'No `await` because the called function is synchronous',
    category: 'false-positive',
    description:
      '`formatLabel` returns a plain string, not a promise; calling it without `await` is correct.',
    pullRequestTitle: 'Add a formatted label to the export row',
    pullRequestBody: 'Adds a human-readable label column to CSV exports.',
    files: [
      modifiedFile('src/export/row-label.ts', 1, 1, [
        ' export function buildExportRow(item: Item): ExportRow {',
        '   const base = { id: item.id, amount: item.amount };',
        '+  const label = formatLabel(item);',
        '+  return { ...base, label };',
        '   // end',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-inclusive-loop-bound-is-correct',
    title: 'Inclusive loop bound is intentional and correct here',
    category: 'false-positive',
    description:
      '`<=` looks like the classic off-by-one, but `lastValidIndex` is documented as inclusive, so the bound is right.',
    pullRequestTitle: 'Iterate the valid prefix of a partially-filled buffer',
    pullRequestBody: 'Only processes entries up to (and including) lastValidIndex.',
    files: [
      modifiedFile('src/buffers/process-prefix.ts', 1, 1, [
        ' export function processPrefix(buffer: Entry[], lastValidIndex: number): void {',
        '   // lastValidIndex is inclusive: the buffer guarantees indices 0..lastValidIndex are populated.',
        '+  for (let i = 0; i <= lastValidIndex; i++) {',
        '+    processEntry(buffer[i]);',
        '+  }',
        '   // done',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-catch-rethrows-after-cleanup',
    title: 'Catch block looks like it swallows the error, but rethrows',
    category: 'false-positive',
    description:
      'The catch releases a resource and then rethrows the original error - not silently swallowed.',
    pullRequestTitle: 'Release the lock even when the task fails',
    pullRequestBody: 'Ensures the lock is always released, success or failure.',
    files: [
      modifiedFile('src/locking/run-with-lock.ts', 1, 1, [
        ' export async function runWithLock(lock: Lock, task: () => Promise<void>): Promise<void> {',
        '   await lock.acquire();',
        '+  try {',
        '+    await task();',
        '+  } catch (err) {',
        '+    lock.release();',
        '+    throw err;',
        '+  }',
        '   lock.release();',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-placeholder-secret-in-test-fixture',
    title: 'Secret-looking string is a documented test fixture constant',
    category: 'false-positive',
    description:
      "The string lives in a `*.fixtures.ts` file, is clearly named as a test constant, and matches no real provider's key format.",
    pullRequestTitle: 'Add a fixture for the webhook signature test',
    pullRequestBody: 'Adds the constant used by the webhook signature unit tests.',
    files: [
      modifiedFile('src/webhooks/verify.fixtures.ts', 1, 1, [
        ' /** Fixture constants for webhooks/verify.test.ts - not real credentials. */',
        ' export const TEST_WEBHOOK_ID = "wh_test_0001";',
        '+export const TEST_WEBHOOK_SECRET = "test-secret-not-a-real-key-0001";',
        '+export const TEST_WEBHOOK_PAYLOAD = \'{"event":"ping"}\';',
        ' export const TEST_WEBHOOK_TIMESTAMP = 1700000000;',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-loose-equals-null-check-idiom',
    title: '`== null` is the standard idiom for catching both null and undefined',
    category: 'false-positive',
    description:
      '`value == null` is a well-known, intentional idiom to match both `null` and `undefined`; it is not a stray loose-equality bug.',
    pullRequestTitle: 'Skip optional fields when building the export payload',
    pullRequestBody: 'Leaves a field out of the payload when it has no value.',
    files: [
      modifiedFile('src/export/build-payload.ts', 1, 1, [
        ' export function buildPayload(fields: Record<string, unknown>): Record<string, unknown> {',
        '   const payload: Record<string, unknown> = {};',
        '+  for (const [key, value] of Object.entries(fields)) {',
        '+    if (value == null) continue;',
        '+    payload[key] = value;',
        '+  }',
        '   return payload;',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
  {
    id: 'fp-connection-released-in-finally',
    title: 'Connection release looks missing but is handled in a finally block',
    category: 'false-positive',
    description:
      'The early return happens before `finally`, but `finally` always runs, so the connection is released on every path.',
    pullRequestTitle: 'Validate order total before charging',
    pullRequestBody: 'Rejects invalid order totals before running the charge.',
    files: [
      modifiedFile('src/billing/charge-order-safe.ts', 1, 1, [
        ' export async function chargeOrderSafely(pool: Pool, order: Order): Promise<void> {',
        '   const connection = await pool.acquire();',
        '+  try {',
        '+    if (order.total <= 0) {',
        '+      throw new Error("invalid order total");',
        '+    }',
        '+    await connection.query("UPDATE orders SET charged = true WHERE id = $1", [order.id]);',
        '+  } finally {',
        '+    connection.release();',
        '+  }',
        ' }',
      ]),
    ],
    expectedFindings: [],
  },
];
