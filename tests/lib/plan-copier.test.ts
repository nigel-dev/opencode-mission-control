import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyPlansToWorktree } from '../../src/lib/plan-copier';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFile, mkdir, readFile } from 'fs/promises';

describe('plan-copier', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plan-copier-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('copies all files from source to target', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'plan-1.md'), '# Plan 1');
    await writeFile(join(sourceDir, 'plan-2.md'), '# Plan 2');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('plan-1.md');
    expect(result.copied).toContain('plan-2.md');
    expect(result.copied).toHaveLength(2);

    const content1 = await readFile(join(targetDir, 'plan-1.md'), 'utf-8');
    const content2 = await readFile(join(targetDir, 'plan-2.md'), 'utf-8');
    expect(content1).toBe('# Plan 1');
    expect(content2).toBe('# Plan 2');
  });

  it('skips state.json', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'plan-1.md'), '# Plan 1');
    await writeFile(join(sourceDir, 'state.json'), '{"version": 1}');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('plan-1.md');
    expect(result.copied).not.toContain('state.json');
    expect(result.copied).toHaveLength(1);
  });

  it('skips boulder.json', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'plan-1.md'), '# Plan 1');
    await writeFile(join(sourceDir, 'boulder.json'), '{"tasks": []}');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('plan-1.md');
    expect(result.copied).not.toContain('boulder.json');
    expect(result.copied).toHaveLength(1);
  });

  it('skips both state.json and boulder.json', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'plan-1.md'), '# Plan 1');
    await writeFile(join(sourceDir, 'plan-2.md'), '# Plan 2');
    await writeFile(join(sourceDir, 'state.json'), '{"version": 1}');
    await writeFile(join(sourceDir, 'boulder.json'), '{"tasks": []}');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('plan-1.md');
    expect(result.copied).toContain('plan-2.md');
    expect(result.copied).not.toContain('state.json');
    expect(result.copied).not.toContain('boulder.json');
    expect(result.copied).toHaveLength(2);
  });

  it('creates target directory if it does not exist', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'plan-1.md'), '# Plan 1');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('plan-1.md');
    const content = await readFile(join(targetDir, 'plan-1.md'), 'utf-8');
    expect(content).toBe('# Plan 1');
  });

  it('handles empty source directory', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(sourceDir, { recursive: true });

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toHaveLength(0);
  });

  it('returns empty list when source directory does not exist', async () => {
    const sourceDir = join(tempDir, 'nonexistent', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toHaveLength(0);
  });

  it('copies nested directories', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    await mkdir(join(sourceDir, 'subdir'), { recursive: true });
    await writeFile(join(sourceDir, 'plan-1.md'), '# Plan 1');
    await writeFile(join(sourceDir, 'subdir', 'plan-2.md'), '# Plan 2');

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('plan-1.md');
    expect(result.copied).toContain('subdir/plan-2.md');

    const content1 = await readFile(join(targetDir, 'plan-1.md'), 'utf-8');
    const content2 = await readFile(
      join(targetDir, 'subdir', 'plan-2.md'),
      'utf-8',
    );
    expect(content1).toBe('# Plan 1');
    expect(content2).toBe('# Plan 2');
  });

  it('preserves file content exactly', async () => {
    const sourceDir = join(tempDir, 'source', 'plans');
    const targetDir = join(tempDir, 'target', 'plans');

    const content = `# Complex Plan
    
## Section 1
- Item 1
- Item 2

## Section 2
Some text with special chars: !@#$%^&*()
`;

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'complex.md'), content);

    const result = await copyPlansToWorktree(sourceDir, targetDir);

    expect(result.copied).toContain('complex.md');
    const copiedContent = await readFile(
      join(targetDir, 'complex.md'),
      'utf-8',
    );
    expect(copiedContent).toBe(content);
  });
});
