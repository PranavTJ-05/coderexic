import {
  ACTIVE_JOB_WINDOW_MS,
  AGENT_SYSTEM_PROMPT,
  AgentToolExecutor,
  buildAgentPrompt,
  buildReview,
  buildReviewContext,
  cancelReviewJob,
  claimReviewJob,
  completeAgentRun,
  completeReview,
  createAgentRun,
  createIndexRun,
  DEFAULT_DIFF_BUDGET,
  dedupeFindings,
  enqueueIndexRun,
  failReviewJob,
  filterBySeverity,
  filterIgnoredPaths,
  findActiveReviewJob,
  findInstallationById,
  findRepositoryById,
  getRepositorySettings,
  hasReviewMarker,
  listIgnorePatterns,
  loadRepositoryConfig,
  loadRepositoryRules,
  ModelError,
  ModelInvalidOutputError,
  ModelTimeoutError,
  placeFindings,
  ProviderCredentialResolutionError,
  recordAgentToolCall,
  resolveProviderEntry,
  runAgentLoop,
  ReviewContextCache,
  selectReviewableFiles,
  startReview,
  updateReviewJobHeadSha,
  type AgentAdapter,
  type Database,
  type DiffBudget,
  type GitHubApp,
  type GitHubClient,
  type IndexQueueJob,
  type Logger,
  type MasterKeyMap,
  type ModelReviewOutput,
  type ParsedRepositoryConfig,
  type PRFile,
  type ProviderRegistry,
  type PullRequest,
  type Repository,
  type RepositoryRulesFile,
  type RepositorySettings,
  type RepoRef,
  type ResolvedProviderEntry,
  type ReviewModel,
  type SupportedModelProvider,
} from '@coderexic/core';
import type { Queue } from 'bullmq';
import { publishReview } from './publish.js';

export interface ReviewPipelineDeps {
  db: Database;
  githubApp: GitHubApp;
  /** One-shot reviewer (AI_AGENT_SPEC.md §15's fallback mode). Always required, since it's also the path used when `agentAdapter` is omitted. */
  model: ReviewModel;
  /**
   * When set, reviews run through the tool-calling agent loop (Phase 9)
   * instead of the one-shot `model` path. Optional so a deployment or a
   * test can run without agent support at all - the review pipeline then
   * behaves exactly as it did before Phase 9.
   */
  agentAdapter?: AgentAdapter;
  /** Stored on the review row; identifies what actually produced it. */
  provider: string;
  modelName: string;
  logger: Logger;
  diffBudget?: DiffBudget;
  /**
   * Lets a review that finds its repo un-indexed at the PR's base sha kick
   * off an index run itself. Indexing normally only starts from a push
   * webhook (ARCHITECTURE.md §9), so a repo nobody has pushed to since
   * install would otherwise stay un-indexed forever. Optional so tests that
   * don't care about the graph can omit it; failures here are logged and
   * never fail the review.
   */
  indexQueue?: Queue<IndexQueueJob>;
  /** AI_AGENT_SPEC.md §9 agent-loop limits; only used on the `agentAdapter` path. */
  maxTurns?: number;
  maxFileFetches?: number;
  /**
   * Overrides the agent loop's wall-clock deadline outright, bypassing both
   * `maxReviewSeconds` and `MIN_AGENT_REVIEW_SECONDS` below. Only meant for
   * tests that need to prove the TIMED_OUT path without an actual 180s wait.
   */
  agentDeadlineMs?: number;
  /**
   * Every provider this deployment has a key configured for (ROADMAP.md
   * Phase 10's provider factory). When a repo's `.coderexic.yml` names a
   * `model:` this deployment has an entry for, that provider's adapter
   * runs the review instead of the fixed `model`/`agentAdapter` above;
   * otherwise the fixed deps are used and a config warning is added.
   * Optional so tests that don't care about multi-provider selection can
   * omit it.
   */
  providers?: ProviderRegistry;
  /**
   * When set, a repository's own BYOK credential (Phase 11's
   * `model_credentials`, repo-tier only - there's no acting user at review
   * time, so `resolveReviewProvider` below never passes a `userId`) is
   * resolved for whichever provider the review ends up requesting, ahead
   * of this deployment's own key for that provider. Unset means BYOK
   * resolution is skipped outright and every review uses `providers`
   * (this deployment's own configured registry) exactly as before Phase 13c.
   */
  masterKeys?: MasterKeyMap;
  /**
   * Test seam: overrides the credential resolver `resolveReviewProvider`
   * calls when `masterKeys` is set, instead of the real `resolveProviderEntry`
   * (which builds real provider SDK clients). Production code never sets
   * this.
   */
  resolveProviderEntry?: typeof resolveProviderEntry;
}

/**
 * Ensures an index run exists for the PR's base sha when the repository
 * isn't already indexed there, so the context engine (Phase 7+) has
 * something to work with even for a repo nobody has pushed to since
 * install. Fire-and-forget: never blocks or fails the review.
 */
async function ensureIndexed(
  deps: ReviewPipelineDeps,
  repositoryId: string,
  baseSha: string,
  log: Logger,
): Promise<void> {
  try {
    const run = await createIndexRun(deps.db, repositoryId, baseSha);
    if (deps.indexQueue) {
      await enqueueIndexRun(deps.indexQueue, run.id);
    }
  } catch (err) {
    log.warn({ err }, 'failed to trigger an index run for this repository; continuing the review');
  }
}

/**
 * Resolves the actual provider entry (API client + model) for whichever
 * provider name the review ends up requesting (Phase 13c). Repo-tier BYOK
 * only - `resolveProviderEntry` never receives a `userId`, since a webhook-
 * triggered or `/review review`-triggered job has no acting user, only a
 * repository. `undefined` means "this deployment has no key for this
 * provider anywhere" (repo BYOK or system) - the caller falls back to the
 * fixed deployment default and warns; it does not mean "BYOK resolution
 * failed," which is a `ProviderCredentialResolutionError` instead and
 * propagates to the caller's own error handling (never silently swallowed
 * into a fallback - see that error's doc comment).
 */
async function resolveReviewProvider(
  deps: ReviewPipelineDeps,
  repositoryId: string,
  provider: SupportedModelProvider,
  log: Logger,
): Promise<ResolvedProviderEntry | undefined> {
  if (!deps.masterKeys) {
    const systemEntry = deps.providers?.[provider];
    return systemEntry ? { ...systemEntry, source: 'system' } : undefined;
  }
  const resolve = deps.resolveProviderEntry ?? resolveProviderEntry;
  return resolve(deps.db, { repositoryId, provider }, deps.masterKeys, deps.providers ?? {}, log);
}

/** Non-error termination reasons stored as review_jobs.error_code. */
const SKIP_REASON = {
  repositoryRemoved: 'REPOSITORY_REMOVED',
  superseded: 'SUPERSEDED_BY_NEWER_COMMIT',
  draft: 'DRAFT_PULL_REQUEST',
  closed: 'PULL_REQUEST_CLOSED',
  duplicateActive: 'DUPLICATE_ACTIVE_REVIEW',
} as const;

/**
 * `maxReviewSeconds` (repo-configurable, default 60) was sized for the
 * one-shot path's single model call. The agent loop can spend up to
 * `MAX_TURNS` calls plus tool-call time inside the same wall clock, so it
 * gets a taller floor rather than silently timing out most runs. A repo
 * that explicitly configures a larger `maxReviewSeconds` still wins.
 */
const MIN_AGENT_REVIEW_SECONDS = 180;

/**
 * Runs one review job end to end: claim, fetch the PR, ask the model,
 * publish, persist. Safe to call more than once for the same job (BullMQ
 * retries, or the stale-job sweep re-enqueuing): claimReviewJob only lets
 * one call past PENDING, and a job that already has a posted review is
 * detected and completed without posting again.
 */
export async function processReviewJob(
  deps: ReviewPipelineDeps,
  reviewJobId: string,
): Promise<void> {
  const { db, githubApp, model, provider, modelName, logger } = deps;
  const budget = deps.diffBudget ?? DEFAULT_DIFF_BUDGET;
  const log = logger.child({ reviewJobId });
  const startedAt = Date.now();

  const claimed = await claimReviewJob(db, reviewJobId);
  if (!claimed) {
    log.info('job is not pending (already claimed, completed, or missing); skipping');
    return;
  }

  try {
    const [repository, installation] = await Promise.all([
      findRepositoryById(db, claimed.repositoryId),
      findInstallationById(db, claimed.installationId),
    ]);
    if (!repository || !installation) {
      await failReviewJob(db, reviewJobId, 'FAILED', 'REPOSITORY_NOT_FOUND');
      return;
    }
    if (repository.removedAt ?? installation.removedAt) {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.repositoryRemoved);
      return;
    }

    const client = await githubApp.getInstallationClient(installation.githubInstallationId);
    const ref = { owner: repository.ownerLogin, repo: repository.name };

    const pr = await client.getPullRequest(ref, claimed.pullRequestNumber);
    const isManual = claimed.triggerType === 'manual';
    if (isManual) {
      // A manual job is created with a placeholder head sha (the webhook
      // handler that creates it never calls the GitHub API); record the
      // real one now that it's known. Manual jobs also skip the superseded
      // and draft checks below - an explicit /review review command beats
      // the automatic-trigger policy those checks exist for (ROADMAP.md
      // Phase 12).
      await updateReviewJobHeadSha(db, reviewJobId, pr.headSha, pr.baseSha);
    } else if (pr.headSha !== claimed.headSha) {
      // A newer push already created (or will create) the job that covers it.
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.superseded);
      return;
    }
    if (!isManual && pr.draft) {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.draft);
      return;
    }
    if (pr.state !== 'open') {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.closed);
      return;
    }

    // A manual comment and a push can race to the same real head sha (the
    // comment's job resolves its placeholder sha to Y just as a push
    // creates the automatic job for Y). The per-head-sha idempotency key
    // only dedupes automatic-vs-automatic; this catches manual-vs-automatic
    // and manual-vs-manual once each side's real head sha is known. A
    // narrower race remains if both jobs reach this check before either
    // cancels (ROADMAP.md Phase 12) - accepted, not fixed, since closing it
    // needs a DB-level lock this check doesn't have.
    const duplicate = await findActiveReviewJob(
      db,
      repository.id,
      claimed.pullRequestNumber,
      new Date(Date.now() - ACTIVE_JOB_WINDOW_MS),
      { headSha: pr.headSha, excludeId: reviewJobId },
    );
    if (duplicate) {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.duplicateActive);
      return;
    }

    if (repository.indexedSha !== pr.baseSha) {
      void ensureIndexed(deps, repository.id, pr.baseSha, log);
    }

    const reviewBodies = await client.listReviewBodies(ref, pr.number);
    if (reviewBodies.some((body) => hasReviewMarker(body, reviewJobId))) {
      log.info('a review for this job was already posted; completing without posting again');
      await completeReview(db, {
        reviewJobId,
        jobStatus: 'SUCCEEDED',
        review: {
          provider,
          model: modelName,
          status: 'SUCCEEDED',
          summary: 'Review already posted (recovered after a retry).',
          filesConsidered: 0,
          filesFetched: 0,
          agentTurns: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
        findings: [],
      });
      return;
    }

    // Loaded from the PR's base sha, never its head: reading from head would let a PR
    // edit its own review rules or ignore list to silence findings about itself.
    const [settings, dbIgnorePatterns, config, rulesFile] = await Promise.all([
      getRepositorySettings(db, repository.id),
      listIgnorePatterns(db, repository.id),
      loadRepositoryConfig(client, ref, pr.baseSha),
      loadRepositoryRules(client, ref, pr.baseSha),
    ]);
    // The yml is a per-job override on top of the DB layers (app defaults, then
    // repository_settings/ignore_patterns); it never writes back to the DB
    // (ARCHITECTURE.md §16's layering, and Phase 13's settings UI owns those rows).
    const minimumSeverity = config.minSeverity ?? settings?.minimumSeverity ?? 'low';
    const configuredReviewSeconds = settings?.maxReviewSeconds ?? 60;
    const maxReviewSeconds = deps.agentAdapter
      ? Math.max(configuredReviewSeconds, MIN_AGENT_REVIEW_SECONDS)
      : configuredReviewSeconds;
    const ignoreGlobs = [...dbIgnorePatterns, ...config.ignore];

    // Provider precedence: .coderexic.yml's `model:` (untrusted repo input,
    // an enum only - SUPPORTED_MODEL_PROVIDERS, never a base URL or model
    // name) > repository_settings.model_provider (Phase 13c's settings UI,
    // DB-validated by repository_settings_model_provider_ck) > this
    // deployment's fixed default. `settings.modelName` is deliberately
    // *not* applied here, even when set: resolveReviewProvider already
    // ignores any custom model name for a repo-tier BYOK credential (it
    // uses this deployment's configured model or the provider's own
    // default) precisely so a repo admin can never steer a review onto the
    // operator's most expensive model using the operator's own system key
    // - applying a free-text model name against a *system* credential
    // would defeat that. `modelName` stays stored for a future per-repo
    // override that's scoped correctly; it's not wired to model selection
    // yet.
    const configWarnings = [...config.warnings];
    // settings.modelProvider is a DB `text` column (Drizzle types it as
    // `string | null`), but repository_settings_model_provider_ck (the
    // migration added alongside `updateRepositorySettings`) enforces it's
    // one of SUPPORTED_MODEL_PROVIDERS or NULL at write time - safe to
    // narrow here rather than re-validate a value the DB already validated.
    const requestedProvider = (config.model ?? settings?.modelProvider ?? undefined) as
      SupportedModelProvider | undefined;
    let resolvedEntry: ResolvedProviderEntry | undefined;
    if (requestedProvider) {
      try {
        resolvedEntry = await resolveReviewProvider(deps, repository.id, requestedProvider, log);
      } catch (err) {
        if (err instanceof ProviderCredentialResolutionError) {
          log.error({ err, provider: requestedProvider }, 'BYOK credential resolution failed');
          await failReviewJob(db, reviewJobId, 'FAILED', 'BYOK_CREDENTIAL_ERROR', err.message);
          return;
        }
        throw err;
      }
    }
    if (requestedProvider && !resolvedEntry) {
      const origin = config.model
        ? `.coderexic.yml's model "${config.model}"`
        : `the repository's configured model "${requestedProvider}"`;
      configWarnings.push(`${origin} is not configured on this deployment; using the default`);
    }
    const resolvedProvider = resolvedEntry?.provider ?? provider;
    const resolvedModelName = resolvedEntry?.modelName ?? modelName;
    const resolvedModel = resolvedEntry?.reviewModel ?? model;
    // A repo's provider choice can only swap *which* adapter runs within whichever mode this
    // deployment is already in - it must never turn the agent loop on when AGENT_LOOP_ENABLED
    // (deps.agentAdapter's presence) is off globally.
    const resolvedAgentAdapter = deps.agentAdapter
      ? (resolvedEntry?.agentAdapter ?? deps.agentAdapter)
      : undefined;

    if (configWarnings.length > 0) {
      log.warn(
        { warnings: configWarnings },
        'repository config has issues; falling back per field',
      );
    }

    const files = await client.getPullRequestFiles(ref, pr.number);
    const selection = selectReviewableFiles(files, { budget, ignoreGlobs });
    log.info(
      {
        changedFiles: files.length,
        reviewed: selection.files.length,
        skipped: selection.skipped.length,
      },
      'selected files for review',
    );

    if (selection.files.length === 0) {
      await completeReview(db, {
        reviewJobId,
        jobStatus: 'SUCCEEDED',
        review: {
          provider: resolvedProvider,
          model: resolvedModelName,
          status: 'SUCCEEDED',
          summary: 'No reviewable files in this diff.',
          filesConsidered: files.length,
          filesFetched: 0,
          agentTurns: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
        findings: [],
      });
      return;
    }

    /**
     * Shared by both paths below: turns a model's raw output into a posted
     * GitHub review and the row completeReview persists.
     */
    async function publishAndComplete(
      output: ModelReviewOutput,
      counts: {
        filesFetched: number;
        agentTurns: number;
        toolCalls: number;
        inputTokens?: number;
        outputTokens?: number;
      },
    ): Promise<void> {
      const ignoreFiltered = filterIgnoredPaths(output.reviews, ignoreGlobs);
      const deduped = dedupeFindings(filterBySeverity(ignoreFiltered, minimumSeverity));
      const filesByPath = new Map(selection.files.map((file) => [file.filename, file.patch]));
      const processed = placeFindings(deduped, filesByPath);
      const built = buildReview(processed);

      // Bad repo config never vanishes silently (PRODUCT_SPEC.md §18): surface it in
      // the posted review, not just the logs.
      const summary =
        configWarnings.length > 0
          ? `${output.summary}\n\n⚠️ Repository config warnings: ${configWarnings.join('; ')}`
          : output.summary;

      const publishError = await publishReview(client, ref, pr, reviewJobId, summary, built, log);

      await completeReview(db, {
        reviewJobId,
        jobStatus: publishError ? 'FAILED' : 'SUCCEEDED',
        review: {
          provider: resolvedProvider,
          model: resolvedModelName,
          status: publishError ? 'FAILED' : 'SUCCEEDED',
          summary,
          filesConsidered: files.length,
          filesFetched: counts.filesFetched,
          agentTurns: counts.agentTurns,
          toolCalls: counts.toolCalls,
          durationMs: Date.now() - startedAt,
          ...(counts.inputTokens !== undefined && { inputTokens: counts.inputTokens }),
          ...(counts.outputTokens !== undefined && { outputTokens: counts.outputTokens }),
        },
        findings: built.dbFindings,
        ...(publishError && {
          errorCode: 'GITHUB_PUBLISH_ERROR',
          errorMessage: publishError.slice(0, 1000),
        }),
      });
      if (publishError) log.error({ publishError }, 'review job completed with a publish failure');
    }

    if (resolvedAgentAdapter) {
      await runAgentBranch(resolvedAgentAdapter, {
        db,
        client,
        ref,
        pr,
        repository,
        files,
        selection,
        rulesFile,
        config,
        settings,
        ignoreGlobs,
        deadlineMs: deps.agentDeadlineMs ?? maxReviewSeconds * 1000,
        provider: resolvedProvider,
        modelName: resolvedModelName,
        reviewJobId,
        startedAt,
        log,
        ...(deps.maxTurns !== undefined && { maxTurns: deps.maxTurns }),
        ...(deps.maxFileFetches !== undefined && { maxFileFetches: deps.maxFileFetches }),
        publishAndComplete,
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, maxReviewSeconds * 1000);
    try {
      const output = await resolvedModel.generateReview(
        {
          repositoryFullName: repository.fullName,
          pullRequestTitle: pr.title,
          pullRequestBody: pr.body,
          files: selection.files.map(({ filename, status, patch }) => ({
            filename,
            status,
            patch,
          })),
          repositoryRules: rulesFile?.content ?? null,
          languageHint: config.language ?? settings?.languageHint ?? null,
        },
        { signal: controller.signal },
      );

      await publishAndComplete(output, {
        filesFetched: selection.files.length,
        agentTurns: 1,
        toolCalls: 0,
      });
    } catch (err) {
      if (err instanceof ModelTimeoutError) {
        await failReviewJob(db, reviewJobId, 'TIMED_OUT', 'TIMEOUT', err.message);
      } else if (err instanceof ModelInvalidOutputError) {
        await failReviewJob(db, reviewJobId, 'FAILED', 'INVALID_OUTPUT', err.message);
      } else if (err instanceof ModelError) {
        await failReviewJob(db, reviewJobId, 'FAILED', 'MODEL_ERROR', err.message);
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.error({ err }, 'review job failed unexpectedly');
    await failReviewJob(
      db,
      reviewJobId,
      'FAILED',
      'UNEXPECTED_ERROR',
      err instanceof Error ? err.message : 'unknown error',
    ).catch((markErr: unknown) => {
      log.error({ err: markErr }, 'failed to mark job failed');
    });
    // Rethrow so BullMQ records the attempt as failed and applies its retry policy.
    throw err;
  }
}

interface AgentBranchContext {
  db: Database;
  client: GitHubClient;
  ref: RepoRef;
  pr: PullRequest;
  repository: Repository;
  files: readonly PRFile[];
  selection: ReturnType<typeof selectReviewableFiles>;
  rulesFile: RepositoryRulesFile | null;
  config: ParsedRepositoryConfig;
  settings: RepositorySettings | undefined;
  ignoreGlobs: string[];
  deadlineMs: number;
  provider: string;
  modelName: string;
  reviewJobId: string;
  startedAt: number;
  log: Logger;
  maxTurns?: number;
  maxFileFetches?: number;
  publishAndComplete: (
    output: ModelReviewOutput,
    counts: {
      filesFetched: number;
      agentTurns: number;
      toolCalls: number;
      inputTokens?: number;
      outputTokens?: number;
    },
  ) => Promise<void>;
}

/**
 * The Phase 9 agent-loop path: builds Phase 7's related-file context,
 * constructs Phase 8's tool executor, and runs the tool-call loop to
 * completion, persisting an `agent_runs` row and one `agent_tool_calls` row
 * per call along the way (DATA_MODEL.md). On any non-`SUCCEEDED` outcome,
 * finalizes with `completeReview` (never `failReviewJob`, which would leave
 * the `reviews`/`agent_runs` rows this branch already created stuck
 * `RUNNING` - AI_AGENT_SPEC.md §14: "a timeout must never leave the review
 * marked successful," which cuts both ways - it must never leave it
 * unmarked either).
 */
async function runAgentBranch(agentAdapter: AgentAdapter, ctx: AgentBranchContext): Promise<void> {
  const { db, client, ref, pr, repository, files, selection, config, settings, log } = ctx;
  const changedPaths = selection.files.map((f) => f.filename);
  const removedPaths = [
    ...files.filter((f) => f.status === 'removed').map((f) => f.filename),
    ...files
      .filter((f) => f.status === 'renamed' && f.previousFilename)
      .map((f) => f.previousFilename as string),
  ];

  const cache = new ReviewContextCache();
  const contextResult = await buildReviewContext({
    db,
    repositoryId: repository.id,
    client,
    ref,
    headSha: pr.headSha,
    changedPaths,
    removedPaths,
    ignoreGlobs: ctx.ignoreGlobs,
    indexStatus: repository.indexStatus,
    ...(config.depth !== null && { depth: config.depth }),
    ...(config.maxFiles !== null && { maxFiles: config.maxFiles }),
    cache,
  });

  const { id: reviewId } = await startReview(db, {
    reviewJobId: ctx.reviewJobId,
    provider: ctx.provider,
    model: ctx.modelName,
  });
  const agentRun = await createAgentRun(db, reviewId);
  let toolCallCount = 0;

  try {
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref,
      headSha: pr.headSha,
      changedPaths,
      cache,
    });

    const initialUserMessage = buildAgentPrompt({
      repositoryFullName: repository.fullName,
      pullRequestTitle: pr.title,
      pullRequestBody: pr.body,
      files: selection.files.map(({ filename, status, patch }) => ({ filename, status, patch })),
      repositoryRules: ctx.rulesFile?.content ?? null,
      languageHint: config.language ?? settings?.languageHint ?? null,
      relatedFiles: contextResult.files,
      contextNote: contextResult.note,
    });

    const loopResult = await runAgentLoop({
      adapter: agentAdapter,
      executor,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      initialUserMessage,
      deadlineMs: ctx.deadlineMs,
      ...(ctx.maxTurns !== undefined && { maxTurns: ctx.maxTurns }),
      ...(ctx.maxFileFetches !== undefined && { maxFileFetches: ctx.maxFileFetches }),
      onToolCall: async (event) => {
        toolCallCount += 1;
        await recordAgentToolCall(db, {
          agentRunId: agentRun.id,
          turnNumber: event.turnNumber,
          toolName: event.toolCall.name,
          argumentsJson: toStorableArgs(event.toolCall.args),
          resultSizeBytes: Buffer.byteLength(event.result.text, 'utf8'),
          durationMs: event.durationMs,
          status: event.result.status,
        });
      },
    });

    await completeAgentRun(db, agentRun.id, {
      status: loopResult.status,
      terminationReason: loopResult.terminationReason,
      turnCount: loopResult.turnCount,
      fileFetchCount: loopResult.fileFetchCount,
    });

    if (loopResult.status === 'SUCCEEDED' && loopResult.output) {
      await ctx.publishAndComplete(loopResult.output, {
        filesFetched: loopResult.fileFetchCount,
        agentTurns: loopResult.turnCount,
        toolCalls: toolCallCount,
        inputTokens: loopResult.usage.inputTokens,
        outputTokens: loopResult.usage.outputTokens,
      });
      return;
    }

    log.warn(
      { terminationReason: loopResult.terminationReason, turnCount: loopResult.turnCount },
      'agent review did not complete with a submitted review',
    );
    await completeReview(db, {
      reviewJobId: ctx.reviewJobId,
      jobStatus: loopResult.status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
      review: {
        provider: ctx.provider,
        model: ctx.modelName,
        status: loopResult.status,
        summary: `The review agent did not finish (${loopResult.terminationReason}).`,
        filesConsidered: files.length,
        filesFetched: loopResult.fileFetchCount,
        agentTurns: loopResult.turnCount,
        toolCalls: toolCallCount,
        durationMs: Date.now() - ctx.startedAt,
      },
      findings: [],
      errorCode: loopResult.terminationReason,
    });
  } catch (err) {
    // A crash here (a malformed tool call whose args can't be stored, a DB error
    // mid-loop, ...) must not leave the reviews/agent_runs rows this branch already
    // created stuck RUNNING forever (AI_AGENT_SPEC.md §14 cuts both ways: a run that
    // didn't finish must never look successful, and must never look unfinished either).
    log.error({ err }, 'agent review branch failed unexpectedly');
    await completeAgentRun(db, agentRun.id, {
      status: 'FAILED',
      terminationReason: 'MODEL_ERROR',
      turnCount: 0,
      fileFetchCount: 0,
    }).catch((markErr: unknown) => {
      log.error({ err: markErr }, 'failed to mark agent run failed');
    });
    await completeReview(db, {
      reviewJobId: ctx.reviewJobId,
      jobStatus: 'FAILED',
      review: {
        provider: ctx.provider,
        model: ctx.modelName,
        status: 'FAILED',
        summary: 'The review agent failed unexpectedly.',
        filesConsidered: files.length,
        filesFetched: 0,
        agentTurns: 0,
        toolCalls: toolCallCount,
        durationMs: Date.now() - ctx.startedAt,
      },
      findings: [],
      errorCode: 'UNEXPECTED_ERROR',
      errorMessage: err instanceof Error ? err.message.slice(0, 1000) : 'unknown error',
    }).catch((markErr: unknown) => {
      log.error({ err: markErr }, 'failed to mark review failed');
    });
    throw err;
  }
}

/** jsonb `arguments_json` is NOT NULL: a missing/undefined args object (a malformed tool
 *  call, e.g. Gemini omitting `args` entirely) must still store something valid, and an
 *  oversized string arg is capped rather than stored in full (metadata only, DATA_MODEL.md). */
const MAX_STORED_ARGS_CHARS = 4000;
function toStorableArgs(args: unknown): unknown {
  if (args === undefined || args === null) return {};
  if (typeof args === 'string' && args.length > MAX_STORED_ARGS_CHARS) {
    return { raw: args.slice(0, MAX_STORED_ARGS_CHARS) };
  }
  return args;
}
