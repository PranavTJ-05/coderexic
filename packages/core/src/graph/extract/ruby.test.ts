import { describe, expect, it } from 'vitest';
import { extractRubyImports } from './ruby.js';

function files(...paths: string[]): Set<string> {
  return new Set(paths);
}

describe('extractRubyImports', () => {
  it('resolves require_relative against the current file directory', () => {
    const edges = extractRubyImports("require_relative 'util'\n", {
      filePath: 'lib/widget/main.rb',
      allFiles: files('lib/widget/main.rb', 'lib/widget/util.rb'),
    });
    expect(edges).toEqual([{ targetPath: 'lib/widget/util.rb', resolved: true }]);
  });

  it('resolves require_relative with a parent-directory path', () => {
    const edges = extractRubyImports("require_relative '../shared/helper'\n", {
      filePath: 'lib/widget/main.rb',
      allFiles: files('lib/widget/main.rb', 'lib/shared/helper.rb'),
    });
    expect(edges).toEqual([{ targetPath: 'lib/shared/helper.rb', resolved: true }]);
  });

  it('resolves a plain require against lib/', () => {
    const edges = extractRubyImports("require 'widget/util'\n", {
      filePath: 'lib/widget/main.rb',
      allFiles: files('lib/widget/main.rb', 'lib/widget/util.rb'),
    });
    expect(edges).toEqual([{ targetPath: 'lib/widget/util.rb', resolved: true }]);
  });

  it('drops a require for an external gem', () => {
    const edges = extractRubyImports("require 'json'\n", {
      filePath: 'lib/widget/main.rb',
      allFiles: files('lib/widget/main.rb'),
    });
    expect(edges).toEqual([]);
  });
});
