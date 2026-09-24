import { describe, expect, it } from 'vitest';
import { extractRustImports } from './rust.js';

function files(...paths: string[]): Set<string> {
  return new Set(paths);
}

describe('extractRustImports', () => {
  it('resolves `mod foo;` from lib.rs to a sibling file', () => {
    const edges = extractRustImports('mod util;\n', {
      filePath: 'src/lib.rs',
      allFiles: files('src/lib.rs', 'src/util.rs'),
    });
    expect(edges).toEqual([{ targetPath: 'src/util.rs', resolved: true }]);
  });

  it('resolves `mod foo;` to a mod.rs inside a directory', () => {
    const edges = extractRustImports('pub mod util;\n', {
      filePath: 'src/main.rs',
      allFiles: files('src/main.rs', 'src/util/mod.rs'),
    });
    expect(edges).toEqual([{ targetPath: 'src/util/mod.rs', resolved: true }]);
  });

  it('resolves a nested module declared inside a non-mod.rs file', () => {
    const edges = extractRustImports('mod inner;\n', {
      filePath: 'src/foo.rs',
      allFiles: files('src/foo.rs', 'src/foo/inner.rs'),
    });
    expect(edges).toEqual([{ targetPath: 'src/foo/inner.rs', resolved: true }]);
  });

  it('drops an unresolvable module declaration', () => {
    const edges = extractRustImports('mod missing;\n', {
      filePath: 'src/lib.rs',
      allFiles: files('src/lib.rs'),
    });
    expect(edges).toEqual([]);
  });
});
