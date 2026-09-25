'use client';

import { useEffect, useState } from 'react';
import type { ReviewDetailDto } from '../../../../../src/dto';
import { ApiError, fetchJson } from '../../../../../src/lib/fetch-json';
import {
  Card,
  EmptyState,
  Muted,
  PageHeading,
  SessionExpired,
  SeverityBadge,
  StatusBadge,
} from '../../../../../src/components/ui';

export function ReviewDetail({ repositoryId, jobId }: { repositoryId: string; jobId: string }) {
  const [review, setReview] = useState<ReviewDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchJson<ReviewDetailDto>(`/api/reviews/${jobId}`)
      .then((data) => {
        if (!cancelled) setReview(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setExpired(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'failed to load review');
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (expired) return <SessionExpired />;
  if (error) return <Muted>Could not load review: {error}</Muted>;
  if (review === null) return <Muted>Loading...</Muted>;

  return (
    <main className="flex flex-col gap-6">
      <div>
        <a
          href={`/repositories/${repositoryId}`}
          className="text-sm text-[var(--muted-foreground)] hover:underline"
        >
          &larr; back to repository
        </a>
        <div className="mt-2 flex items-center gap-3">
          <PageHeading>PR #{review.pullRequestNumber}</PageHeading>
          <StatusBadge status={review.status} />
        </div>
        <Muted>
          {review.headSha.slice(0, 12)}
          {review.provider ? ` - ${review.provider}/${review.model}` : ''}
          {review.errorCode ? ` - ${review.errorCode}` : ''}
        </Muted>
      </div>

      {review.summary ? (
        <Card>
          {/* Model output is untrusted (ARCHITECTURE.md §1.7/§13) - rendered as
              plain text only, never as markdown/HTML. */}
          <p className="whitespace-pre-wrap text-sm">{review.summary}</p>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Findings ({review.findings.length})</h2>
        {review.findings.length === 0 ? (
          <EmptyState title="No findings" description="This review did not raise any findings." />
        ) : (
          <div className="flex flex-col gap-2">
            {review.findings.map((finding) => (
              <Card key={finding.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm">
                    {finding.filename}:{finding.startLine}
                    {finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}
                  </span>
                  <SeverityBadge
                    severity={finding.severity as 'critical' | 'high' | 'medium' | 'low'}
                  />
                </div>
                <p className="whitespace-pre-wrap text-sm">{finding.issue}</p>
                {finding.suggestedCode ? (
                  <pre className="overflow-x-auto rounded-md bg-[var(--muted)] p-2 text-xs whitespace-pre-wrap">
                    {finding.suggestedCode}
                  </pre>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
