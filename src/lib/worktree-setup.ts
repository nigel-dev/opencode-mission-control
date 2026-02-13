import type { PostCreateHook } from './providers/worktree-provider';
import type { WorktreeSetup } from './config';

export type CommandValidationResult = {
  safe: boolean;
  warnings: string[];
};

// Each entry: [regex pattern, human-readable warning message]
const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/`[^`]+`/, 'backtick command substitution'],
  [/\$\(/, 'dollar-paren command substitution'],
  [/\beval\b/, 'eval execution'],
  [/\bexec\b/, 'exec execution'],
  [/\|\s*(sh|bash|zsh|dash)\b/, 'pipe to shell interpreter'],
  [/\b(curl|wget)\b.*\|/, 'remote script piped to another command'],
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-[a-zA-Z]*r[a-zA-Z]*\s+\//, 'recursive delete from root'],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*\s+\//, 'recursive force-delete from root'],
  [/\brm\s+-rf\s+\//, 'rm -rf /'],
  [/>\s*\/etc\//, 'redirect to /etc/'],
  [/>\s*\/usr\//, 'redirect to /usr/'],
  [/>\s*\/sys\//, 'redirect to /sys/'],
  [/>\s*\/proc\//, 'redirect to /proc/'],
  [/;/, 'semicolon-chained commands'],
  [/&&/, 'chained commands (&&)'],
  [/\|(?!\|)/, 'pipe operator'],
];

const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^(npm|npx)\s+(install|ci|run\s+\S+|test|build|start|exec)\b/,
  /^bun\s+(install|add|remove|run\s+\S+|test|build|x)\b/,
  /^yarn(\s+(install|add|remove|run\s+\S+|test|build))?$/,
  /^pnpm\s+(install|add|remove|run\s+\S+|test|build)\b/,
  /^pip\s+install\b/,
  /^cargo\s+(build|test|run|check|clippy|fmt)\b/,
  /^make(\s+\w+)?$/,
  /^go\s+(build|test|mod\s+\w+)\b/,
  /^mvn\s+/,
  /^gradle\s+/,
  /^dotnet\s+(build|test|restore|run)\b/,
  /^composer\s+(install|update|require)\b/,
  /^bundle\s+(install|exec)\b/,
  /^gem\s+install\b/,
  /^mix\s+(deps\.get|compile|test)\b/,
  /^poetry\s+(install|build|run)\b/,
  /^cmake\b/,
];

export function validateCommand(command: string): CommandValidationResult {
  const trimmed = command.trim();
  const warnings: string[] = [];

  if (trimmed.length === 0) {
    return { safe: false, warnings: ['empty command'] };
  }

  for (const pattern of SAFE_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: true, warnings: [] };
    }
  }

  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      warnings.push(description);
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
  };
}

export function validateCommands(
  commands: string[],
): { command: string; result: CommandValidationResult }[] {
  return commands.map((command) => ({
    command,
    result: validateCommand(command),
  }));
}

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
