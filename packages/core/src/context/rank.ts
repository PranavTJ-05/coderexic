/**
 * Context ranking (AI_AGENT_SPEC.md §18): the changed file itself is level
 * 1 and never appears here (the caller already has it from the diff).
 * Everything else is classified into the levels below, in priority order,
 * and the engine normally stops before "unrelated" (level 6 is never
 * populated by this module - callers that want it would add it themselves).
 */
export const CONTEXT_TIERS = [
  'direct_import',
  'direct_dependent',
  'related_test',
  'second_degree',
] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];

const TIER_PRIORITY: Record<ContextTier, number> = {
  direct_import: 0,
  direct_dependent: 1,
  related_test: 2,
  second_degree: 3,
};

export interface RelatedFile {
  path: string;
  tier: ContextTier;
}

/**
 * Heuristic test-file detection shared by every supported language's own
 * convention: `*.test.*`/`*.spec.*`, `*_test.*`/`*_spec.*`, `test_*.py`, and
 * anything under a `__tests__/`/`tests/` directory.
 */
const TEST_PATH_PATTERN =
  /(^|\/)(__tests__|tests)\/|(^|\/)test_[^/]+$|[._-](test|spec)\.[^./]+$|_(test|spec)\.[^./]+$/;

export function isTestFile(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

/**
 * Merges classified path sets into a single deduped, priority-ordered list.
 * A path classified at more than one tier (e.g. both a direct import of one
 * changed file and a second-degree neighbor of another) keeps only its
 * highest-priority tier.
 */
export function rankRelatedFiles(
  classified: readonly { path: string; tier: ContextTier }[],
): RelatedFile[] {
  const bestTier = new Map<string, ContextTier>();
  for (const { path, tier } of classified) {
    const current = bestTier.get(path);
    if (!current || TIER_PRIORITY[tier] < TIER_PRIORITY[current]) {
      bestTier.set(path, tier);
    }
  }
  return [...bestTier.entries()]
    .map(([path, tier]) => ({ path, tier }))
    .sort((a, b) => TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier] || a.path.localeCompare(b.path));
}
