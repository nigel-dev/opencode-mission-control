import { loadConfig } from './config';
import { gitCommand } from './git';

/**
 * Untracked paths that are never a job's own work: OpenCode's project
 * directory (always symlinked into a worktree) and Hindsight's memory files.
 */
const ALWAYS_IGNORED = ['.opencode', '.hindsight'];

export interface WorktreeOwner {
  worktreePath: string;
  /** Paths Mission Control created during worktree setup (see `Job.setupArtifacts`). */
  setupArtifacts?: string[];
}

function normalize(path: string): string {
  return path.replace(/\/+$/, '').replace(/^\.\//, '');
}

function isUnder(path: string, artifact: string): boolean {
  return path === artifact || path.startsWith(`${artifact}/`);
}

/** Parse `git status --porcelain -z`: `XY path`, with a second entry (the source) after a rename or copy. */
export function parsePorcelainStatus(output: string): string[] {
  const entries = output.split('\0').filter((entry) => entry.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      index++;
    }
  }
  return paths;
}

/**
 * Files in a job's worktree that are modified or untracked and not committed,
 * leaving out what Mission Control itself put there during setup (copied
 * files, symlinked directories). Throws when the worktree cannot be inspected.
 */
export async function findUncommittedChanges(owner: WorktreeOwner): Promise<string[]> {
  const status = await gitCommand(['-C', owner.worktreePath, 'status', '--porcelain', '-z'], { raw: true });
  if (status.exitCode !== 0) {
    throw new Error(`Cannot check worktree status at ${owner.worktreePath}: ${status.stderr.trim()}`);
  }

  let artifacts = owner.setupArtifacts;
  if (!artifacts) {
    // Jobs recorded before setup artifacts were stored: fall back to the
    // project's configured setup.
    const setup = (await loadConfig()).worktreeSetup;
    artifacts = [...(setup?.copyFiles ?? []), ...(setup?.symlinkDirs ?? [])];
  }
  const ignored = [...ALWAYS_IGNORED, ...artifacts].map(normalize).filter(Boolean);

  return parsePorcelainStatus(status.stdout)
    .map(normalize)
    .filter((path) => !ignored.some((artifact) => isUnder(path, artifact)));
}
