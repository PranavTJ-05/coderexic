import 'server-only';
import {
  findAuthorizedReviewJob,
  findReviewWithFindings,
  GitHubUserAccessError,
} from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '../../../../src/db';
import { getAccessToken } from '../../../../src/session';
import { toReviewDetailDto } from '../../../../src/dto';

/**
 * A single review's findings. Authorization checks the job's *own*
 * repository (`findAuthorizedReviewJob`), never the repository named in
 * whatever page linked here - otherwise a user authorized for repo A could
 * read repo B's findings by guessing/pasting repo B's job id. A 404 covers
 * "doesn't exist" and "not authorized" alike, so existence doesn't leak.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const accessToken = await getAccessToken(req);
  if (!accessToken) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const { jobId } = await context.params;

  try {
    const job = await findAuthorizedReviewJob(db().db, accessToken, jobId);
    if (!job) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    // No review row yet (still PENDING/RUNNING, or it FAILED before one was
    // written) is a normal, not-found-adjacent state, not a 404 - the job
    // itself is real and authorized.
    const result = await findReviewWithFindings(db().db, jobId);
    return NextResponse.json(
      result
        ? toReviewDetailDto(result.job, result.review, result.findings)
        : toReviewDetailDto(job, null, []),
    );
  } catch (err) {
    if (err instanceof GitHubUserAccessError && err.status === 401) {
      return NextResponse.json({ error: 'sign in again' }, { status: 401 });
    }
    throw err;
  }
}
