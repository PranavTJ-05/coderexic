import 'server-only';
import {
  deleteModelCredential,
  listModelCredentials,
  replaceModelCredential,
  SUPPORTED_MODEL_PROVIDERS,
  validateModelCredential,
} from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRepoAdmin, requireSameOriginJson } from '../../../../../src/authorize';
import { db } from '../../../../../src/db';
import { loadWebEnv } from '../../../../../src/env';
import { getModelCredentialsConfig } from '../../../../../src/model-credentials';

const setCredentialSchema = z.object({
  provider: z.enum(SUPPORTED_MODEL_PROVIDERS),
  apiKey: z.string().min(1).max(2000),
});

/**
 * Admin-only: sets (creates or rotates) this repository's own BYOK key for
 * a provider. The key is validated against the provider's own API (a
 * no-token/no-cost models-list call, same as `checkProviderHealth`)
 * *before* it's ever stored - a bad key is rejected here, not discovered
 * the next time a review runs and silently fails.
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

  // Checked after authorization, not before: whether this deployment has
  // BYOK configured at all isn't information an unauthenticated or
  // non-admin caller needs to learn from this route.
  const config = getModelCredentialsConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'BYOK is not configured on this deployment (MODEL_CREDENTIALS_MASTER_KEYS unset)' },
      { status: 501 },
    );
  }

  const parsed = setCredentialSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { provider, apiKey } = parsed.data;

  const validation = await validateModelCredential(provider, apiKey);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'the provider rejected this key', reason: validation.reason },
      { status: 422 },
    );
  }

  await replaceModelCredential(
    db().db,
    { userId: result.ctx.userId, repositoryId, provider },
    apiKey,
    { masterKeys: config.masterKeys, keyVersion: config.currentKeyVersion },
  );
  return NextResponse.json({ ok: true });
}

/** Admin-only: removes this repository's BYOK key for a provider, if it has one. */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ repositoryId: string }> },
) {
  const { repositoryId } = await context.params;
  const result = await requireRepoAdmin(req, repositoryId);
  if (!result.ok) return result.response;

  const provider = req.nextUrl.searchParams.get('provider');
  if (!provider) {
    return NextResponse.json({ error: 'provider query param is required' }, { status: 400 });
  }

  const credentials = await listModelCredentials(db().db, { repositoryId });
  const credential = credentials.find((c) => c.provider === provider);
  if (credential) {
    await deleteModelCredential(db().db, credential.id);
  }
  return NextResponse.json({ ok: true });
}
