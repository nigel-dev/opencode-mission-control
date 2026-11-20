import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as reports from '../../src/lib/reports';
import {
  addPendingQuestion,
  clearPendingQuestionsForJob,
} from '../../src/lib/question-relay';

const { mc_answer } = await import('../../src/tools/answer');

let mockGetJobByName: MockInstance;
let mockPromptJobSession: MockInstance;
let mockWriteReport: MockInstance;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'my-job',
    worktreePath: '/tmp/worktree',
    branch: 'mc/my-job',
    status: 'running',
    prompt: 'Do the thing',
    createdAt: new Date().toISOString(),
    sessionID: 'ses_job1',
    ...overrides,
  };
}

describe('mc_answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockResolvedValue(makeJob());
    mockPromptJobSession = vi.spyOn(jobRuntime, 'promptJobSession').mockResolvedValue(undefined);
    mockWriteReport = vi.spyOn(reports, 'writeReport').mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearPendingQuestionsForJob('job-1');
    vi.restoreAllMocks();
  });

  it("delivers the answer to the job's session", async () => {
    const result = await mc_answer.execute({ name: 'my-job', response: 'Use Postgres' });

    expect(mockPromptJobSession).toHaveBeenCalledWith('ses_job1', 'Use Postgres');
    expect(result.content).toContain('my-job');
  });

  it('supersedes a blocked report only after the answer was delivered', async () => {
    const order: string[] = [];
    mockWriteReport.mockImplementation(async () => { order.push('report'); });
    mockPromptJobSession.mockImplementation(async () => { order.push('prompt'); });

    await mc_answer.execute({ name: 'my-job', response: 'Go ahead' });

    // Report first would leave an idle job without its "blocked" report for a
    // moment, which the monitor takes for a finished job.
    expect(order).toEqual(['prompt', 'report']);
    expect(mockWriteReport).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', jobName: 'my-job', status: 'working' }),
    );
  });

  it('keeps the blocked report when the answer cannot be delivered', async () => {
    mockPromptJobSession.mockRejectedValue(new Error('server unavailable'));

    await expect(mc_answer.execute({ name: 'my-job', response: 'Go ahead' })).rejects.toThrow('server unavailable');

    expect(mockWriteReport).not.toHaveBeenCalled();
  });

  it('rejects an unknown job', async () => {
    mockGetJobByName.mockResolvedValue(undefined);

    await expect(mc_answer.execute({ name: 'nope', response: 'x' })).rejects.toThrow('not found');
    expect(mockPromptJobSession).not.toHaveBeenCalled();
  });

  it('rejects a job that is not running', async () => {
    mockGetJobByName.mockResolvedValue(makeJob({ status: 'completed' }));

    await expect(mc_answer.execute({ name: 'my-job', response: 'x' })).rejects.toThrow('not running');
    expect(mockPromptJobSession).not.toHaveBeenCalled();
  });

  it('rejects a job without a session', async () => {
    mockGetJobByName.mockResolvedValue(makeJob({ sessionID: undefined }));

    await expect(mc_answer.execute({ name: 'my-job', response: 'x' })).rejects.toThrow('no session');
  });

  it('points at mc_attach when the job waits on an interactive question form', async () => {
    addPendingQuestion({
      jobId: 'job-1',
      jobName: 'my-job',
      taskSummary: 'Do the thing',
      partId: 'tool-1',
      callID: 'tool-1',
      sessionID: 'ses_job1',
      question: 'Which database?',
      options: [],
      detectedAt: Date.now(),
    });

    await expect(mc_answer.execute({ name: 'my-job', response: 'Postgres' })).rejects.toThrow('mc_attach');
    expect(mockPromptJobSession).not.toHaveBeenCalled();
    expect(mockWriteReport).not.toHaveBeenCalled();
  });
});
