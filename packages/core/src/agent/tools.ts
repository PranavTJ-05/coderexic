import { FIX_TYPES, SEVERITIES } from '../db/schema.js';
import type { ToolDefinition } from './types.js';

const PATH_PARAM = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Repo-relative file path, e.g. "src/auth.ts". No leading "/" and no "..".',
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

/** AI_AGENT_SPEC.md §5: every tool's input is `{ "path": ... }` except `submit_review`. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'get_file_content',
    description:
      "Read a file's full content at the pull request's head commit. Repo-relative path only.",
    parameters: PATH_PARAM,
  },
  {
    name: 'get_imports',
    description: 'List the files a given file imports (its forward dependencies).',
    parameters: PATH_PARAM,
  },
  {
    name: 'get_dependents',
    description: 'List the files that import a given file (its blast radius).',
    parameters: PATH_PARAM,
  },
  {
    name: 'submit_review',
    description:
      'Finish the investigation and submit the final review. Must be called exactly once, at the end.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: "One paragraph summarizing the PR's review." },
        reviews: {
          type: 'array',
          description: 'Findings. Empty if there are no real issues.',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              severity: { type: 'string', enum: [...SEVERITIES] },
              start_line: { type: 'integer' },
              end_line: { type: 'integer' },
              issue: { type: 'string' },
              fix_type: { type: 'string', enum: [...FIX_TYPES] },
              // Adapters that don't support a nullable JSON Schema type union (e.g. Gemini's
              // function-calling schema) translate this field when building their own tool spec.
              suggested_code: { type: ['string', 'null'] },
            },
            required: ['filename', 'severity', 'start_line', 'end_line', 'issue', 'fix_type'],
          },
        },
      },
      required: ['summary', 'reviews'],
      additionalProperties: false,
    },
  },
];
