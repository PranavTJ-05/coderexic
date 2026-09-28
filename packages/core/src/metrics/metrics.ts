import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Queue } from 'bullmq';

/**
 * ROADMAP.md Phase 14 (Observability). Every counter/histogram/gauge here
 * is deliberately unlabeled by anything with unbounded cardinality -
 * never repositoryId, reviewJobId, PR number, or a raw URL/path. Labels
 * are always a small fixed set (event name, provider name, status enum,
 * route template).
 *
 * Metrics are injected as a dependency (like `Logger`), never imported as a
 * process-global: each `buildServer`/`createReviewWorker` call creates its
 * own `Registry`, so tests that build the server/worker repeatedly (see
 * server.test.ts, worker-pipeline.test.ts) never hit prom-client's "metric
 * already registered" error from sharing its global default registry.
 */
export interface Metrics {
  readonly registry: Registry;
  recordWebhookDelivery(input: { event: string; action: string | null; outcome: string }): void;
  recordReviewOutcome(input: {
    status: string;
    provider: string;
    mode: 'one_shot' | 'agent';
    durationMs: number;
  }): void;
  recordModelUsage(input: {
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  }): void;
  recordAgentRun(input: {
    turnCount: number;
    fileFetchCount: number;
    terminationReason: string;
  }): void;
  recordToolCall(input: { tool: string; status: string }): void;
  recordError(errorCode: string): void;
  observeHttpRequest(input: {
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  }): void;
  /** Registers a BullMQ queue so its job counts (waiting/active/...) are sampled on scrape. */
  registerQueue(name: string, queue: Pick<Queue, 'getJobCounts'>): void;
}

const PREFIX = 'coderexic_';

/** Real prom-client-backed metrics, registered on their own `Registry`. */
export function createMetrics(registry: Registry = new Registry()): Metrics {
  const webhookDeliveries = new Counter({
    name: `${PREFIX}webhook_deliveries_total`,
    help: 'GitHub webhook deliveries by event, action and outcome',
    labelNames: ['event', 'action', 'outcome'],
    registers: [registry],
  });

  const reviewDuration = new Histogram({
    name: `${PREFIX}review_duration_seconds`,
    help: 'Review duration by final status, provider and mode',
    labelNames: ['status', 'provider', 'mode'],
    buckets: [1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300],
    registers: [registry],
  });

  const modelTokens = new Counter({
    name: `${PREFIX}model_tokens_total`,
    help: 'Model tokens consumed by provider, model and direction',
    labelNames: ['provider', 'model', 'direction'],
    registers: [registry],
  });

  const agentTurns = new Histogram({
    name: `${PREFIX}agent_turns`,
    help: 'Agent-loop turn count per run',
    buckets: [1, 2, 3, 5, 8, 12, 16, 20],
    registers: [registry],
  });

  const agentFileFetches = new Histogram({
    name: `${PREFIX}agent_file_fetches`,
    help: 'Agent-loop file-fetch tool calls per run',
    buckets: [0, 1, 2, 4, 6, 8, 12, 16],
    registers: [registry],
  });

  const agentTerminations = new Counter({
    name: `${PREFIX}agent_terminations_total`,
    help: 'Agent-loop runs by termination reason',
    labelNames: ['reason'],
    registers: [registry],
  });

  const agentToolCalls = new Counter({
    name: `${PREFIX}agent_tool_calls_total`,
    help: 'Agent-loop tool calls by tool name and outcome status',
    labelNames: ['tool', 'status'],
    registers: [registry],
  });

  const errors = new Counter({
    name: `${PREFIX}errors_total`,
    help: 'Errors by error code',
    labelNames: ['code'],
    registers: [registry],
  });

  const httpRequestDuration = new Histogram({
    name: `${PREFIX}http_request_duration_seconds`,
    help: 'HTTP request duration by method, route template and status code',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const registeredQueues: { name: string; queue: Pick<Queue, 'getJobCounts'> }[] = [];
  new Gauge({
    name: `${PREFIX}queue_jobs`,
    help: 'BullMQ job counts by queue name and state',
    labelNames: ['queue', 'state'],
    registers: [registry],
    async collect() {
      for (const { name, queue } of registeredQueues) {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
        );
        for (const [state, count] of Object.entries(counts)) {
          this.set({ queue: name, state }, count);
        }
      }
    },
  });

  return {
    registry,
    recordWebhookDelivery({ event, action, outcome }) {
      webhookDeliveries.inc({ event, action: action ?? 'none', outcome });
    },
    recordReviewOutcome({ status, provider, mode, durationMs }) {
      reviewDuration.observe({ status, provider, mode }, durationMs / 1000);
    },
    recordModelUsage({ provider, model, inputTokens, outputTokens }) {
      if (inputTokens !== undefined)
        modelTokens.inc({ provider, model, direction: 'input' }, inputTokens);
      if (outputTokens !== undefined) {
        modelTokens.inc({ provider, model, direction: 'output' }, outputTokens);
      }
    },
    recordAgentRun({ turnCount, fileFetchCount, terminationReason }) {
      agentTurns.observe(turnCount);
      agentFileFetches.observe(fileFetchCount);
      agentTerminations.inc({ reason: terminationReason });
    },
    recordToolCall({ tool, status }) {
      agentToolCalls.inc({ tool, status });
    },
    recordError(errorCode) {
      errors.inc({ code: errorCode });
    },
    observeHttpRequest({ method, route, statusCode, durationSeconds }) {
      httpRequestDuration.observe(
        { method, route, status_code: String(statusCode) },
        durationSeconds,
      );
    },
    registerQueue(name, queue) {
      registeredQueues.push({ name, queue });
    },
  };
}

/**
 * A metrics implementation that records nothing, for call sites and tests
 * that don't care about metrics. `deps.metrics` defaults to this everywhere
 * it's optional, so existing tests that never pass it are unaffected.
 */
export function createNoopMetrics(): Metrics {
  return {
    registry: new Registry(),
    recordWebhookDelivery() {},
    recordReviewOutcome() {},
    recordModelUsage() {},
    recordAgentRun() {},
    recordToolCall() {},
    recordError() {},
    observeHttpRequest() {},
    registerQueue() {},
  };
}
