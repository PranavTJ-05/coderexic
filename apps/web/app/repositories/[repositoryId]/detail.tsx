'use client';

import { useEffect, useState } from 'react';
import type { RepositoryDetailDto, ReviewJobSummaryDto } from '../../../src/dto';
import { ApiError, fetchJson } from '../../../src/lib/fetch-json';
import {
  Button,
  Card,
  EmptyState,
  Muted,
  PageHeading,
  SessionExpired,
  StatusBadge,
} from '../../../src/components/ui';

interface RepositoryResponse {
  repository: RepositoryDetailDto;
  reviews: ReviewJobSummaryDto[];
  hasMore: boolean;
}

export function RepositoryDetail({ repositoryId }: { repositoryId: string }) {
  const [data, setData] = useState<RepositoryResponse | null>(null);
  const [reviews, setReviews] = useState<ReviewJobSummaryDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  function loadPage(offset: number) {
    return fetchJson<RepositoryResponse>(`/api/repositories/${repositoryId}?offset=${offset}`);
  }

  useEffect(() => {
    let cancelled = false;
    loadPage(0)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setReviews(result.reviews);
        setHasMore(result.hasMore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setExpired(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'failed to load repository');
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  async function loadMore() {
    const result = await loadPage(reviews.length);
    setReviews((prev) => [...prev, ...result.reviews]);
    setHasMore(result.hasMore);
  }

  if (expired) return <SessionExpired />;
  if (error) return <Muted>Could not load repository: {error}</Muted>;
  if (data === null) return <Muted>Loading...</Muted>;

  const { repository } = data;

  return (
    <main className="flex flex-col gap-6">
      <div>
        <PageHeading>{repository.fullName}</PageHeading>
        <Muted>
          index: {repository.indexStatus}
          {repository.settings.modelProvider
            ? ` - model: ${repository.settings.modelProvider}/${repository.settings.modelName}`
            : ' - model: default'}
          {' - minimum severity: '}
          {repository.settings.minimumSeverity}
        </Muted>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Review history</h2>
        {reviews.length === 0 ? (
          <EmptyState
            title="No reviews yet"
            description="Open a pull request on the default branch, or comment /review review on an open one, to trigger a review."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {reviews.map((review) => (
              <a key={review.id} href={`/repositories/${repositoryId}/reviews/${review.id}`}>
                <Card className="flex items-center justify-between hover:bg-[var(--muted)]">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      PR #{review.pullRequestNumber} - {review.triggerType}
                    </span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {new Date(review.createdAt).toLocaleString()}
                      {review.findingsCount > 0 ? ` - ${review.findingsCount} findings` : ''}
                    </span>
                  </div>
                  <StatusBadge status={review.status} />
                </Card>
              </a>
            ))}
          </div>
        )}
        {hasMore ? (
          <Button variant="outline" className="self-start" onClick={() => void loadMore()}>
            Load more
          </Button>
        ) : null}
      </div>
    </main>
  );
}
