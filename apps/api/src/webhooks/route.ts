import {
  markWebhookEvent,
  recordWebhookEvent,
  verifyWebhookSignature,
  type Database,
} from '@coderexic/core';
import type { FastifyInstance } from 'fastify';
import { handleWebhookEvent, WebhookPayloadError } from './handlers.js';

/** GitHub caps webhook payloads at 25 MB. */
export const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;

export interface WebhookRouteOptions {
  db: Database;
  secret: string;
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
  { db, secret }: WebhookRouteOptions,
): Promise<void> {
  await app.register((scope, _options, done) => {
    // The signature covers the exact bytes GitHub sent, so keep the raw body.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post('/webhooks/github', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ error: 'expected a JSON body' });
      }
      if (
        !verifyWebhookSignature(secret, rawBody, header(request.headers['x-hub-signature-256']))
      ) {
        request.log.warn('webhook signature rejected');
        return reply.code(401).send({ error: 'invalid signature' });
      }
      const eventName = header(request.headers['x-github-event']);
      const deliveryId = header(request.headers['x-github-delivery']);
      if (!eventName || !deliveryId) {
        return reply.code(400).send({ error: 'missing GitHub event headers' });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
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
        return { status: 'duplicate' };
      }

      try {
        const outcome = await db.transaction(async (tx) => {
          const result = await handleWebhookEvent({ db: tx, log, deliveryId }, eventName, payload);
          await markWebhookEvent(tx, event.id, result.status, {
            ...(result.installationId !== undefined && { installationId: result.installationId }),
          });
          return result;
        });
        if (outcome.status === 'IGNORED') log.debug({ reason: outcome.reason }, 'delivery ignored');
        return { status: outcome.status.toLowerCase() };
      } catch (err) {
        await markWebhookEvent(db, event.id, 'FAILED');
        if (err instanceof WebhookPayloadError) {
          log.warn('webhook payload failed validation');
          return reply.code(400).send({ error: err.message });
        }
        log.error({ err }, 'webhook processing failed');
        return reply.code(500).send({ error: 'processing failed' });
      }
    });
    done();
  });
}
