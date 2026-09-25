'use client';

import { useEffect, useState } from 'react';

interface AuthorizedRepository {
  installationId: string;
  githubInstallationId: number;
  repositoryId: string;
  githubRepositoryId: number;
  fullName: string;
}

/**
 * Fetches its own client-side (same-origin, cookies sent automatically) -
 * `/api/repos` decodes the session JWT server-side via `getToken`, which
 * needs a real request; a Server Component has no clean way to do that in
 * next-auth v4 without an internal-fetch or cookie-forwarding workaround,
 * so this stays a small client component instead (styling/UI polish is
 * Phase 13b's job - this just proves the authorization plumbing works).
 */
export function RepoList() {
  const [repos, setRepos] = useState<AuthorizedRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/repos')
      .then((res) => {
        if (!res.ok) throw new Error(`request failed with status ${res.status}`);
        return res.json() as Promise<{ repositories: AuthorizedRepository[] }>;
      })
      .then((data) => {
        if (!cancelled) setRepos(data.repositories);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'failed to load repositories');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p>Could not load repositories: {error}</p>;
  if (repos === null) return <p>Loading repositories...</p>;
  if (repos.length === 0) return <p>No authorized repositories found.</p>;

  return (
    <ul>
      {repos.map((repo) => (
        <li key={repo.repositoryId}>{repo.fullName}</li>
      ))}
    </ul>
  );
}
