import { describe, it, expect } from 'vitest';
import { Glob } from 'bun';
import { readFileSync } from 'fs';
import { join } from 'path';

// The OpenCode server runtime can drop the async project context across a
// dynamic `import()`, which silently sends git and state lookups to the
// server's working directory. Source modules must use static imports.
describe('source modules', () => {
  it('do not use dynamic import()', () => {
    const root = join(import.meta.dir, '..', 'src');
    const offenders: string[] = [];

    for (const file of new Glob('**/*.{ts,tsx}').scanSync(root)) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/\bimport\(/.test(line) && !line.trimStart().startsWith('//') && !/typeof import\(/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
