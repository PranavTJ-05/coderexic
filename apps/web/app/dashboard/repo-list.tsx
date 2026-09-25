'use client';

import { useEffect, useState } from 'react';
import type { RepositorySummaryDto } from '../../src/dto';
import { ApiError, fetchJson } from '../../src/lib/fetch-json';
import {
  Card,
  EmptyState,
  LinkButton,
  Muted,
  SessionExpired,
  StatusBadge,
} from '../../src/components/ui';

/** Fetches client-side, same convention as `/api/repos`'s original consumer (Phase 13a). */
export function DashboardRepoList({ installUrl }: { installUrl: string | undefined }) {
  const [repos, setRepos] = useState<RepositorySummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ repositories: RepositorySummaryDto[] }>('/api/dashboard')
      .then((data) => {
        if (!cancelled) setRepos(data.repositories);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setExpired(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'failed to load repositories');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (expired) return <SessionExpired />;
  if (error) return <Muted>Could not load repositories: {error}</Muted>;
  if (repos === null) return <Muted>Loading repositories...</Muted>;

  if (repos.length === 0) {
    return (
      <EmptyState
        title="No repositories yet"
        description="Install the GitHub App on a repository, or select one on an existing installation. Just installed? It can take a few seconds for a webhook to arrive - refresh this page."
        action={installUrl ? <LinkButton href={installUrl}>Install the app</LinkButton> : undefined}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {repos.map((repo) => (
        <a key={repo.repositoryId} href={`/repositories/${repo.repositoryId}`}>
          <Card className="flex items-center justify-between hover:bg-[var(--muted)]">
            <div className="flex flex-col gap-1">
              <span className="font-medium">{repo.fullName}</span>
              <span className="text-xs text-[var(--muted-foreground)]">
                index: {repo.indexStatus}
                {repo.latestJob ? ` - PR #${repo.latestJob.pullRequestNumber}` : ''}
              </span>
            </div>
            {repo.latestJob ? (
              <StatusBadge status={repo.latestJob.status} />
            ) : (
              <Muted>no reviews yet</Muted>
            )}
          </Card>
        </a>
      ))}
    </div>
  );
}
