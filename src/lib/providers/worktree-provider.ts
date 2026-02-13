/**
 * WorktreeProvider interface for managing git worktrees.
 *
 * Implementations handle creating, removing, listing, and syncing
 * isolated worktree directories for parallel development sessions.
 */

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch checked out in this worktree */
  branch: string;
  /** HEAD commit hash */
  head: string;
  /** Whether this is the main (bare) worktree */
  isMain: boolean;
}

export interface SyncResult {
  /** Whether the sync (rebase/merge) succeeded */
  success: boolean;
  /** List of conflicting file paths, if any */
  conflicts?: string[];
}

export interface PostCreateHook {
  /** Files to copy from main worktree into the new worktree */
  copyFiles?: string[];
  /** Directories to symlink from main worktree into the new worktree */
  symlinkDirs?: string[];
  /** Shell commands to run inside the new worktree after creation */
  commands?: string[];
}

export interface WorktreeProvider {
  /**
   * Create a new worktree for the given branch.
   * Returns the absolute path to the created worktree.
   */
  create(opts: {
    branch: string;
    basePath?: string;
    startPoint?: string;
    postCreate?: PostCreateHook;
  }): Promise<string>;

  /**
   * Remove a worktree at the given path.
   * Checks for dirty state unless force is true.
   */
  remove(path: string, force?: boolean): Promise<void>;

  /** List all worktrees for the current repository. */
  list(): Promise<WorktreeInfo[]>;

  /**
   * Sync a worktree with the base branch using the specified strategy.
   * Returns success status and any conflicts.
   */
  sync(path: string, strategy: 'rebase' | 'merge', baseBranch?: string, source?: 'local' | 'origin'): Promise<SyncResult>;
}
