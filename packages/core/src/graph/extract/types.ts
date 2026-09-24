import type { TsAliasConfig } from '../tsconfig.js';

/** A repo file's import, resolved to another repo file. External/unresolvable imports are dropped. */
export interface ResolvedImport {
  targetPath: string;
  /** False for a lower-confidence, heuristic match (e.g. Go's substring package match). */
  resolved: boolean;
}

export interface ExtractContext {
  filePath: string;
  /** Every path in the repo tree, for resolvers to check existence against. */
  allFiles: ReadonlySet<string>;
  tsAliases?: TsAliasConfig;
  /** Go module prefix from `go.mod` (e.g. `github.com/acme/widget`), or null if absent/unread. */
  goModule?: string | null;
}

export type Extractor = (content: string, ctx: ExtractContext) => ResolvedImport[];
