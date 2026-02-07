import { describe, it, expect } from 'vitest';
import { resolvePostCreateHook } from '../../src/lib/worktree-setup';

describe('resolvePostCreateHook', () => {
  it('should always include .opencode in symlinkDirs', () => {
    const result = resolvePostCreateHook();
    expect(result.symlinkDirs).toContain('.opencode');
  });

  it('should include .opencode even when overrides provide empty symlinkDirs', () => {
    const result = resolvePostCreateHook(undefined, { symlinkDirs: [] });
    expect(result.symlinkDirs).toContain('.opencode');
  });

  it('should merge config defaults with overrides', () => {
    const result = resolvePostCreateHook(
      { copyFiles: ['.env'], symlinkDirs: ['node_modules'] },
      { copyFiles: ['.env.local'], symlinkDirs: ['dist'] },
    );

    expect(result.copyFiles).toEqual(['.env', '.env.local']);
    expect(result.symlinkDirs).toContain('.opencode');
    expect(result.symlinkDirs).toContain('node_modules');
    expect(result.symlinkDirs).toContain('dist');
  });

  it('should deduplicate entries', () => {
    const result = resolvePostCreateHook(
      { copyFiles: ['.env'], symlinkDirs: ['.opencode'] },
      { copyFiles: ['.env'], symlinkDirs: ['.opencode'] },
    );

    expect(result.copyFiles).toEqual(['.env']);
    expect(result.symlinkDirs!.filter((d) => d === '.opencode')).toHaveLength(1);
  });

  it('should normalize trailing slashes', () => {
    const result = resolvePostCreateHook(
      { symlinkDirs: ['node_modules/'] },
      { symlinkDirs: ['node_modules'] },
    );

    expect(result.symlinkDirs!.filter((d) => d === 'node_modules')).toHaveLength(1);
  });

  it('should reject absolute paths', () => {
    const result = resolvePostCreateHook(undefined, {
      copyFiles: ['/etc/passwd'],
      symlinkDirs: ['/usr/local'],
    });

    expect(result.copyFiles).toBeUndefined();
    expect(result.symlinkDirs).toEqual(['.opencode']);
  });

  it('should reject parent directory traversal', () => {
    const result = resolvePostCreateHook(undefined, {
      copyFiles: ['../secret.env'],
    });

    expect(result.copyFiles).toBeUndefined();
  });

  it('should append commands in order (config first, overrides second)', () => {
    const result = resolvePostCreateHook(
      { commands: ['npm install'] },
      { commands: ['npm run build'] },
    );

    expect(result.commands).toEqual(['npm install', 'npm run build']);
  });

  it('should return empty hook properties when nothing provided', () => {
    const result = resolvePostCreateHook();
    expect(result.copyFiles).toBeUndefined();
    expect(result.commands).toBeUndefined();
    expect(result.symlinkDirs).toEqual(['.opencode']);
  });
});
