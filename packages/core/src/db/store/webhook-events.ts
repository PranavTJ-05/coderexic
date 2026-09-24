import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { webhookEvents, type WebhookDeliveryStatus } from '../schema.js';

export type WebhookEvent = typeof webhookEvents.$inferSelect;

export interface WebhookEventInput {
  githubEventId: string;
  eventName: string;
  action?: string | null;
  installationId?: string | null;
}

/**
 * Records a delivery. `created: false` means GitHub redelivered an event
 * that was already recorded, and the caller should not process it again.
 */
export async function recordWebhookEvent(
  db: Executor,
  input: WebhookEventInput,
): Promise<{ event: WebhookEvent; created: boolean }> {
  const { action, installationId, ...rest } = input;
  const values = {
    ...rest,
    ...(action !== undefined && { action }),
    ...(installationId !== undefined && { installationId }),
  };
  const [inserted] = await db
    .insert(webhookEvents)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted) return { event: inserted, created: true };
  const [existing] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.githubEventId, input.githubEventId));
  if (!existing) throw new Error('recordWebhookEvent: conflicting event not found');
  return { event: existing, created: false };
}

export async function markWebhookEvent(
  db: Executor,
  id: string,
  deliveryStatus: Exclude<WebhookDeliveryStatus, 'RECEIVED'>,
  update: { installationId?: string | null } = {},
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ deliveryStatus, processedAt: new Date(), ...update })
    .where(eq(webhookEvents.id, id));
}
