import type { EvalCase } from '../types.js';
import { FALSE_POSITIVE_CASES } from './false-positives.js';
import { KNOWN_BUG_CASES } from './known-bugs.js';

export { FALSE_POSITIVE_CASES } from './false-positives.js';
export { KNOWN_BUG_CASES } from './known-bugs.js';

/** Every fixture case (ROADMAP.md Phase 15's "start with 25-50 cases"). */
export const ALL_EVAL_CASES: readonly EvalCase[] = [...KNOWN_BUG_CASES, ...FALSE_POSITIVE_CASES];
