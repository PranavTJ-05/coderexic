import { describe, expect, it } from 'vitest';
import { extractGoImports, parseGoModulePrefix } from './go.js';

function files(...paths: string[]): Set<string> {
  return new Set(paths);
}

describe('parseGoModulePrefix', () => {
  it('reads the module path from go.mod', () => {
    expect(parseGoModulePrefix('module github.com/acme/widget\n\ngo 1.22\n')).toBe(
      'github.com/acme/widget',
    );
  });

  it('returns null when there is no module directive', () => {
    expect(parseGoModulePrefix('go 1.22\n')).toBeNull();
  });
});

describe('extractGoImports', () => {
  const goModule = 'github.com/acme/widget';

  it('resolves an import under the module prefix to a file in that package directory', () => {
    const edges = extractGoImports('import "github.com/acme/widget/internal/util"\n', {
      filePath: 'main.go',
      allFiles: files('main.go', 'internal/util/util.go'),
      goModule,
    });
    expect(edges).toEqual([{ targetPath: 'internal/util/util.go', resolved: false }]);
  });

  it('resolves a grouped import block', () => {
    const edges = extractGoImports(
      'import (\n\t"fmt"\n\t"github.com/acme/widget/internal/util"\n)\n',
      { filePath: 'main.go', allFiles: files('main.go', 'internal/util/util.go'), goModule },
    );
    expect(edges).toEqual([{ targetPath: 'internal/util/util.go', resolved: false }]);
  });

  it('drops the standard library and third-party modules', () => {
    const edges = extractGoImports('import (\n\t"fmt"\n\t"github.com/pkg/errors"\n)\n', {
      filePath: 'main.go',
      allFiles: files('main.go'),
      goModule,
    });
    expect(edges).toEqual([]);
  });

  it('returns nothing when go.mod could not be read', () => {
    const edges = extractGoImports('import "github.com/acme/widget/internal/util"\n', {
      filePath: 'main.go',
      allFiles: files('main.go', 'internal/util/util.go'),
      goModule: null,
    });
    expect(edges).toEqual([]);
  });
});
