import { join } from 'path';
import { getDataDir } from './paths';

export interface Job {
  id: string;
  name: string;
  worktreePath: string;
  branch: string;
  tmuxTarget: string;
  placement: 'session' | 'window';
  status: 'running' | 'completed' | 'failed' | 'stopped';
  prompt: string;
  mode: 'vanilla' | 'plan' | 'ralph' | 'ulw';
  planFile?: string;
  createdAt: string;
  completedAt?: string;
  exitCode?: number;
}

export interface JobState {
  version: 1;
  jobs: Job[];
  updatedAt: string;
}

const STATE_FILE = 'jobs.json';

async function getStateFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, STATE_FILE);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await Bun.write(tempPath, data);
  // Use fs.renameSync for atomic rename operation
  const fs = await import('fs');
  fs.renameSync(tempPath, filePath);
}

export async function loadJobState(): Promise<JobState> {
  const filePath = await getStateFilePath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {
      version: 1,
      jobs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const content = await file.text();
    return JSON.parse(content) as JobState;
  } catch (error) {
    throw new Error(`Failed to load job state from ${filePath}: ${error}`);
  }
}

export async function saveJobState(state: JobState): Promise<void> {
  const filePath = await getStateFilePath();
  const updatedState: JobState = {
    ...state,
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
  const state = await loadJobState();
  state.jobs.push(job);
  await saveJobState(state);
}

export async function updateJob(
  id: string,
  updates: Partial<Job>
): Promise<void> {
  const state = await loadJobState();
  const jobIndex = state.jobs.findIndex((j) => j.id === id);

  if (jobIndex === -1) {
    throw new Error(`Job with id ${id} not found`);
  }

  state.jobs[jobIndex] = {
    ...state.jobs[jobIndex],
    ...updates,
  };

  await saveJobState(state);
}

export async function removeJob(id: string): Promise<void> {
  const state = await loadJobState();
  const initialLength = state.jobs.length;
  state.jobs = state.jobs.filter((j) => j.id !== id);

  if (state.jobs.length === initialLength) {
    throw new Error(`Job with id ${id} not found`);
  }

  await saveJobState(state);
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
