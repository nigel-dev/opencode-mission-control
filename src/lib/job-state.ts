import { join } from 'path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { GitMutex } from './git-mutex';
import { isValidJobTransition, VALID_JOB_TRANSITIONS } from './plan-types';
import type { JobStatus } from './plan-types';
import { JobSchema, JobStateSchema, JOB_STATE_VERSION } from './schemas';
import { atomicWrite, readFileIfExists } from './utils';

export type Job = z.infer<typeof JobSchema>;
export type JobState = z.infer<typeof JobStateSchema>;

/**
 * Bring a state file written by an older release up to the current version.
 *
 * Versions 1-3 hosted every job in tmux (optionally with a per-job
 * `opencode serve`). Those hosts no longer exist, so jobs that were `running`
 * cannot be resumed: they become `stopped`. Everything else is kept so
 * `mc_cleanup` can still remove their worktrees and branches. Fields that no
 * longer exist (tmuxTarget, placement, mode, planFile, port, serverUrl,
 * serverPassword, exitCode, remoteSessionID) are dropped by the schema, which
 * strips unknown keys. A legacy `remoteSessionID` is deliberately not carried
 * over as `sessionID`: it named a session on a per-job server that is gone.
 */
export function migrateJobState(state: Record<string, unknown>): JobState {
  const version = typeof state.version === 'number' ? state.version : 1;

  if (version >= JOB_STATE_VERSION) {
    return JobStateSchema.parse(state);
  }

  const now = new Date().toISOString();
  const rawJobs: unknown[] = Array.isArray(state.jobs) ? state.jobs : [];
  const jobs = rawJobs.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      return raw;
    }
    const job = raw as Record<string, unknown>;
    if (job.status !== 'running') {
      return job;
    }
    return {
      ...job,
      status: 'stopped',
      completedAt: typeof job.completedAt === 'string' ? job.completedAt : now,
    };
  });

  return JobStateSchema.parse({
    version: JOB_STATE_VERSION,
    jobs,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : now,
  });
}

const STATE_FILE = 'jobs.json';

/**
 * Serializes read-modify-write cycles on jobs.json. Every writer is in this
 * one process: the plugin instances of all projects and of all job worktrees
 * are loaded into the same OpenCode server and share this module, so an
 * in-process mutex covers them all. (It is shared between projects too, which
 * only costs a little waiting: each cycle is a small file read and write.)
 */
const stateMutex = new GitMutex();

async function getStateFilePath(cwd?: string): Promise<string> {
  const dataDir = await getDataDir(cwd);
  return join(dataDir, STATE_FILE);
}



export async function loadJobState(cwd?: string): Promise<JobState> {
  const filePath = await getStateFilePath(cwd);
  const content = readFileIfExists(filePath);
  if (content === null) {
    return {
      version: JOB_STATE_VERSION,
      jobs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(content);
    if (!parsed.version || parsed.version < JOB_STATE_VERSION) {
      return migrateJobState(parsed);
    }
    return JobStateSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid job state in ${filePath}: ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw new Error(`Failed to load job state from ${filePath}: ${error}`);
  }
}

export async function saveJobState(state: JobState): Promise<void> {
  const filePath = await getStateFilePath();
  const updatedState: JobState = {
    ...state,
    version: JOB_STATE_VERSION,
    updatedAt: new Date().toISOString(),
  };

  try {
    const data = JSON.stringify(updatedState, null, 2);
    await atomicWrite(filePath, data);
  } catch (error) {
    throw new Error(`Failed to save job state to ${filePath}: ${error}`);
  }
}

export async function addJob(job: Job): Promise<void> {
  await stateMutex.withLock(async () => {
    const state = await loadJobState();
    state.jobs.push(job);
    await saveJobState(state);
  });
}

export async function updateJob(
  id: string,
  updates: Partial<Job>
): Promise<void> {
  await stateMutex.withLock(async () => {
    const state = await loadJobState();
    const jobIndex = state.jobs.findIndex((j) => j.id === id);

    if (jobIndex === -1) {
      throw new Error(`Job with id ${id} not found`);
    }

    const job = state.jobs[jobIndex];
    if (updates.status && job.status !== updates.status) {
      const fromStatus = job.status as string;
      const toStatus = updates.status as string;
      if (fromStatus in VALID_JOB_TRANSITIONS && toStatus in VALID_JOB_TRANSITIONS) {
        if (!isValidJobTransition(fromStatus as JobStatus, toStatus as JobStatus)) {
          console.warn(`[MC] Invalid job transition: ${fromStatus} → ${toStatus} (job: ${job.name})`);
        }
      }
    }

    state.jobs[jobIndex] = {
      ...state.jobs[jobIndex],
      ...updates,
    };

    await saveJobState(state);
  });
}

export async function removeJob(id: string): Promise<void> {
  await stateMutex.withLock(async () => {
    const state = await loadJobState();
    const initialLength = state.jobs.length;
    state.jobs = state.jobs.filter((j) => j.id !== id);

    if (state.jobs.length === initialLength) {
      throw new Error(`Job with id ${id} not found`);
    }

    await saveJobState(state);
  });
}

export async function getJob(id: string): Promise<Job | undefined> {
  const state = await loadJobState();
  return state.jobs.find((j) => j.id === id);
}

export async function getJobByName(name: string): Promise<Job | undefined> {
  const state = await loadJobState();
  return state.jobs.find((j) => j.name === name);
}

export async function getRunningJobs(): Promise<Job[]> {
  const state = await loadJobState();
  return state.jobs.filter((j) => j.status === 'running');
}
