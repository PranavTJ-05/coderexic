import 'server-only';
import { addIgnorePattern, removeIgnorePattern } from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRepoAdmin, requireSameOriginJson } from '../../../../../src/authorize';
import { db } from '../../../../../src/db';
import { loadWebEnv } from '../../../../../src/env';

const patternSchema = z.object({ pattern: z.string().min(1).max(500) });

/** Admin-only: adds an ignore-glob (idempotent - re-adding an existing one is a no-op, not a 409). */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ repositoryId: string }> },
) {
  const originCheck = requireSameOriginJson(req, loadWebEnv().NEXTAUTH_URL);
  if (originCheck) return originCheck;

  const { repositoryId } = await context.params;
  const result = await requireRepoAdmin(req, repositoryId);
  if (!result.ok) return result.response;

  const parsed = patternSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await addIgnorePattern(db().db, repositoryId, parsed.data.pattern);
  return NextResponse.json({ ok: true });
}

/** Admin-only: removes an ignore-glob (idempotent - removing an absent one is a no-op, not a 404). */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ repositoryId: string }> },
) {
  const originCheck = requireSameOriginJson(req, loadWebEnv().NEXTAUTH_URL);
  if (originCheck) return originCheck;

  const { repositoryId } = await context.params;
  const result = await requireRepoAdmin(req, repositoryId);
  if (!result.ok) return result.response;

  const pattern = req.nextUrl.searchParams.get('pattern');
  if (!pattern) {
    return NextResponse.json({ error: 'pattern query param is required' }, { status: 400 });
  }

  await removeIgnorePattern(db().db, repositoryId, pattern);
  return NextResponse.json({ ok: true });
}
