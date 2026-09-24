import { describe, expect, it } from 'vitest';
import { extractJavaImports } from './java.js';

function files(...paths: string[]): Set<string> {
  return new Set(paths);
}

describe('extractJavaImports', () => {
  it('resolves a fully-qualified import against src/main/java', () => {
    const edges = extractJavaImports('import com.acme.widget.Util;\n', {
      filePath: 'src/main/java/com/acme/widget/Main.java',
      allFiles: files(
        'src/main/java/com/acme/widget/Main.java',
        'src/main/java/com/acme/widget/Util.java',
      ),
    });
    expect(edges).toEqual([
      { targetPath: 'src/main/java/com/acme/widget/Util.java', resolved: true },
    ]);
  });

  it('resolves a static import to the declaring class', () => {
    const edges = extractJavaImports('import static com.acme.widget.Util.CONST;\n', {
      filePath: 'src/main/java/com/acme/widget/Main.java',
      allFiles: files('src/main/java/com/acme/widget/Util.java'),
    });
    expect(edges).toEqual([
      { targetPath: 'src/main/java/com/acme/widget/Util.java', resolved: true },
    ]);
  });

  it('drops a wildcard package import', () => {
    const edges = extractJavaImports('import com.acme.widget.*;\n', {
      filePath: 'Main.java',
      allFiles: files('src/main/java/com/acme/widget/Util.java'),
    });
    expect(edges).toEqual([]);
  });

  it('drops an external library import', () => {
    const edges = extractJavaImports('import org.junit.Test;\n', {
      filePath: 'src/test/java/com/acme/widget/UtilTest.java',
      allFiles: files('src/test/java/com/acme/widget/UtilTest.java'),
    });
    expect(edges).toEqual([]);
  });
});
