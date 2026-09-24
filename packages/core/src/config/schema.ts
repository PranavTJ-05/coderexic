import { z } from 'zod';
import { SEVERITIES, type Severity } from '../db/schema.js';

/** Providers this deployment can actually run (ARCHITECTURE.md §12; Phase 10 adds more). */
export const SUPPORTED_MODEL_PROVIDERS = ['gemini'] as const;
export type SupportedModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

/**
 * Caps a repo's `.coderexic.yml` can never exceed. The file is untrusted
 * repository input (ARCHITECTURE.md §16: "rules can't override system
 * safety"), so numeric fields are clamped rather than trusted verbatim -
 * a repo can narrow these limits, never widen them beyond app defaults.
 */
export const CONFIG_LIMITS = {
  minDepth: 1,
  maxDepth: 5,
  minMaxFiles: 1,
  maxMaxFiles: 30,
} as const;

const KNOWN_KEYS = new Set(['model', 'ignore', 'min_severity', 'language', 'depth', 'max_files']);

export interface ParsedRepositoryConfig {
  model: SupportedModelProvider | null;
  ignore: string[];
  minSeverity: Severity | null;
  language: string | null;
  depth: number | null;
  maxFiles: number | null;
  /** Bad fields never fail the whole file; each is reported here instead (PRODUCT_SPEC.md §18). */
  warnings: string[];
}

export const EMPTY_REPOSITORY_CONFIG: ParsedRepositoryConfig = {
  model: null,
  ignore: [],
  minSeverity: null,
  language: null,
  depth: null,
  maxFiles: null,
  warnings: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Safe for warning messages: `unknown` values may not have a meaningful `String()` form. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value;
  }
}

const documentShape = z.looseObject({});

/**
 * Validates a parsed `.coderexic.yml` (or `.verix.yml`) document field by
 * field. A single invalid or unrecognized field is dropped with a warning;
 * it never fails the rest of the document (PRODUCT_SPEC.md §11, §18).
 */
export function parseRepositoryConfig(raw: unknown): ParsedRepositoryConfig {
  const shape = documentShape.safeParse(raw);
  if (!shape.success) {
    return {
      ...EMPTY_REPOSITORY_CONFIG,
      warnings: ['config file is not a YAML mapping; using defaults'],
    };
  }
  const data: Record<string, unknown> = shape.data;
  const warnings: string[] = [];
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config key "${key}" ignored`);
  }

  let model: SupportedModelProvider | null = null;
  if (data.model !== undefined) {
    if (
      typeof data.model === 'string' &&
      (SUPPORTED_MODEL_PROVIDERS as readonly string[]).includes(data.model)
    ) {
      model = data.model as SupportedModelProvider;
    } else {
      warnings.push(`model "${describe(data.model)}" is not a supported provider; ignoring`);
    }
  }

  let minSeverity: Severity | null = null;
  if (data.min_severity !== undefined) {
    if (
      typeof data.min_severity === 'string' &&
      (SEVERITIES as readonly string[]).includes(data.min_severity)
    ) {
      minSeverity = data.min_severity as Severity;
    } else {
      warnings.push(`min_severity "${describe(data.min_severity)}" is invalid; ignoring`);
    }
  }

  let language: string | null = null;
  if (data.language !== undefined) {
    if (typeof data.language === 'string' && data.language.trim().length > 0) {
      language = data.language.trim().slice(0, 100);
    } else {
      warnings.push('language must be a non-empty string; ignoring');
    }
  }

  let depth: number | null = null;
  if (data.depth !== undefined) {
    if (typeof data.depth === 'number' && Number.isFinite(data.depth)) {
      depth = clamp(Math.trunc(data.depth), CONFIG_LIMITS.minDepth, CONFIG_LIMITS.maxDepth);
    } else {
      warnings.push('depth must be a number; ignoring');
    }
  }

  let maxFiles: number | null = null;
  if (data.max_files !== undefined) {
    if (typeof data.max_files === 'number' && Number.isFinite(data.max_files)) {
      maxFiles = clamp(
        Math.trunc(data.max_files),
        CONFIG_LIMITS.minMaxFiles,
        CONFIG_LIMITS.maxMaxFiles,
      );
    } else {
      warnings.push('max_files must be a number; ignoring');
    }
  }

  let ignore: string[] = [];
  if (data.ignore !== undefined) {
    if (Array.isArray(data.ignore) && data.ignore.every((p) => typeof p === 'string')) {
      ignore = data.ignore.filter((p) => p.trim().length > 0).slice(0, 100);
    } else {
      warnings.push('ignore must be a list of strings; ignoring');
    }
  }

  return { model, ignore, minSeverity, language, depth, maxFiles, warnings };
}
