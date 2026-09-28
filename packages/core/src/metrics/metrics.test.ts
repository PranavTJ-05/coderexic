import { describe, expect, it } from 'vitest';
import { createMetrics, createNoopMetrics } from './metrics.js';

describe('createMetrics', () => {
  it('creating two independent instances never throws (per-instance Registry)', () => {
    expect(() => {
      createMetrics();
      createMetrics();
    }).not.toThrow();
  });

  it('exposes recorded webhook deliveries in Prometheus text format', async () => {
    const metrics = createMetrics();
    metrics.recordWebhookDelivery({
      event: 'pull_request',
      action: 'opened',
      outcome: 'processed',
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain('coderexic_webhook_deliveries_total');
    expect(text).toContain('event="pull_request"');
    expect(text).toContain('outcome="processed"');
  });

  it('records review duration observations by status/provider/mode', async () => {
    const metrics = createMetrics();
    metrics.recordReviewOutcome({
      status: 'SUCCEEDED',
      provider: 'gemini',
      mode: 'agent',
      durationMs: 4200,
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain('coderexic_review_duration_seconds');
    expect(text).toContain('mode="agent"');
  });

  it('records model token usage split by direction', async () => {
    const metrics = createMetrics();
    metrics.recordModelUsage({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      inputTokens: 100,
      outputTokens: 20,
    });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/coderexic_model_tokens_total\{.*direction="input".*\} 100/);
    expect(text).toMatch(/coderexic_model_tokens_total\{.*direction="output".*\} 20/);
  });

  it('skips a token direction that was never provided', async () => {
    const metrics = createMetrics();
    metrics.recordModelUsage({ provider: 'gemini', model: 'gemini-2.5-pro' });
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('coderexic_model_tokens_total{');
  });

  it('records agent run turn/fetch counts and termination reason', async () => {
    const metrics = createMetrics();
    metrics.recordAgentRun({ turnCount: 5, fileFetchCount: 2, terminationReason: 'SUBMITTED' });
    const text = await metrics.registry.metrics();
    expect(text).toContain('coderexic_agent_turns');
    expect(text).toContain('coderexic_agent_file_fetches');
    expect(text).toMatch(/coderexic_agent_terminations_total\{reason="SUBMITTED"\} 1/);
  });

  it('records tool calls by tool and status', async () => {
    const metrics = createMetrics();
    metrics.recordToolCall({ tool: 'get_file', status: 'ok' });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/coderexic_agent_tool_calls_total\{tool="get_file",status="ok"\} 1/);
  });

  it('records errors by code', async () => {
    const metrics = createMetrics();
    metrics.recordError('TIMEOUT');
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/coderexic_errors_total\{code="TIMEOUT"\} 1/);
  });

  it('records HTTP request duration by route template, not the raw URL', async () => {
    const metrics = createMetrics();
    metrics.observeHttpRequest({
      method: 'GET',
      route: '/api/repositories/:repositoryId',
      statusCode: 200,
      durationSeconds: 0.05,
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain('route="/api/repositories/:repositoryId"');
  });

  it('samples registered queue job counts on scrape', async () => {
    const metrics = createMetrics();
    metrics.registerQueue('review-jobs', {
      getJobCounts: () =>
        Promise.resolve({ waiting: 3, active: 1, completed: 10, failed: 0, delayed: 0 }),
    });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/coderexic_queue_jobs\{queue="review-jobs",state="waiting"\} 3/);
    expect(text).toMatch(/coderexic_queue_jobs\{queue="review-jobs",state="active"\} 1/);
  });

  it('samples multiple registered queues independently', async () => {
    const metrics = createMetrics();
    metrics.registerQueue('review-jobs', {
      getJobCounts: () =>
        Promise.resolve({ waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 }),
    });
    metrics.registerQueue('index-runs', {
      getJobCounts: () =>
        Promise.resolve({ waiting: 0, active: 2, completed: 0, failed: 0, delayed: 0 }),
    });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/coderexic_queue_jobs\{queue="review-jobs",state="waiting"\} 1/);
    expect(text).toMatch(/coderexic_queue_jobs\{queue="index-runs",state="active"\} 2/);
  });
});

describe('createNoopMetrics', () => {
  it('never throws for any call, and its registry stays empty', async () => {
    const metrics = createNoopMetrics();
    expect(() => {
      metrics.recordWebhookDelivery({ event: 'x', action: null, outcome: 'processed' });
      metrics.recordReviewOutcome({
        status: 'SUCCEEDED',
        provider: 'p',
        mode: 'one_shot',
        durationMs: 1,
      });
      metrics.recordModelUsage({ provider: 'p', model: 'm' });
      metrics.recordAgentRun({ turnCount: 1, fileFetchCount: 0, terminationReason: 'SUBMITTED' });
      metrics.recordToolCall({ tool: 't', status: 'ok' });
      metrics.recordError('X');
      metrics.observeHttpRequest({
        method: 'GET',
        route: '/x',
        statusCode: 200,
        durationSeconds: 0,
      });
      metrics.registerQueue('q', { getJobCounts: () => Promise.resolve({}) });
    }).not.toThrow();
    expect((await metrics.registry.metrics()).trim()).toBe('');
  });
});
