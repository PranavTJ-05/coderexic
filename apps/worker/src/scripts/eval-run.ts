/**
 * ROADMAP.md Phase 15's automated evaluation runner. Loads every fixture
 * case (`@coderexic/core`'s `ALL_EVAL_CASES`), runs each one through a
 * model, scores the result against the *same* post-processing pipeline
 * production uses (`runEvaluation` -> `scoreCase` -> `runProductionPipeline`,
 * which mirrors `apps/worker/src/review/pipeline.ts`'s
 * `publishAndComplete`), and prints an aggregate report.
 *
 * Two modes:
 *
 *   pnpm eval:scripted [--scripted-output <file.json>] [--prices <file.json>]
 *     No network calls, no API key needed - safe for CI. Without
 *     `--scripted-output`, uses a built-in oracle that returns each case's
 *     own expected findings, which proves the harness end to end (perfect
 *     score on every known-bug case, zero false positives on every
 *     false-positive-trap case) without spending anything. Pass
 *     `--scripted-output` to feed it any other pre-recorded model output,
 *     keyed by case id.
 *
 *   pnpm eval:live --provider <name> --i-understand-this-spends-real-money
 *       [--model <name>] [--prices <file.json>]
 *     Calls a real, configured provider once per fixture case. This costs
 *     real money and needs that provider's API key set
 *     (ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY/GROQ_API_KEY). Ask
 *     the user before running this - see ROADMAP.md Phase 15.
 *
 * `--prices <file.json>` is an explicit price-per-million-token table, not a
 * hardcoded guess (ARCHITECTURE.md's "verify, don't guess" applies to
 * pricing too). Shape:
 *   { "<provider>:<model>": { "inputPerMillionTokens": <usd>, "outputPerMillionTokens": <usd> } }
 * e.g. { "anthropic:claude-opus-5": { "inputPerMillionTokens": 5, "outputPerMillionTokens": 25 } }
 * Without it (or without token usage for a case, e.g. Gemini's live path
 * below), cost is reported as "n/a" rather than a fabricated number.
 *
 * Exits non-zero only when the harness itself fails (bad arguments, an
 * invalid --min-severity, a missing/invalid scripted-output or prices
 * file). A single case's live model failure does not abort the run - it's
 * scored as an empty review and logged as a warning, so one bad case
 * doesn't discard every other (already paid-for) result. This never gates
 * on a quality threshold - no real-model baseline has been measured yet,
 * so there is nothing agreed-on to gate against (ROADMAP.md Phase 15).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ALL_EVAL_CASES,
  buildLiveReviewer,
  buildProviderRegistry,
  createLogger,
  modelReviewOutputSchema,
  runEvaluation,
  SEVERITIES,
  SUPPORTED_MODEL_PROVIDERS,
  withFailureHandling,
  type EvalCase,
  type EvalModelAdapter,
  type EvalUsage,
  type ModelReviewOutput,
  type PriceTable,
  type ProviderCredentials,
  type Severity,
  type SupportedModelProvider,
} from '@coderexic/core';

/** Matches production's one-shot deadline default (`maxReviewSeconds`'s 60s default). */
const LIVE_CALL_TIMEOUT_MS = 60_000;

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'scripted' },
    'scripted-output': { type: 'string' },
    prices: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'min-severity': { type: 'string', default: 'low' },
    'i-understand-this-spends-real-money': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJsonFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`could not read ${label} file "${path}": ${errorMessage(err)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    fail(`${label} file "${path}" is not valid JSON: ${errorMessage(err)}`);
  }
}

function loadPrices(): PriceTable | undefined {
  if (!values.prices) return undefined;
  // Not schema-validated: a malformed price table only makes cost report "n/a"
  // (computeCostUsd looks up a missing key the same way), never a wrong number.
  return readJsonFile(values.prices, 'prices') as PriceTable;
}

if (!SEVERITIES.includes(values['min-severity'] as Severity)) {
  fail(`--min-severity must be one of: ${SEVERITIES.join(', ')}, got "${values['min-severity']}"`);
}
const MIN_SEVERITY = values['min-severity'] as Severity;

/**
 * The built-in scripted oracle: reports exactly each case's own expected
 * findings. Proves the harness (fixtures -> pipeline -> scoring -> report)
 * works end to end without a model, an API key, or any spend - the CI-safe
 * default (ROADMAP.md Phase 15's honesty gate).
 */
function oracleOutputFor(evalCase: EvalCase): ModelReviewOutput {
  return {
    summary: `oracle: ${evalCase.expectedFindings.length} expected finding(s)`,
    reviews: evalCase.expectedFindings.map((f) => ({
      filename: f.filename,
      severity: f.severity,
      start_line: f.startLine,
      end_line: f.endLine,
      issue: f.description,
      fix_type: 'warning' as const,
      suggested_code: null,
    })),
  };
}

function scriptedAdapter(scriptedOutputPath: string | undefined): EvalModelAdapter {
  const scripted = scriptedOutputPath
    ? (readJsonFile(scriptedOutputPath, 'scripted-output') as Record<string, unknown>)
    : undefined;
  return {
    review(evalCase: EvalCase) {
      const raw = scripted ? scripted[evalCase.id] : undefined;
      if (scripted && raw === undefined) {
        fail(`scripted-output file has no entry for case "${evalCase.id}"`);
      }
      const candidate = raw ?? oracleOutputFor(evalCase);
      const parsed = modelReviewOutputSchema.safeParse(candidate);
      if (!parsed.success) {
        fail(
          `scripted output for case "${evalCase.id}" failed schema validation: ` +
            parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const usage: EvalUsage = { durationMs: 0 };
      return Promise.resolve({ output: parsed.data, usage });
    },
  };
}

/**
 * Builds the live-mode adapter: `buildLiveReviewer`/`withFailureHandling`
 * (`@coderexic/core`'s `evaluation/live.ts`, unit-tested there with a fake
 * `AgentAdapter`) do the actual work; this only wires up API keys, model
 * names and the confirmation gate.
 */
function liveAdapter(
  provider: SupportedModelProvider,
  modelOverride: string | undefined,
): { adapter: EvalModelAdapter; modelName: string; failureCount: () => number } {
  if (!values['i-understand-this-spends-real-money']) {
    fail(
      '--live mode calls a real model and spends real money. Re-run with ' +
        "--i-understand-this-spends-real-money once you have the user's go-ahead " +
        '(ROADMAP.md Phase 15: "ask the user before running pnpm eval:live").',
    );
  }
  const envKey = {
    gemini: process.env.GEMINI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    groq: process.env.GROQ_API_KEY,
  }[provider];
  if (!envKey) {
    fail(`no API key set for provider "${provider}" (expected an env var like ANTHROPIC_API_KEY)`);
  }
  const defaultModel = {
    gemini: 'gemini-3.6-flash',
    openai: 'gpt-5.1',
    anthropic: 'claude-opus-5',
    groq: 'openai/gpt-oss-20b',
  }[provider];
  const modelName = modelOverride ?? defaultModel;
  const logger = createLogger({ name: 'eval-run', level: 'warn' });
  const credentials: ProviderCredentials = { [provider]: { apiKey: envKey, model: modelName } };
  const registry = buildProviderRegistry(credentials, logger);
  const entry = registry[provider];
  if (!entry) fail(`buildProviderRegistry did not build a "${provider}" entry`);

  const reviewOnce = buildLiveReviewer(provider, entry, LIVE_CALL_TIMEOUT_MS);
  let failures = 0;
  const adapter = withFailureHandling(reviewOnce, (evalCase, err) => {
    failures += 1;
    process.stderr.write(
      `warning: case "${evalCase.id}" failed (${err.name}: ${err.message}); scoring it as an empty review\n`,
    );
  });
  return { adapter, modelName, failureCount: () => failures };
}

async function main(): Promise<void> {
  if (values.mode !== 'scripted' && values.mode !== 'live') {
    fail(`--mode must be "scripted" or "live", got "${values.mode}"`);
  }
  const prices = loadPrices();

  let adapter: EvalModelAdapter;
  let provider = 'scripted';
  let modelName = 'oracle';
  let failureCount = () => 0;

  if (values.mode === 'scripted') {
    adapter = scriptedAdapter(values['scripted-output']);
  } else {
    if (
      !values.provider ||
      !SUPPORTED_MODEL_PROVIDERS.includes(values.provider as SupportedModelProvider)
    ) {
      fail(
        `--provider is required for --mode live, one of: ${SUPPORTED_MODEL_PROVIDERS.join(', ')}`,
      );
    }
    provider = values.provider;
    const live = liveAdapter(values.provider as SupportedModelProvider, values.model);
    adapter = live.adapter;
    modelName = live.modelName;
    failureCount = live.failureCount;
  }

  const report = await runEvaluation(ALL_EVAL_CASES, adapter, {
    minimumSeverity: MIN_SEVERITY,
    provider,
    model: modelName,
    ...(prices && { prices }),
  });

  const fmt = (n: number | null, digits = 3) => (n === null ? 'n/a' : n.toFixed(digits));
  process.stdout.write(`\nCoderexic eval report (${values.mode} mode, ${provider}:${modelName})\n`);
  process.stdout.write('='.repeat(60) + '\n');
  for (const c of report.cases) {
    process.stdout.write(
      `  [${c.category}] ${c.id}: predicted=${c.predictedCount} expected=${c.expectedCount} ` +
        `matched=${c.matchedCount} precision=${fmt(c.precision)} recall=${fmt(c.recall)} ` +
        `duration=${c.durationMs}ms\n`,
    );
  }
  process.stdout.write('-'.repeat(60) + '\n');
  process.stdout.write(`  cases: ${report.caseCount}\n`);
  if (failureCount() > 0) {
    process.stdout.write(
      `  failed cases: ${failureCount()} (model call failed; scored as an empty review - see warnings above)\n`,
    );
  }
  process.stdout.write(`  overall precision: ${fmt(report.precision)}\n`);
  process.stdout.write(`  overall recall: ${fmt(report.recall)}\n`);
  process.stdout.write(
    `  line accuracy (exact match, matched pairs only): ${fmt(report.lineAccuracy)}\n`,
  );
  process.stdout.write(
    `  severity accuracy (matched pairs only): ${fmt(report.severityAccuracy)}\n`,
  );
  process.stdout.write(
    `  total cost: ${report.totalCostUsd === null ? 'n/a (no --prices given, or no token usage)' : `$${report.totalCostUsd.toFixed(4)}`}\n`,
  );
  process.stdout.write(
    `  avg latency: ${report.avgDurationMs === null ? 'n/a' : `${report.avgDurationMs.toFixed(0)}ms`}\n`,
  );
  process.stdout.write(
    '\nNOTE: this is a harness/scoring-machinery smoke test, not a quality baseline. ' +
      'No live-model baseline has been measured against these fixtures yet ' +
      '(ROADMAP.md Phase 15).\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `eval run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
