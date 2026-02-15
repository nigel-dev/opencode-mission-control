import { join } from 'path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { GitMutex } from './git-mutex';
import type { PlanSpec, JobSpec, CheckpointContext } from './plan-types';
import { isValidPlanTransition, isValidJobTransition } from './plan-types';
import { PlanSpecSchema } from './schemas';
import { atomicWrite } from './utils';

const PLAN_FILE = 'plan.json';

const planMutex = new GitMutex();

async function getPlanFilePath(): Promise<string> {
  const dataDir = await getDataDir();
  return join(dataDir, PLAN_FILE);
}



export async function loadPlan(): Promise<PlanSpec | null> {
  const filePath = await getPlanFilePath();
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return null;
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    return PlanSpecSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid plan state in ${filePath}: ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw new Error(`Failed to load plan state from ${filePath}: ${error}`);
  }
}

export async function savePlan(plan: PlanSpec): Promise<void> {
  await planMutex.withLock(async () => {
    const existing = await loadPlan();

    if (existing && existing.id !== plan.id) {
      throw new Error('active plan already exists');
    }

    if (existing && existing.status !== plan.status) {
      if (!isValidPlanTransition(existing.status, plan.status)) {
        console.warn(`[MC] Invalid plan transition: ${existing.status} → ${plan.status} (plan: ${plan.name})`);
      }
    }

    const ghAuthenticated = await validateGhAuth();
    const planToSave = { ...plan, ghAuthenticated };

    const filePath = await getPlanFilePath();
    try {
      const data = JSON.stringify(planToSave, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  });
}

export async function getActivePlan(): Promise<PlanSpec | null> {
  return loadPlan();
}

export async function updatePlanJob(
  planId: string,
  jobName: string,
  updates: Partial<JobSpec>,
): Promise<void> {
  await planMutex.withLock(async () => {
    const plan = await loadPlan();

    if (!plan) {
      throw new Error('No active plan exists');
    }

    if (plan.id !== planId) {
      throw new Error(
        `Plan ID mismatch: expected ${planId}, got ${plan.id}`,
      );
    }

    const jobIndex = plan.jobs.findIndex((j) => j.name === jobName);
    if (jobIndex === -1) {
      throw new Error(`Job "${jobName}" not found in plan "${plan.name}"`);
    }

    if (updates.status && updates.status !== plan.jobs[jobIndex].status) {
      if (!isValidJobTransition(plan.jobs[jobIndex].status, updates.status)) {
        console.warn(`[MC] Invalid job transition: ${plan.jobs[jobIndex].status} → ${updates.status} (job: ${jobName})`);
      }
    }

    plan.jobs[jobIndex] = {
      ...plan.jobs[jobIndex],
      ...updates,
    };

    const filePath = await getPlanFilePath();
    try {
      const data = JSON.stringify(plan, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  });
}

export interface PlanFieldUpdates {
  status?: PlanSpec['status'];
  checkpoint?: PlanSpec['checkpoint'];
  checkpointContext?: CheckpointContext | null;
  completedAt?: string;
  prUrl?: string;
  auditLog?: PlanSpec['auditLog'];
}

/**
 * Atomically update plan-level fields without overwriting job states.
 *
 * Unlike savePlan(), this reads the current plan inside the mutex and merges
 * only the specified fields. This prevents a stale plan snapshot from clobbering
 * concurrent updatePlanJob() writes — the root cause of completed jobs appearing
 * as "running" after a sibling job failed (see #63).
 */
export async function updatePlanFields(
  planId: string,
  updates: PlanFieldUpdates,
): Promise<void> {
  await planMutex.withLock(async () => {
    const plan = await loadPlan();

    if (!plan) {
      throw new Error('No active plan exists');
    }

    if (plan.id !== planId) {
      throw new Error(
        `Plan ID mismatch: expected ${planId}, got ${plan.id}`,
      );
    }

    if (updates.status !== undefined && updates.status !== plan.status) {
      if (!isValidPlanTransition(plan.status, updates.status)) {
        console.warn(`[MC] Invalid plan transition: ${plan.status} → ${updates.status} (plan: ${plan.name})`);
      }
      plan.status = updates.status;
    }
    if (updates.checkpoint !== undefined) {
      plan.checkpoint = updates.checkpoint;
    }
    if (updates.checkpointContext !== undefined) {
      plan.checkpointContext = updates.checkpointContext;
    }
    if (updates.completedAt !== undefined) {
      plan.completedAt = updates.completedAt;
    }
    if (updates.prUrl !== undefined) {
      plan.prUrl = updates.prUrl;
    }

    const ghAuthenticated = await validateGhAuth();
    const planToSave = { ...plan, ghAuthenticated };

    const filePath = await getPlanFilePath();
    try {
      const data = JSON.stringify(planToSave, null, 2);
      await atomicWrite(filePath, data);
    } catch (error) {
      throw new Error(`Failed to save plan state to ${filePath}: ${error}`);
    }
  });
}

export async function clearPlan(): Promise<void> {
  await planMutex.withLock(async () => {
    const filePath = await getPlanFilePath();
    const fs = await import('fs');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
}

export async function validateGhAuth(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['gh', 'auth', 'status'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
