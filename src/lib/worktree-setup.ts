import type { PostCreateHook } from './providers/worktree-provider';
import type { WorktreeSetup } from './config';

const BUILTIN_SYMLINKS = ['.opencode'];

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '').replace(/^\.\//, '');
}

function isUnsafePath(p: string): boolean {
  const normalized = normalizePath(p);
  return normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../');
}

function dedup(items: string[]): string[] {
  return [...new Set(items.map(normalizePath))];
}

export function resolvePostCreateHook(
  configDefaults?: WorktreeSetup,
  overrides?: WorktreeSetup,
): PostCreateHook {
  const allCopyFiles = [
    ...(configDefaults?.copyFiles ?? []),
    ...(overrides?.copyFiles ?? []),
  ].filter((f) => !isUnsafePath(f));

  const allSymlinkDirs = [
    ...BUILTIN_SYMLINKS,
    ...(configDefaults?.symlinkDirs ?? []),
    ...(overrides?.symlinkDirs ?? []),
  ].filter((d) => !isUnsafePath(d));

  const allCommands = [
    ...(configDefaults?.commands ?? []),
    ...(overrides?.commands ?? []),
  ];

  const hook: PostCreateHook = {};

  const dedupedCopy = dedup(allCopyFiles);
  if (dedupedCopy.length > 0) {
    hook.copyFiles = dedupedCopy;
  }

  const dedupedSymlinks = dedup(allSymlinkDirs);
  if (dedupedSymlinks.length > 0) {
    hook.symlinkDirs = dedupedSymlinks;
  }

  const dedupedCommands = [...new Set(allCommands)];
  if (dedupedCommands.length > 0) {
    hook.commands = dedupedCommands;
  }

  return hook;
}
