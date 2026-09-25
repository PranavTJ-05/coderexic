'use client';

import { useEffect, useState } from 'react';
import type {
  ModelCredentialDto,
  RepositoryDetailDto,
  RepositoryUsageDto,
} from '../../../../src/dto';
import { ApiError, fetchJson } from '../../../../src/lib/fetch-json';
import {
  Button,
  Card,
  EmptyState,
  Muted,
  PageHeading,
  SessionExpired,
} from '../../../../src/components/ui';

const PROVIDERS = ['gemini', 'openai', 'anthropic', 'groq'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

interface SettingsResponse {
  repository: RepositoryDetailDto;
  isAdmin: boolean;
  ignorePatterns: string[];
  credentials: ModelCredentialDto[];
  byokConfigured: boolean;
  usage: RepositoryUsageDto;
}

async function postJson(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `request failed with status ${res.status}`, res.status);
  }
}

export function RepositorySettings({ repositoryId }: { repositoryId: string }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function load() {
    return fetchJson<SettingsResponse>(`/api/repositories/${repositoryId}`).then((result) => {
      setData(result);
    });
  }

  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof ApiError && err.status === 401) {
        setExpired(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'failed to load settings');
    });
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  async function runAction(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'action failed');
    }
  }

  if (expired) return <SessionExpired />;
  if (error) return <Muted>Could not load settings: {error}</Muted>;
  if (data === null) return <Muted>Loading...</Muted>;

  if (!data.isAdmin) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeading>{data.repository.fullName} settings</PageHeading>
        <EmptyState
          title="Admin access required"
          description="Only a repository admin (as GitHub reports it) can change these settings."
        />
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-8">
      <div>
        <a
          href={`/repositories/${repositoryId}`}
          className="text-sm text-[var(--muted-foreground)] hover:underline"
        >
          &larr; back to repository
        </a>
        <PageHeading>{data.repository.fullName} settings</PageHeading>
      </div>

      {actionError ? <Muted>{actionError}</Muted> : null}

      <ModelSettingsForm
        repositoryId={repositoryId}
        settings={data.repository.settings}
        runAction={runAction}
      />

      <IgnorePatternsSection
        repositoryId={repositoryId}
        patterns={data.ignorePatterns}
        runAction={runAction}
      />

      <ByokSection
        repositoryId={repositoryId}
        credentials={data.credentials}
        byokConfigured={data.byokConfigured}
        runAction={runAction}
      />

      <UsageSection usage={data.usage} />
    </main>
  );
}

function ModelSettingsForm({
  repositoryId,
  settings,
  runAction,
}: {
  repositoryId: string;
  settings: RepositoryDetailDto['settings'];
  runAction: (action: () => Promise<void>) => Promise<void>;
}) {
  const [modelProvider, setModelProvider] = useState(settings.modelProvider ?? '');
  const [modelName, setModelName] = useState(settings.modelName ?? '');
  const [minimumSeverity, setMinimumSeverity] = useState(settings.minimumSeverity);

  function save() {
    return runAction(() =>
      postJson(`/api/repositories/${repositoryId}/settings`, 'PUT', {
        modelProvider: modelProvider || null,
        modelName: modelName || null,
        minimumSeverity,
      }),
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Model settings</h2>
      <label className="flex flex-col gap-1 text-sm">
        Model provider (overrides this deployment&apos;s default)
        <select
          className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          value={modelProvider}
          onChange={(e) => {
            setModelProvider(e.target.value);
          }}
        >
          <option value="">Deployment default</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Model name (informational only - see note below)
        <input
          className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          value={modelName}
          onChange={(e) => {
            setModelName(e.target.value);
          }}
          placeholder="left blank uses the deployment's configured model"
        />
      </label>
      <Muted>
        A repo-level model name isn&apos;t applied to reviews yet - it&apos;s stored for a future
        release that scopes it correctly (a free-text model name against the operator&apos;s own
        system key would let a repo admin pick the operator&apos;s most expensive model). Use a BYOK
        key below to actually control which model runs.
      </Muted>
      <label className="flex flex-col gap-1 text-sm">
        Minimum severity posted
        <select
          className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          value={minimumSeverity}
          onChange={(e) => {
            setMinimumSeverity(e.target.value);
          }}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <Button
        className="self-start"
        onClick={() => {
          void save();
        }}
      >
        Save
      </Button>
    </Card>
  );
}

function IgnorePatternsSection({
  repositoryId,
  patterns,
  runAction,
}: {
  repositoryId: string;
  patterns: string[];
  runAction: (action: () => Promise<void>) => Promise<void>;
}) {
  const [newPattern, setNewPattern] = useState('');

  function add() {
    if (!newPattern.trim()) return;
    return runAction(async () => {
      await postJson(`/api/repositories/${repositoryId}/ignore-patterns`, 'POST', {
        pattern: newPattern.trim(),
      });
      setNewPattern('');
    });
  }

  function remove(pattern: string) {
    return runAction(() =>
      postJson(
        `/api/repositories/${repositoryId}/ignore-patterns?pattern=${encodeURIComponent(pattern)}`,
        'DELETE',
      ),
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Ignore patterns</h2>
      <Muted>
        Glob patterns for files a review never considers, merged with any ignore list in the
        repository&apos;s own .coderexic.yml.
      </Muted>
      {patterns.length === 0 ? (
        <Muted>No ignore patterns configured.</Muted>
      ) : (
        <ul className="flex flex-col gap-1">
          {patterns.map((pattern) => (
            <li key={pattern} className="flex items-center justify-between font-mono text-sm">
              {pattern}
              <button
                type="button"
                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                onClick={() => {
                  void remove(pattern);
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-sm"
          value={newPattern}
          onChange={(e) => {
            setNewPattern(e.target.value);
          }}
          placeholder="**/*.generated.ts"
        />
        <Button
          variant="outline"
          onClick={() => {
            void add();
          }}
        >
          Add
        </Button>
      </div>
    </Card>
  );
}

function ByokSection({
  repositoryId,
  credentials,
  byokConfigured,
  runAction,
}: {
  repositoryId: string;
  credentials: ModelCredentialDto[];
  byokConfigured: boolean;
  runAction: (action: () => Promise<void>) => Promise<void>;
}) {
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('gemini');
  const [apiKey, setApiKey] = useState('');

  function set() {
    if (!apiKey.trim()) return;
    return runAction(async () => {
      await postJson(`/api/repositories/${repositoryId}/credentials`, 'PUT', {
        provider,
        apiKey: apiKey.trim(),
      });
      setApiKey('');
    });
  }

  function remove(forProvider: string) {
    return runAction(() =>
      postJson(
        `/api/repositories/${repositoryId}/credentials?provider=${encodeURIComponent(forProvider)}`,
        'DELETE',
      ),
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Bring your own key (BYOK)</h2>
      <Muted>
        A key set here is used for reviews on this repository ahead of this deployment&apos;s own
        key, for whichever provider the review ends up using.
      </Muted>
      {!byokConfigured ? (
        <Muted>
          BYOK is not configured on this deployment (no master key set) - this form is disabled.
        </Muted>
      ) : (
        <>
          {credentials.length === 0 ? (
            <Muted>No BYOK keys set for this repository.</Muted>
          ) : (
            <ul className="flex flex-col gap-1">
              {credentials.map((c) => (
                <li key={c.id} className="flex items-center justify-between text-sm">
                  <span>
                    {c.provider} - updated {new Date(c.updatedAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                    onClick={() => {
                      void remove(c.provider);
                    }}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as (typeof PROVIDERS)[number]);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              type="password"
              className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
              }}
              placeholder="API key"
            />
            <Button
              variant="outline"
              onClick={() => {
                void set();
              }}
            >
              Set key
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function UsageSection({ usage }: { usage: RepositoryUsageDto }) {
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">Usage</h2>
      <Muted>
        {usage.reviewCount} completed review{usage.reviewCount === 1 ? '' : 's'} -{' '}
        {usage.totalInputTokens.toLocaleString()} input tokens,{' '}
        {usage.totalOutputTokens.toLocaleString()} output tokens,{' '}
        {(usage.totalDurationMs / 1000).toFixed(1)}s total model time.
      </Muted>
      <div className="flex flex-wrap gap-3 text-sm">
        {Object.entries(usage.jobCountByStatus).map(([status, count]) => (
          <span key={status} className="text-[var(--muted-foreground)]">
            {status}: {count}
          </span>
        ))}
      </div>
    </Card>
  );
}
