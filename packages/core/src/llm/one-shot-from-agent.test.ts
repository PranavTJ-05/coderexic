import { describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  AgentChatResult,
  AgentMessage,
  ToolDefinition,
} from '../agent/types.js';
import { createOneShotFromAgentAdapter } from './one-shot-from-agent.js';
import { ModelHttpError, ModelInvalidOutputError } from './errors.js';

const INPUT = {
  repositoryFullName: 'octo/demo',
  pullRequestTitle: 'Fix bug',
  pullRequestBody: null,
  files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }],
};

const VALID_OUTPUT = { summary: 'ok', reviews: [] };

function fakeAdapter(
  respond: (messages: readonly AgentMessage[], tools: readonly ToolDefinition[]) => AgentChatResult,
): AgentAdapter {
  return { chat: (messages, tools) => Promise.resolve(respond(messages, tools)) };
}

describe('createOneShotFromAgentAdapter', () => {
  it('calls chat once with only the submit_review tool and toolChoice forcing it', async () => {
    let seenTools: readonly ToolDefinition[] = [];
    let seenToolChoice: { name: string } | undefined;
    const adapter = fakeAdapter((_messages, tools) => {
      seenTools = tools;
      return { text: null, toolCalls: [{ id: '1', name: 'submit_review', args: VALID_OUTPUT }] };
    });
    const wrapped: AgentAdapter = {
      chat: (messages, tools, options) => {
        seenToolChoice = options?.toolChoice;
        return adapter.chat(messages, tools, options);
      },
    };
    const model = createOneShotFromAgentAdapter(wrapped);
    const result = await model.generateReview(INPUT);

    expect(result).toEqual(VALID_OUTPUT);
    expect(seenTools).toHaveLength(1);
    expect(seenTools[0]?.name).toBe('submit_review');
    expect(seenToolChoice).toEqual({ name: 'submit_review' });
  });

  it('parses a JSON-string tool call arguments field', async () => {
    const adapter = fakeAdapter(() => ({
      text: null,
      toolCalls: [{ id: '1', name: 'submit_review', args: JSON.stringify(VALID_OUTPUT) }],
    }));
    const model = createOneShotFromAgentAdapter(adapter);
    await expect(model.generateReview(INPUT)).resolves.toEqual(VALID_OUTPUT);
  });

  it('falls back to parsing plain text when the provider ignores toolChoice', async () => {
    const adapter = fakeAdapter(() => ({
      text: '```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```',
      toolCalls: null,
    }));
    const model = createOneShotFromAgentAdapter(adapter);
    await expect(model.generateReview(INPUT)).resolves.toEqual(VALID_OUTPUT);
  });

  it('rejects unparseable text with ModelInvalidOutputError', async () => {
    const adapter = fakeAdapter(() => ({ text: 'not json at all', toolCalls: null }));
    const model = createOneShotFromAgentAdapter(adapter);
    await expect(model.generateReview(INPUT)).rejects.toBeInstanceOf(ModelInvalidOutputError);
  });

  it('rejects a schema-invalid payload with ModelInvalidOutputError', async () => {
    const adapter = fakeAdapter(() => ({
      text: null,
      toolCalls: [{ id: '1', name: 'submit_review', args: { summary: 'x' } }],
    }));
    const model = createOneShotFromAgentAdapter(adapter);
    await expect(model.generateReview(INPUT)).rejects.toBeInstanceOf(ModelInvalidOutputError);
  });

  it('propagates a ModelError from the adapter unchanged', async () => {
    const adapter: AgentAdapter = { chat: () => Promise.reject(new ModelHttpError('boom', 500)) };
    const model = createOneShotFromAgentAdapter(adapter);
    await expect(model.generateReview(INPUT)).rejects.toBeInstanceOf(ModelHttpError);
  });

  it('wraps a non-ModelError failure as ModelInvalidOutputError', async () => {
    const adapter: AgentAdapter = { chat: () => Promise.reject(new Error('weird failure')) };
    const model = createOneShotFromAgentAdapter(adapter);
    await expect(model.generateReview(INPUT)).rejects.toBeInstanceOf(ModelInvalidOutputError);
  });
});
