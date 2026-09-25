import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from './tools.js';

describe('TOOL_DEFINITIONS', () => {
  it('defines exactly the four AI_AGENT_SPEC.md §5 tools', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'get_dependents',
      'get_file_content',
      'get_imports',
      'submit_review',
    ]);
  });

  it('gives every non-submit_review tool a single required "path" parameter', () => {
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.name === 'submit_review') continue;
      expect(tool.parameters).toMatchObject({ required: ['path'] });
    }
  });
});
