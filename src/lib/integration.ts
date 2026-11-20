/**
 * Integration branch lifecycle management.
 * Handles creation, worktree setup and cleanup of integration branches
 * used for orchestrated merge trains.
 */

import { join } from 'path';
import { gitCommand, getDefaultBranch } from './git';
import { getProjectId, getXdgDataDir } from './paths';
import { createWorktree, removeWorktree } from './worktree';
import type { PostCreateHook } from './providers/worktree-provider';

const XDG_DATA_DIR = getXdgDataDir();

/**
 * Create an integration branch from the current main HEAD.
 * Sets up a dedicated worktree for the integration branch.
 * Handles edge case: if branch already exists from a failed run, deletes and recreates.
 *
 * @param planId - The plan ID to create integration branch for
 * @returns Promise with branch name and worktree path
 */
export async function createIntegrationBranch(
  planId: string,
  postCreate?: PostCreateHook,
  baseRef?: string,
): Promise<{ branch: string; worktreePath: string }> {
  const projectId = await getProjectId();
  const branchName = `mc/integration-${planId}`;
  const worktreePath = join(XDG_DATA_DIR, projectId, `mc-integration-${planId}`);

  // Check if branch already exists from a failed previous run
  const branchCheckResult = await gitCommand(['branch', '--list', branchName]);
  const branchExists = branchCheckResult.stdout.includes(branchName);

  if (branchExists) {
    // Clean up the old branch and worktree
    try {
      await deleteIntegrationBranch(planId);
    } catch (error) {
      // Leftovers of a failed run. If they are really in the way, creating the
      // branch below fails with the reason.
      console.warn(`[Mission Control] Could not remove the old integration branch ${branchName}:`, error);
    }
  }

  // Get the current main HEAD to create branch from
  const baseBranch = baseRef ?? await getDefaultBranch();
  const baseHeadResult = await gitCommand(['rev-parse', baseBranch]);
  if (baseHeadResult.exitCode !== 0) {
    throw new Error(`Failed to get ${baseBranch} HEAD: ` + baseHeadResult.stderr);
  }

  // Create the branch from main HEAD
  const createBranchResult = await gitCommand([
    'branch',
    branchName,
    baseHeadResult.stdout,
  ]);
  if (createBranchResult.exitCode !== 0) {
    throw new Error(`Failed to create integration branch: ${createBranchResult.stderr}`);
  }

  const worktreePathResult = await createWorktree({
    branch: branchName,
    basePath: worktreePath,
    postCreate,
  });

  return {
    branch: branchName,
    worktreePath: worktreePathResult,
  };
}

/**
 * Delete an integration branch and its worktree.
 * Handles "already deleted" gracefully (no error if missing).
 *
 * @param planId - The plan ID
 */
export async function deleteIntegrationBranch(planId: string): Promise<void> {
  const projectId = await getProjectId();
  const branchName = `mc/integration-${planId}`;
  const worktreePath = join(XDG_DATA_DIR, projectId, `mc-integration-${planId}`);

  // Remove the worktree (force to handle any uncommitted changes)
  try {
    await removeWorktree(worktreePath, true);
  } catch {
    // The worktree is already gone (never created, or removed by hand):
    // deleting the branch below is all that is left to do.
  }

  // Delete the branch
  const deleteBranchResult = await gitCommand(['branch', '-D', branchName]);
  if (deleteBranchResult.exitCode !== 0) {
    // Ignore if branch doesn't exist
    if (!deleteBranchResult.stderr.includes('not found')) {
      throw new Error(`Failed to delete integration branch: ${deleteBranchResult.stderr}`);
    }
  }
}
