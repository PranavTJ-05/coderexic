import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ModelReviewOutput } from '../llm/types.js';
import { runAgentLoop } from './loop.js';
import type {
  AgentAdapter,
  AgentChatResult,
  AgentMessage,
  ToolExecutionResult,
  ToolExecutor,
} from './types.js';

function fakeAdapter(
  responses: readonly AgentChatResult[],
  onCall?: (messages: readonly AgentMessage[]) => void,
): { adapter: AgentAdapter; chat: Mock } {
  let call = 0;
  const chat = vi.fn((messages: readonly AgentMessage[]): Promise<AgentChatResult> => {
    onCall?.(messages);
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (!response) throw new Error('no fake response configured');
    return Promise.resolve(response);
  });
  return { adapter: { chat }, chat };
}

interface FakeExecutorOptions {
  results?: Record<string, ToolExecutionResult>;
  deliveredFileCount?: number;
}

function fakeExecutor({ results = {}, deliveredFileCount = 0 }: FakeExecutorOptions = {}): {
  executor: ToolExecutor;
  execute: Mock;
} {
  const execute = vi.fn((toolName: string): Promise<ToolExecutionResult> => {
    return Promise.resolve(
      results[toolName] ?? { text: `${toolName} result`, status: 'SUCCEEDED' },
    );
  });
  return {
    executor: {
      execute,
      get deliveredFileCount() {
        return deliveredFileCount;
      },
    },
    execute,
  };
}

const SUBMIT_OUTPUT: ModelReviewOutput = { summary: 'looks fine', reviews: [] };

describe('runAgentLoop', () => {
  it('goes tool calls -> submit_review and succeeds with NO_FINDINGS on an empty reviews array', async () => {
    const { adapter } = fakeAdapter([
      {
        text: null,
        toolCalls: [{ id: '1', name: 'get_imports', args: { path: 'src/a.ts' } }],
      },
      {
        text: null,
        toolCalls: [{ id: '2', name: 'submit_review', args: SUBMIT_OUTPUT }],
      },
    ]);
    const { executor, execute } = fakeExecutor({
      results: {
        submit_review: {
          text: 'Review submitted.',
          done: true,
          output: SUBMIT_OUTPUT,
          status: 'SUCCEEDED',
        },
      },
    });

    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 'system',
      initialUserMessage: 'diff',
    });

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      terminationReason: 'NO_FINDINGS',
      turnCount: 2,
      output: SUBMIT_OUTPUT,
    });
    expect(execute).toHaveBeenCalledWith('get_imports', { path: 'src/a.ts' });
    expect(execute).toHaveBeenCalledWith('submit_review', SUBMIT_OUTPUT);
  });

  it('reports SUBMITTED when the review has findings', async () => {
    const output: ModelReviewOutput = {
      summary: 's',
      reviews: [
        {
          filename: 'a.ts',
          severity: 'low',
          start_line: 1,
          end_line: 1,
          issue: 'x',
          fix_type: 'warning',
          suggested_code: null,
        },
      ],
    };
    const { adapter } = fakeAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'submit_review', args: output }] },
    ]);
    const { executor } = fakeExecutor({
      results: { submit_review: { text: 'ok', done: true, output, status: 'SUCCEEDED' } },
    });
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
    });
    expect(result.terminationReason).toBe('SUBMITTED');
    expect(result.status).toBe('SUCCEEDED');
  });

  it('terminates with MAX_TURNS when the model never submits', async () => {
    const { adapter } = fakeAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'get_imports', args: { path: 'a.ts' } }] },
    ]);
    const { executor } = fakeExecutor();
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
      maxTurns: 3,
    });
    expect(result).toMatchObject({
      status: 'FAILED',
      terminationReason: 'MAX_TURNS',
      turnCount: 3,
    });
  });

  it('tells the model on its final turn that it must submit now', async () => {
    const snapshots: (readonly AgentMessage[])[] = [];
    const { adapter } = fakeAdapter(
      [
        { text: null, toolCalls: [{ id: '1', name: 'get_imports', args: {} }] },
        { text: null, toolCalls: [{ id: '2', name: 'get_imports', args: {} }] },
      ],
      (messages) => snapshots.push([...messages]),
    );
    const { executor } = fakeExecutor();
    await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
      maxTurns: 2,
    });
    const secondCallMessages = snapshots[1]!;
    const lastMessage = secondCallMessages[secondCallMessages.length - 1]!;
    expect(lastMessage).toMatchObject({ role: 'user' });
    expect((lastMessage as { content: string }).content).toContain('final turn');
  });

  it('rejects a get_file_content call once the fetch limit is reached, without dispatching it', async () => {
    const { adapter } = fakeAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'get_file_content', args: { path: 'big.ts' } }] },
      { text: null, toolCalls: [{ id: '2', name: 'submit_review', args: SUBMIT_OUTPUT }] },
    ]);
    const { executor, execute } = fakeExecutor({
      deliveredFileCount: 2,
      results: {
        submit_review: { text: 'ok', done: true, output: SUBMIT_OUTPUT, status: 'SUCCEEDED' },
      },
    });
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
      maxFileFetches: 2,
    });
    expect(execute).not.toHaveBeenCalledWith('get_file_content', expect.anything());
    // Even though it submitted, the run still noticed the limit was hit along the way.
    expect(result.status).toBe('SUCCEEDED');
  });

  it('records MAX_FILE_FETCHES as the termination reason when the limit is hit and the run never submits', async () => {
    const { adapter } = fakeAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'get_file_content', args: { path: 'a.ts' } }] },
    ]);
    const { executor } = fakeExecutor({ deliveredFileCount: 5 });
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
      maxTurns: 2,
      maxFileFetches: 5,
    });
    expect(result.terminationReason).toBe('MAX_FILE_FETCHES');
    expect(result.status).toBe('FAILED');
  });

  it('falls back to parsing plain text as the review when no tool call is made', async () => {
    const { adapter } = fakeAdapter([
      { text: '```json\n' + JSON.stringify(SUBMIT_OUTPUT) + '\n```', toolCalls: null },
    ]);
    const { executor, execute } = fakeExecutor({
      results: {
        submit_review: { text: 'ok', done: true, output: SUBMIT_OUTPUT, status: 'SUCCEEDED' },
      },
    });
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
    });
    expect(result).toMatchObject({ status: 'SUCCEEDED', terminationReason: 'NO_FINDINGS' });
    expect(execute).toHaveBeenCalledWith('submit_review', SUBMIT_OUTPUT);
  });

  it('terminates with INVALID_OUTPUT when there is no tool call and the text is not parseable', async () => {
    const { adapter } = fakeAdapter([{ text: 'I am still thinking about this.', toolCalls: null }]);
    const { executor } = fakeExecutor();
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
    });
    expect(result).toMatchObject({
      status: 'FAILED',
      terminationReason: 'INVALID_OUTPUT',
      output: null,
    });
  });

  it('terminates with MODEL_ERROR when the adapter throws', async () => {
    const adapter: AgentAdapter = { chat: () => Promise.reject(new Error('boom')) };
    const { executor } = fakeExecutor();
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
    });
    expect(result).toMatchObject({ status: 'FAILED', terminationReason: 'MODEL_ERROR' });
  });

  it('terminates with TIMEOUT and a TIMED_OUT status when the deadline elapses', async () => {
    const adapter: AgentAdapter = {
      chat: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, 500);
        }),
    };
    const { executor } = fakeExecutor();
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
      deadlineMs: 20,
    });
    expect(result).toMatchObject({
      status: 'TIMED_OUT',
      terminationReason: 'TIMEOUT',
      output: null,
    });
  });

  it('answers every tool call in a turn before checking whether any of them submitted', async () => {
    const { adapter } = fakeAdapter([
      {
        text: null,
        toolCalls: [
          { id: '1', name: 'get_imports', args: {} },
          { id: '2', name: 'submit_review', args: SUBMIT_OUTPUT },
          { id: '3', name: 'get_dependents', args: {} },
        ],
      },
    ]);
    const { executor, execute } = fakeExecutor({
      results: {
        submit_review: { text: 'ok', done: true, output: SUBMIT_OUTPUT, status: 'SUCCEEDED' },
      },
    });
    const result = await runAgentLoop({
      adapter,
      executor,
      systemPrompt: 's',
      initialUserMessage: 'u',
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('SUCCEEDED');
  });
});
