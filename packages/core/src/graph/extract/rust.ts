import { resolveAgainstFiles } from '../resolve.js';
import type { ExtractContext, ResolvedImport } from './types.js';

const MOD_RE = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;

/**
 * Regex-based, not a real Rust parser: only handles `mod foo;` declarations
 * (a file pulling in a sibling module), which is what creates a real
 * file-to-file dependency. `use` paths (`crate::foo::bar`) name items
 * inside modules already declared by `mod`, so they'd duplicate the same
 * edge rather than add a new one, and are not parsed here.
 */
export function extractRustImports(content: string, ctx: ExtractContext): ResolvedImport[] {
  const dir = ctx.filePath.replace(/\/(mod|lib|main)\.rs$/, '').replace(/\.rs$/, '');
  const edges: ResolvedImport[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MOD_RE)) {
    const name = match[1];
    if (!name) continue;
    const target = resolveAgainstFiles(`${dir}/${name}`, ['rs'], ['mod.rs'], ctx.allFiles);
    if (target && !seen.has(target)) {
      seen.add(target);
      edges.push({ targetPath: target, resolved: true });
    }
  }
  return edges;
}
