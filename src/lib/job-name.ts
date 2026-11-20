// Dependency-free: shared by the server part (launch, plans) and the TUI part.

const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_JOB_NAME_LENGTH = 100;

/**
 * Why `name` cannot be a job name, or undefined when it can. A job name
 * becomes a branch (`mc/<name>`), a worktree directory and a session title, so
 * it has to be a single safe path segment that git accepts in a ref.
 */
export function validateJobName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A job name is required.';
  if (!JOB_NAME_PATTERN.test(trimmed)) {
    return 'Use letters, digits, dots, dashes and underscores only.';
  }
  if (trimmed.length > MAX_JOB_NAME_LENGTH) {
    return `Use at most ${MAX_JOB_NAME_LENGTH} characters.`;
  }
  if (trimmed.includes('..') || trimmed.endsWith('.') || trimmed.endsWith('.lock')) {
    return 'A job name cannot contain "..", or end with "." or ".lock".';
  }
  return undefined;
}

export function assertValidJobName(name: string): void {
  const problem = validateJobName(name);
  if (problem) {
    throw new Error(`Invalid job name "${name}": ${problem}`);
  }
}
