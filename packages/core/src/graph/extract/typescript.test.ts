import { describe, expect, it } from 'vitest';
import { extractTypeScriptImports } from './typescript.js';

function files(...paths: string[]): Set<string> {
  return new Set(paths);
}

describe('extractTypeScriptImports', () => {
  it('resolves a direct relative import', () => {
    const edges = extractTypeScriptImports("import { a } from './a';", {
      filePath: 'src/index.ts',
      allFiles: files('src/index.ts', 'src/a.ts'),
    });
    expect(edges).toEqual([{ targetPath: 'src/a.ts', resolved: true }]);
  });

  it('resolves a parent-relative import', () => {
    const edges = extractTypeScriptImports("import { b } from '../lib/b';", {
      filePath: 'src/routes/index.ts',
      allFiles: files('src/routes/index.ts', 'src/lib/b.ts'),
    });
    expect(edges).toEqual([{ targetPath: 'src/lib/b.ts', resolved: true }]);
  });

  it('resolves an import to a directory index file', () => {
    const edges = extractTypeScriptImports("import { c } from './utils';", {
      filePath: 'src/index.ts',
      allFiles: files('src/index.ts', 'src/utils/index.ts'),
    });
    expect(edges).toEqual([{ targetPath: 'src/utils/index.ts', resolved: true }]);
  });

  it('drops an unresolvable relative import instead of guessing', () => {
    const edges = extractTypeScriptImports("import { d } from './missing';", {
      filePath: 'src/index.ts',
      allFiles: files('src/index.ts'),
    });
    expect(edges).toEqual([]);
  });

  it('drops a bare specifier (external package or Node builtin)', () => {
    const edges = extractTypeScriptImports("import { z } from 'zod';\nimport fs from 'node:fs';", {
      filePath: 'src/index.ts',
      allFiles: files('src/index.ts'),
    });
    expect(edges).toEqual([]);
  });

  it('resolves a path alias against tsconfig paths and baseUrl', () => {
    const edges = extractTypeScriptImports("import { e } from '@/lib/e';", {
      filePath: 'src/index.ts',
      allFiles: files('src/index.ts', 'src/lib/e.ts'),
      tsAliases: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    });
    expect(edges).toEqual([{ targetPath: 'src/lib/e.ts', resolved: true }]);
  });

  it('deduplicates repeated imports of the same target', () => {
    const edges = extractTypeScriptImports(
      "import { a } from './a';\nimport type { A } from './a';",
      { filePath: 'src/index.ts', allFiles: files('src/index.ts', 'src/a.ts') },
    );
    expect(edges).toHaveLength(1);
  });

  it('resolves both sides of a circular import independently', () => {
    const aEdges = extractTypeScriptImports("import { b } from './b';", {
      filePath: 'src/a.ts',
      allFiles: files('src/a.ts', 'src/b.ts'),
    });
    const bEdges = extractTypeScriptImports("import { a } from './a';", {
      filePath: 'src/b.ts',
      allFiles: files('src/a.ts', 'src/b.ts'),
    });
    expect(aEdges).toEqual([{ targetPath: 'src/b.ts', resolved: true }]);
    expect(bEdges).toEqual([{ targetPath: 'src/a.ts', resolved: true }]);
  });

  it('resolves dynamic import() and CommonJS require()', () => {
    const edges = extractTypeScriptImports(
      "const x = require('./req');\nimport('./dyn').then(() => {});",
      { filePath: 'src/index.ts', allFiles: files('src/index.ts', 'src/req.ts', 'src/dyn.ts') },
    );
    expect(edges).toContainEqual({ targetPath: 'src/req.ts', resolved: true });
    expect(edges).toContainEqual({ targetPath: 'src/dyn.ts', resolved: true });
  });
});
