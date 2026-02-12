import { join } from 'path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { GitMutex } from './git-mutex';
import { isValidJobTransition, VALID_JOB_TRANSITIONS } from './plan-types';
import type { JobStatus } from './plan-types';
import { JobSchema, JobStateSchema } from './schemas';
import { atomicWrite } from './utils';

export type Job = z.infer<typeof JobSchema>;
export type JobState = z.infer<typeof JobStateSchema>;

export function migrateJobState(state: Record<string, unknown>): JobState {
  const version = (state.version as number) ?? 1;

  if (version < 2) {
    const jobs = (state.jobs as Job[]) ?? [];
    const migrated = {
      version: 2 as const,
      jobs: jobs.map((job) => ({ ...job, planId: job.planId ?? undefined })),
      updatedAt: (state.updatedAt as string) ?? new Date().toISOString(),
    };
    return JobStateSchema.parse(migrated);
  }

  return JobStateSchema.parse(state);
}

const STATE_FILE = 'jobs.json';

/**
 * In-process mutex for serializing job state operations.
 * Prevents concurrent read-modify-write cycles from losing updates
 * within the same process.
 *
 * LIMITATION: This mutex only protects within a single process.
 * If multiple processes (e.g., mc_plan_cancel and mc_cleanup from
 * different sessions) access jobs.json concurrently, they each have
 * their own mutex instance and can race. The atomicWrite with
 * renameSync makes individual writes atomic, but the full
 * read-modify-write cycle is unprotected across processes.
 *
 * In practice, this manifests as a brief window where mc_jobs may
 * show a stale entry immediately after mc_cleanup completes.
 * A subsequent mc_jobs call will show the correct state.
 * See: E2E_TEST_FINDINGS.md, FINDING 1.
 */
const stateMutex = new GitMutex();

async function getStateFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, STATE_FILE);
}



export async function loadJobState(): Promise<JobState> {
  const filePath = await getStateFilePath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {
      version: 2,
      jobs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    if (!parsed.version || parsed.version < 2) {
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
    version: 2,
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
