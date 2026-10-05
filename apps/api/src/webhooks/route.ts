import {
  createNoopMetrics,
  createSignatureFailureLimiter,
  enqueueIndexRun,
  enqueueReviewJob,
  markWebhookEvent,
  recordWebhookEvent,
  verifyWebhookSignature,
  type Database,
  type IndexQueueJob,
  type Metrics,
  type ReviewQueueJob,
  type SignatureFailureLimiter,
} from '@coderexic/core';
import rateLimit from '@fastify/rate-limit';
import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { handleWebhookEvent, WebhookPayloadError } from './handlers.js';

/** GitHub caps webhook payloads at 25 MB. */
export const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;

/**
 * Generous cap on signature-verified-or-not traffic reaching this route at
 * all, applied at `onRequest` - before the 25 MB body is even buffered - so
 * an unauthenticated caller can no longer exhaust memory/bandwidth just by
 * sending repeated large POSTs (ROADMAP.md Phase 16's webhook security
 * audit). Sized well above any realistic legitimate burst: GitHub does not
 * automatically redeliver a failed delivery (confirmed against GitHub's
 * webhook docs), so a cap here that's too tight would silently drop real
 * reviews with no retry - worse than the abuse it prevents. The tighter,
 * targeted limit is `SignatureFailureLimiter` below, which only throttles
 * requests that have already failed signature verification.
 */
export const WEBHOOK_RATE_LIMIT = { max: 600, timeWindow: '1 minute' } as const;

export interface WebhookRouteOptions {
  db: Database;
  secret: string;
  /** Enqueues review jobs after their creating transaction commits. */
  reviewQueue: Queue<ReviewQueueJob>;
  /** Enqueues index runs after their creating transaction commits. */
  indexQueue: Queue<IndexQueueJob>;
  metrics?: Metrics;
  /**
   * Throttles requests that already failed signature verification, keyed
   * by `request.ip`. Defaults to a real in-memory limiter; overridable for
   * tests. These are, by definition, not legitimate GitHub traffic.
   */
  signatureFailureLimiter?: SignatureFailureLimiter;
  /** Overrides {@link WEBHOOK_RATE_LIMIT}; only ever set in tests. */
  webhookRateLimit?: { max: number; timeWindow: string };
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * POST /webhooks/github: verify the signature over the raw bytes, record the
 * delivery once, apply it in a transaction and answer quickly. Deliveries
 * already processed (GitHub retries and redeliveries) are acknowledged
 * without being applied again; failed ones are retried.
 */
export async function registerWebhookRoutes(
  app: FastifyInstance,
  {
    db,
    secret,
    reviewQueue,
    indexQueue,
    metrics = createNoopMetrics(),
    signatureFailureLimiter = createSignatureFailureLimiter(),
    webhookRateLimit = WEBHOOK_RATE_LIMIT,
  }: WebhookRouteOptions,
): Promise<void> {
  await app.register(async (scope) => {
    // The signature covers the exact bytes GitHub sent, so keep the raw body.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // Must be awaited: @fastify/rate-limit's per-route `config.rateLimit`
    // only takes effect once this plugin has actually finished
    // registering - an un-awaited `scope.register` here silently leaves
    // every route in this scope unrated-limited.
    await scope.register(rateLimit, { global: false });

    // Runs before the body is parsed, so a caller already blocked for
    // repeated signature failures never gets a 25 MB buffer allocated for
    // them again.
    scope.addHook('onRequest', async (request, reply) => {
      if (signatureFailureLimiter.isBlocked(request.ip)) {
        metrics.recordWebhookDelivery({ event: 'unverified', action: null, outcome: 'unverified' });
        return reply.code(429).send({ error: 'too many invalid signatures' });
      }
    });

    scope.post(
      '/webhooks/github',
      { bodyLimit: WEBHOOK_BODY_LIMIT, config: { rateLimit: webhookRateLimit } },
      async (request, reply) => {
        const rawBody = request.body;
        if (!Buffer.isBuffer(rawBody)) {
          metrics.recordWebhookDelivery({ event: 'unverified', action: null, outcome: 'invalid' });
          return reply.code(400).send({ error: 'expected a JSON body' });
        }
        if (
          !verifyWebhookSignature(secret, rawBody, header(request.headers['x-hub-signature-256']))
        ) {
          // x-github-event is attacker-controlled before the signature is verified;
          // never use it as a metric label here.
          request.log.warn('webhook signature rejected');
          signatureFailureLimiter.recordFailure(request.ip);
          metrics.recordWebhookDelivery({
            event: 'unverified',
            action: null,
            outcome: 'unverified',
          });
          return reply.code(401).send({ error: 'invalid signature' });
        }
        const eventName = header(request.headers['x-github-event']);
        const deliveryId = header(request.headers['x-github-delivery']);
        if (!eventName || !deliveryId) {
          metrics.recordWebhookDelivery({
            event: eventName ?? 'unknown',
            action: null,
            outcome: 'invalid',
          });
          return reply.code(400).send({ error: 'missing GitHub event headers' });
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          metrics.recordWebhookDelivery({ event: eventName, action: null, outcome: 'invalid' });
          return reply.code(400).send({ error: 'body is not valid JSON' });
        }
        const action =
          typeof payload === 'object' &&
          payload !== null &&
          'action' in payload &&
          typeof payload.action === 'string'
            ? payload.action
            : null;
        const log = request.log.child({ deliveryId, event: eventName, action });

        const { event, created } = await recordWebhookEvent(db, {
          githubEventId: deliveryId,
          eventName,
          action,
        });
        if (
          !created &&
          (event.deliveryStatus === 'PROCESSED' || event.deliveryStatus === 'IGNORED')
        ) {
          log.info('duplicate delivery acknowledged');
          metrics.recordWebhookDelivery({ event: eventName, action, outcome: 'duplicate' });
          return { status: 'duplicate' };
        }

        try {
          const outcome = await db.transaction(async (tx) => {
            const result = await handleWebhookEvent(
              { db: tx, log, deliveryId },
              eventName,
              payload,
            );
            await markWebhookEvent(tx, event.id, result.status, {
              ...(result.installationId !== undefined && { installationId: result.installationId }),
            });
            return result;
          });
          if (outcome.status === 'IGNORED')
            log.debug({ reason: outcome.reason }, 'delivery ignored');
          if (outcome.reviewJobId) {
            // Enqueued after the transaction committed, so the queue never
            // references a review job the database does not yet have. If
            // this fails, the row stays PENDING and the worker's stale-job
            // sweep re-enqueues it later.
            await enqueueReviewJob(reviewQueue, outcome.reviewJobId).catch((err: unknown) => {
              log.error({ err, reviewJobId: outcome.reviewJobId }, 'failed to enqueue review job');
            });
          }
          if (outcome.indexRunId) {
            await enqueueIndexRun(indexQueue, outcome.indexRunId).catch((err: unknown) => {
              log.error({ err, indexRunId: outcome.indexRunId }, 'failed to enqueue index run');
            });
          }
          metrics.recordWebhookDelivery({
            event: eventName,
            action,
            outcome: outcome.status.toLowerCase(),
          });
          return { status: outcome.status.toLowerCase() };
        } catch (err) {
          await markWebhookEvent(db, event.id, 'FAILED');
          if (err instanceof WebhookPayloadError) {
            log.warn('webhook payload failed validation');
            metrics.recordWebhookDelivery({ event: eventName, action, outcome: 'invalid' });
            return reply.code(400).send({ error: err.message });
          }
          log.error({ err }, 'webhook processing failed');
          metrics.recordWebhookDelivery({ event: eventName, action, outcome: 'failed' });
          return reply.code(500).send({ error: 'processing failed' });
        }
      },
    );
  });
}
