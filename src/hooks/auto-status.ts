import { join } from 'path';
import { getRunningJobs } from '../lib/job-state';
import { getDataDir } from '../lib/paths';
import { isInManagedWorktree } from '../lib/worktree';

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
const LAST_STATUS_FILE = 'last-status-time';

/**
 * Check if we should show auto-status on idle
 * Guard conditions (ALL must be true):
 * 1. Not inside a job worktree (isCommandCenter)
 * 2. MC has been used (jobs.json exists)
 * 3. Running jobs > 0
 * 4. 5+ minutes since last status
 */
export async function shouldShowAutoStatus(): Promise<boolean> {
  try {
    // Guard 1: Check if we're in the command center (not in a managed worktree)
    const isCommandCenter = await checkIsCommandCenter();
    if (!isCommandCenter) {
      return false;
    }

    // Guard 2: Check if jobs.json exists (MC has been used)
    const jobsFileExists = await checkJobsFileExists();
    if (!jobsFileExists) {
      return false;
    }

    // Guard 3: Check if there are running jobs
    const runningJobs = await getRunningJobs();
    if (runningJobs.length === 0) {
      return false;
    }

    // Guard 4: Check rate limiting (5+ minutes since last status)
    const shouldRateLimit = await checkRateLimit();
    if (shouldRateLimit) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get formatted summary of running jobs
 */
export async function getAutoStatusMessage(): Promise<string> {
  try {
    const runningJobs = await getRunningJobs();

    if (runningJobs.length === 0) {
      return '';
    }

    const jobSummaries = runningJobs.map((job) => {
      const duration = calculateDuration(job.createdAt);
      return `  • ${job.name} (${job.mode}) - ${duration}`;
    });

    const message = [
      '📊 Mission Control Status',
      `Running jobs: ${runningJobs.length}`,
      ...jobSummaries,
    ].join('\n');

    // Update last status time
    await updateLastStatusTime();

    return message;
  } catch {
    return '';
  }
}

/**
 * Check if current directory is the command center (not in a managed worktree)
 */
async function checkIsCommandCenter(): Promise<boolean> {
  const cwd = process.cwd();
  const result = await isInManagedWorktree(cwd);
  return !result.isManaged;
}

/**
 * Check if jobs.json file exists
 */
async function checkJobsFileExists(): Promise<boolean> {
  try {
    const dataDir = await getDataDir();
    const jobsPath = join(dataDir, 'jobs.json');
    const file = Bun.file(jobsPath);
    return await file.exists();
  } catch {
    return false;
  }
}

/**
 * Check if we should rate limit (less than 5 minutes since last status)
 */
async function checkRateLimit(): Promise<boolean> {
  try {
    const dataDir = await getDataDir();
    const lastStatusPath = join(dataDir, LAST_STATUS_FILE);
    const file = Bun.file(lastStatusPath);
    const exists = await file.exists();

    if (!exists) {
      return false; // No previous status, don't rate limit
    }

    const content = await file.text();
    const lastStatusTime = parseInt(content, 10);

    if (isNaN(lastStatusTime)) {
      return false; // Invalid timestamp, don't rate limit
    }

    const timeSinceLastStatus = Date.now() - lastStatusTime;
    return timeSinceLastStatus < RATE_LIMIT_MS;
  } catch {
    return false; // Error reading file, don't rate limit
  }
}

/**
 * Update the last status time
 */
async function updateLastStatusTime(): Promise<void> {
  try {
    const dataDir = await getDataDir();
    const lastStatusPath = join(dataDir, LAST_STATUS_FILE);
    const timestamp = Date.now().toString();
    await Bun.write(lastStatusPath, timestamp);
  } catch {
    // Silently fail if we can't update the timestamp
  }
}

/**
 * Calculate human-readable duration from ISO timestamp
 */
function calculateDuration(createdAt: string): string {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
