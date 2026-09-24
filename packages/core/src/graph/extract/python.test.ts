import { describe, expect, it } from 'vitest';
import { extractPythonImports } from './python.js';

function files(...paths: string[]): Set<string> {
  return new Set(paths);
}

describe('extractPythonImports', () => {
  it('resolves `import foo.bar` against a src/ layout', () => {
    const edges = extractPythonImports('import pkg.mod', {
      filePath: 'src/pkg/main.py',
      allFiles: files('src/pkg/main.py', 'src/pkg/mod.py'),
    });
    expect(edges).toEqual([{ targetPath: 'src/pkg/mod.py', resolved: true }]);
  });

  it('resolves `from foo.bar import x` to a package __init__.py', () => {
    const edges = extractPythonImports('from pkg.sub import thing', {
      filePath: 'main.py',
      allFiles: files('main.py', 'pkg/sub/__init__.py'),
    });
    expect(edges).toEqual([{ targetPath: 'pkg/sub/__init__.py', resolved: true }]);
  });

  it('resolves a single-dot relative import to the current package', () => {
    const edges = extractPythonImports('from . import sibling', {
      filePath: 'pkg/mod.py',
      allFiles: files('pkg/mod.py', 'pkg/sibling.py'),
    });
    expect(edges).toEqual([{ targetPath: 'pkg/sibling.py', resolved: true }]);
  });

  it('resolves a double-dot relative import to a parent package', () => {
    const edges = extractPythonImports('from ..other import thing', {
      filePath: 'pkg/sub/mod.py',
      allFiles: files('pkg/sub/mod.py', 'pkg/other.py'),
    });
    expect(edges).toEqual([{ targetPath: 'pkg/other.py', resolved: true }]);
  });

  it('drops an unresolvable import', () => {
    const edges = extractPythonImports('import nope.nothere', {
      filePath: 'main.py',
      allFiles: files('main.py'),
    });
    expect(edges).toEqual([]);
  });

  it('drops an external package import', () => {
    const edges = extractPythonImports('import requests\nfrom django.db import models', {
      filePath: 'main.py',
      allFiles: files('main.py'),
    });
    expect(edges).toEqual([]);
  });
});
