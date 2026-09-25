import { z } from 'zod';
import { parseEnv } from '../env.js';

/** Needed wherever the Gemini adapter runs (the worker). */
export const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
});
export type GeminiEnv = z.infer<typeof geminiEnvSchema>;

export function loadGeminiEnv(source?: Record<string, string | undefined>): GeminiEnv {
  return parseEnv(geminiEnvSchema, source);
}

export const openaiEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.1'),
});
export type OpenAIEnv = z.infer<typeof openaiEnvSchema>;

export function loadOpenAIEnv(source?: Record<string, string | undefined>): OpenAIEnv {
  return parseEnv(openaiEnvSchema, source);
}

export const anthropicEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
});
export type AnthropicEnv = z.infer<typeof anthropicEnvSchema>;

export function loadAnthropicEnv(source?: Record<string, string | undefined>): AnthropicEnv {
  return parseEnv(anthropicEnvSchema, source);
}

/** Groq's API is OpenAI-compatible; see llm/openai-compatible.ts. */
export const groqEnvSchema = z.object({
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
});
export type GroqEnv = z.infer<typeof groqEnvSchema>;

export function loadGroqEnv(source?: Record<string, string | undefined>): GroqEnv {
  return parseEnv(groqEnvSchema, source);
}
