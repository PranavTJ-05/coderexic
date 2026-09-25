import 'server-only';
import { SUPPORTED_MODEL_PROVIDERS, updateRepositorySettings } from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRepoAdmin, requireSameOriginJson } from '../../../../../src/authorize';
import { db } from '../../../../../src/db';
import { loadWebEnv } from '../../../../../src/env';

const updateSettingsSchema = z.object({
  modelProvider: z.enum(SUPPORTED_MODEL_PROVIDERS).nullable().optional(),
  modelName: z.string().min(1).max(200).nullable().optional(),
  minimumSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

/**
 * Admin-only: updates the repo-level model provider/name and minimum
 * severity. Reading these values happens through
 * `GET /api/repositories/[repositoryId]` instead - every authorized user
 * can read; only a repo admin can write.
 */
export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ repositoryId: string }> },
) {
  const originCheck = requireSameOriginJson(req, loadWebEnv().NEXTAUTH_URL);
  if (originCheck) return originCheck;

  const { repositoryId } = await context.params;
  const result = await requireRepoAdmin(req, repositoryId);
  if (!result.ok) return result.response;

  const parsed = updateSettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // exactOptionalPropertyTypes: zod's `.optional()` fields are typed
  // `T | undefined` even when absent from the parsed object; strip actual
  // `undefined` entries so the store function's stricter "absent means
  // untouched" type (no explicit `undefined` values) is satisfied.
  const update = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  );
  const updated = await updateRepositorySettings(db().db, repositoryId, update);
  if (!updated) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
