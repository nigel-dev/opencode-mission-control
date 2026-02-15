import { describe, it, expect } from 'bun:test';
import {
  VALID_PLAN_TRANSITIONS,
  VALID_JOB_TRANSITIONS,
  isValidPlanTransition,
  isValidJobTransition,
  type PlanStatus,
  type JobStatus,
} from '../../src/lib/plan-types';
import { migrateJobState } from '../../src/lib/job-state';

const ALL_PLAN_STATUSES: PlanStatus[] = [
  'pending',
  'running',
  'paused',
  'merging',
  'creating_pr',
  'completed',
  'failed',
  'canceled',
];

const ALL_JOB_STATUSES: JobStatus[] = [
  'queued',
  'waiting_deps',
  'running',
  'completed',
  'failed',
  'ready_to_merge',
  'merging',
  'merged',
  'conflict',
  'needs_rebase',
  'stopped',
  'canceled',
];

describe('plan-types', () => {
  describe('VALID_PLAN_TRANSITIONS', () => {
    it('should have an entry for every PlanStatus', () => {
      for (const status of ALL_PLAN_STATUSES) {
        expect(VALID_PLAN_TRANSITIONS[status]).toBeDefined();
        expect(Array.isArray(VALID_PLAN_TRANSITIONS[status])).toBe(true);
      }
    });

    it('every PlanStatus should be reachable (has at least one transition TO it)', () => {
      const reachable = new Set<PlanStatus>();
      for (const targets of Object.values(VALID_PLAN_TRANSITIONS)) {
        for (const target of targets) {
          reachable.add(target);
        }
      }

      // 'pending' is the initial state — nothing transitions TO it
      for (const status of ALL_PLAN_STATUSES) {
        if (status === 'pending') continue;
        expect(reachable.has(status)).toBe(true);
      }
    });

    it('every non-terminal PlanStatus should have at least one transition FROM it', () => {
      for (const status of ALL_PLAN_STATUSES) {
        if (status === 'completed' || status === 'failed' || status === 'canceled') {
          expect(VALID_PLAN_TRANSITIONS[status]).toEqual([]);
        } else {
          expect(VALID_PLAN_TRANSITIONS[status].length).toBeGreaterThan(0);
        }
      }
    });

    it('should only contain valid PlanStatus values in targets', () => {
      const validSet = new Set<string>(ALL_PLAN_STATUSES);
      for (const [from, targets] of Object.entries(VALID_PLAN_TRANSITIONS)) {
        expect(validSet.has(from)).toBe(true);
        for (const target of targets) {
          expect(validSet.has(target)).toBe(true);
        }
      }
    });

    it('terminal states should have no outgoing transitions', () => {
      expect(VALID_PLAN_TRANSITIONS.completed).toEqual([]);
      expect(VALID_PLAN_TRANSITIONS.failed).toEqual([]);
      expect(VALID_PLAN_TRANSITIONS.canceled).toEqual([]);
    });

    it('should follow the expected happy path: pending -> running -> merging -> creating_pr -> completed', () => {
      expect(isValidPlanTransition('pending', 'running')).toBe(true);
      expect(isValidPlanTransition('running', 'merging')).toBe(true);
      expect(isValidPlanTransition('merging', 'creating_pr')).toBe(true);
      expect(isValidPlanTransition('creating_pr', 'completed')).toBe(true);
    });

    it('every non-terminal state should allow transition to failed and canceled', () => {
      const nonTerminal: PlanStatus[] = ['pending', 'running', 'paused', 'merging', 'creating_pr'];
      for (const status of nonTerminal) {
        expect(VALID_PLAN_TRANSITIONS[status]).toContain('failed');
        expect(VALID_PLAN_TRANSITIONS[status]).toContain('canceled');
      }
    });
  });

  describe('VALID_JOB_TRANSITIONS', () => {
    it('should have an entry for every JobStatus', () => {
      for (const status of ALL_JOB_STATUSES) {
        expect(VALID_JOB_TRANSITIONS[status]).toBeDefined();
        expect(Array.isArray(VALID_JOB_TRANSITIONS[status])).toBe(true);
      }
    });

    it('every JobStatus should be reachable (has at least one transition TO it)', () => {
      const reachable = new Set<JobStatus>();
      for (const targets of Object.values(VALID_JOB_TRANSITIONS)) {
        for (const target of targets) {
          reachable.add(target);
        }
      }

      // 'queued' is the initial state — nothing transitions TO it
      for (const status of ALL_JOB_STATUSES) {
        if (status === 'queued') continue;
        expect(reachable.has(status)).toBe(true);
      }
    });

    it('every non-terminal JobStatus should have at least one transition FROM it', () => {
      for (const status of ALL_JOB_STATUSES) {
        if (status === 'stopped' || status === 'canceled') {
          expect(VALID_JOB_TRANSITIONS[status]).toEqual([]);
        } else {
          expect(VALID_JOB_TRANSITIONS[status].length).toBeGreaterThan(0);
        }
      }
    });

    it('should only contain valid JobStatus values in targets', () => {
      const validSet = new Set<string>(ALL_JOB_STATUSES);
      for (const [from, targets] of Object.entries(VALID_JOB_TRANSITIONS)) {
        expect(validSet.has(from)).toBe(true);
        for (const target of targets) {
          expect(validSet.has(target)).toBe(true);
        }
      }
    });

    it('terminal states should have no outgoing transitions', () => {
      expect(VALID_JOB_TRANSITIONS.stopped).toEqual([]);
      expect(VALID_JOB_TRANSITIONS.canceled).toEqual([]);
    });

    it('should follow the expected happy path: queued -> running -> completed -> ready_to_merge -> merging -> merged', () => {
      expect(isValidJobTransition('queued', 'running')).toBe(true);
      expect(isValidJobTransition('running', 'completed')).toBe(true);
      expect(isValidJobTransition('completed', 'ready_to_merge')).toBe(true);
      expect(isValidJobTransition('ready_to_merge', 'merging')).toBe(true);
      expect(isValidJobTransition('merging', 'merged')).toBe(true);
    });

    it('should support dependency waiting path: queued -> waiting_deps -> running', () => {
      expect(isValidJobTransition('queued', 'waiting_deps')).toBe(true);
      expect(isValidJobTransition('waiting_deps', 'running')).toBe(true);
    });

    it('should support conflict recovery: merging -> conflict -> ready_to_merge', () => {
      expect(isValidJobTransition('merging', 'conflict')).toBe(true);
      expect(isValidJobTransition('conflict', 'ready_to_merge')).toBe(true);
    });

    it('should support rebase cycle: merged -> needs_rebase -> ready_to_merge', () => {
      expect(isValidJobTransition('merged', 'needs_rebase')).toBe(true);
      expect(isValidJobTransition('needs_rebase', 'ready_to_merge')).toBe(true);
    });

    it('should support failed job retry: failed -> ready_to_merge', () => {
      expect(isValidJobTransition('failed', 'ready_to_merge')).toBe(true);
    });
  });

  describe('isValidPlanTransition', () => {
    it('should return true for valid transitions', () => {
      expect(isValidPlanTransition('pending', 'running')).toBe(true);
      expect(isValidPlanTransition('running', 'failed')).toBe(true);
    });

    it('should return false for invalid transitions', () => {
      expect(isValidPlanTransition('pending', 'completed')).toBe(false);
      expect(isValidPlanTransition('completed', 'running')).toBe(false);
      expect(isValidPlanTransition('failed', 'running')).toBe(false);
    });

    it('should return false for self-transitions', () => {
      for (const status of ALL_PLAN_STATUSES) {
        expect(isValidPlanTransition(status, status)).toBe(false);
      }
    });
  });

  describe('isValidJobTransition', () => {
    it('should return true for valid transitions', () => {
      expect(isValidJobTransition('queued', 'running')).toBe(true);
      expect(isValidJobTransition('running', 'failed')).toBe(true);
    });

    it('should return false for invalid transitions', () => {
      expect(isValidJobTransition('queued', 'merged')).toBe(false);
      expect(isValidJobTransition('merged', 'running')).toBe(false);
      expect(isValidJobTransition('stopped', 'running')).toBe(false);
    });

    it('should return false for self-transitions', () => {
      for (const status of ALL_JOB_STATUSES) {
        expect(isValidJobTransition(status, status)).toBe(false);
      }
    });
  });

  describe('migrateJobState', () => {
    it('should migrate v1 state to v3', () => {
      const v1State = {
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'Test',
            worktreePath: '/path',
            branch: 'main',
            tmuxTarget: 'mc-test',
            placement: 'session',
            status: 'running',
            prompt: 'do stuff',
            mode: 'vanilla',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const migrated = migrateJobState(v1State);

      expect(migrated.version).toBe(3);
      expect(migrated.jobs).toHaveLength(1);
      expect(migrated.jobs[0].planId).toBeUndefined();
      expect(migrated.jobs[0].launchSessionID).toBeUndefined();
      expect(migrated.jobs[0].id).toBe('job-1');
    });

    it('should handle missing version as v1', () => {
      const noVersionState = {
        jobs: [
          {
            id: 'job-1',
            name: 'Test',
            worktreePath: '/path',
            branch: 'main',
            tmuxTarget: 'mc-test',
            placement: 'session',
            status: 'running',
            prompt: 'do stuff',
            mode: 'vanilla',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const migrated = migrateJobState(noVersionState);

      expect(migrated.version).toBe(3);
      expect(migrated.jobs).toHaveLength(1);
    });

    it('should migrate v2 state to v3', () => {
      const v2State = {
        version: 2,
        jobs: [
          {
            id: 'job-1',
            name: 'Test',
            worktreePath: '/path',
            branch: 'main',
            tmuxTarget: 'mc-test',
            placement: 'session',
            status: 'running',
            prompt: 'do stuff',
            mode: 'vanilla',
            createdAt: '2024-01-01T00:00:00Z',
            planId: 'plan-1',
          },
        ],
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const migrated = migrateJobState(v2State);

      expect(migrated.version).toBe(3);
      expect(migrated.jobs[0].planId).toBe('plan-1');
      expect(migrated.jobs[0].launchSessionID).toBeUndefined();
    });

    it('should handle empty jobs array', () => {
      const emptyState = { version: 1, jobs: [], updatedAt: '2024-01-01T00:00:00Z' };
      const migrated = migrateJobState(emptyState);

      expect(migrated.version).toBe(3);
      expect(migrated.jobs).toEqual([]);
    });

    it('should generate updatedAt when missing', () => {
      const noTimestamp = { jobs: [] };
      const migrated = migrateJobState(noTimestamp);

      expect(migrated.version).toBe(3);
      expect(migrated.updatedAt).toBeDefined();
    });
  });
});
