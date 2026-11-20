import { describe, it, expect } from 'vitest';
import type { FormField, FormInfo } from '@opencode/client';
import type { JobView, PlanView } from '../../src/rpc';
import {
  answerableFields,
  attentionSound,
  attentionToast,
  buildFormReply,
  capJobs,
  clampIndex,
  errorText,
  firstLine,
  footerSegments,
  footerSummary,
  formatDuration,
  formFieldPrompt,
  isPlanActive,
  jobDetail,
  jobDetailRows,
  jobElapsed,
  jobIcon,
  jobLabel,
  jobTone,
  moveIndex,
  parseAttention,
  parseOpen,
  planJobIcon,
  planJobLine,
  planJobTone,
  planProgress,
  planSummary,
  sameLocation,
  sortJobs,
  toastFromEvent,
  truncate,
  validateJobName,
} from '../../src/tui/format';

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    name: 'alpha',
    status: 'running',
    attention: 'none',
    branch: 'mc/alpha',
    worktreePath: '/tmp/wt/alpha',
    createdAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function plan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    id: 'plan-1',
    name: 'Release',
    mode: 'supervisor',
    status: 'running',
    jobs: [
      { name: 'a', status: 'merged', dependsOn: [] },
      { name: 'b', status: 'running', dependsOn: ['a'] },
      { name: 'c', status: 'queued', dependsOn: ['a', 'b'] },
    ],
    ...overrides,
  };
}

describe('job status presentation', () => {
  it('selects an icon, label and tone per status', () => {
    expect([jobIcon(job()), jobLabel(job()), jobTone(job())]).toEqual(['▶', 'running', 'info']);
    const completed = job({ status: 'completed' });
    expect([jobIcon(completed), jobLabel(completed), jobTone(completed)]).toEqual(['✓', 'completed', 'success']);
    const failed = job({ status: 'failed' });
    expect([jobIcon(failed), jobLabel(failed), jobTone(failed)]).toEqual(['✗', 'failed', 'error']);
    const stopped = job({ status: 'stopped' });
    expect([jobIcon(stopped), jobLabel(stopped), jobTone(stopped)]).toEqual(['■', 'stopped', 'muted']);
  });

  it('lets attention override the status', () => {
    const blocked = job({ attention: 'blocked' });
    expect([jobIcon(blocked), jobLabel(blocked), jobTone(blocked)]).toEqual(['⚠', 'blocked', 'warning']);
    const review = job({ status: 'completed', attention: 'needs_review' });
    expect([jobIcon(review), jobLabel(review), jobTone(review)]).toEqual(['⚠', 'needs review', 'warning']);
    const question = job({ attention: 'question' });
    expect([jobIcon(question), jobLabel(question), jobTone(question)]).toEqual(['?', 'question', 'warning']);
  });
});

describe('sortJobs', () => {
  it('orders running, then needing attention, then finished newest first', () => {
    const sorted = sortJobs([
      job({ name: 'old-done', status: 'completed', completedAt: '2026-11-16T10:30:00.000Z' }),
      job({ name: 'blocked', attention: 'blocked' }),
      job({ name: 'new-failed', status: 'failed', completedAt: '2026-11-16T11:30:00.000Z' }),
      job({ name: 'running-old', createdAt: '2026-11-16T09:00:00.000Z' }),
      job({ name: 'running-new', createdAt: '2026-11-16T10:00:00.000Z' }),
      job({ name: 'review', status: 'completed', attention: 'needs_review' }),
    ]);

    expect(sorted.map((entry) => entry.name)).toEqual([
      'running-new',
      'running-old',
      'blocked',
      'review',
      'new-failed',
      'old-done',
    ]);
  });

  it('does not mutate its input and breaks ties by name', () => {
    const input = [job({ name: 'b' }), job({ name: 'a' })];
    expect(sortJobs(input).map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(input.map((entry) => entry.name)).toEqual(['b', 'a']);
  });
});

describe('capJobs', () => {
  it('caps the list and counts the rest', () => {
    const jobs = Array.from({ length: 9 }, (_, index) => job({ id: `j${index}`, name: `job-${index}` }));
    const capped = capJobs(jobs, 6);
    expect(capped.visible).toHaveLength(6);
    expect(capped.hidden).toBe(3);
  });

  it('hides nothing when the list fits', () => {
    expect(capJobs([job()], 6)).toMatchObject({ hidden: 0 });
    expect(capJobs([], 6)).toEqual({ visible: [], hidden: 0 });
  });
});

describe('jobDetail', () => {
  it('shows the current tool and file for a running job', () => {
    expect(
      jobDetail(job({ activity: { currentTool: 'edit', currentFile: '/tmp/wt/alpha/src/app.ts', filesEdited: 1 } })),
    ).toBe('edit app.ts');
    expect(jobDetail(job({ activity: { currentTool: 'bash', filesEdited: 0 } }))).toBe('bash');
  });

  it('falls back to the report message for a running job without activity', () => {
    expect(jobDetail(job({ report: { status: 'progress', message: 'Halfway' } }))).toBe('Halfway');
    expect(jobDetail(job())).toBe('');
  });

  it('shows the report message for a job needing attention', () => {
    expect(
      jobDetail(
        job({
          attention: 'blocked',
          report: { status: 'blocked', message: 'Need an API key' },
          activity: { currentTool: 'edit', filesEdited: 2 },
        }),
      ),
    ).toBe('Need an API key');
    expect(jobDetail(job({ attention: 'question' }))).toBe('waiting for an answer');
  });

  it('shows the note of a finished job: why it failed, or what it left uncommitted', () => {
    expect(jobDetail(job({ status: 'failed', note: 'its session was deleted' }))).toBe('its session was deleted');
    expect(
      jobDetail(
        job({
          status: 'completed',
          attention: 'needs_review',
          note: '2 uncommitted file(s) in its worktree are not on its branch',
          report: { status: 'completed', message: 'Done' },
        }),
      ),
    ).toBe('2 uncommitted file(s) in its worktree are not on its branch');
    expect(jobDetailRows(job({ status: 'failed', note: 'its session was deleted' }), 0)).toContainEqual({
      label: 'Note',
      value: 'its session was deleted',
    });
  });

  it('is empty for a finished job', () => {
    expect(jobDetail(job({ status: 'completed', report: { status: 'completed', message: 'Done' } }))).toBe('');
  });
});

describe('text helpers', () => {
  it('truncates with an ellipsis and collapses whitespace', () => {
    expect(truncate('hello world', 20)).toBe('hello world');
    expect(truncate('hello   \n world', 20)).toBe('hello world');
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('hello', 0)).toBe('');
  });

  it('formats durations', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(125_000)).toBe('2m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(-10)).toBe('0s');
  });

  it('measures elapsed time to now or to completion', () => {
    const now = Date.parse('2026-11-16T10:10:00.000Z');
    expect(jobElapsed(job(), now)).toBe('10m');
    expect(jobElapsed(job({ completedAt: '2026-11-16T10:02:00.000Z' }), now)).toBe('2m');
    expect(jobElapsed(job({ createdAt: 'not a date' }), now)).toBe('');
  });

  it('takes the first non-empty line', () => {
    expect(firstLine('\n  Job "a" stopped.\n\n  ID: 1')).toBe('Job "a" stopped.');
    expect(firstLine('')).toBe('');
  });

  it('extracts an error message', () => {
    expect(errorText({ type: 'failed', message: 'generic', data: { message: 'Job not found' } })).toBe(
      'Job not found',
    );
    expect(errorText({ type: 'rpc.unavailable', message: 'RPC unavailable' })).toBe('RPC unavailable');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('text')).toBe('text');
    expect(errorText(undefined)).toBe('Unknown error');
  });

  it('validates job names', () => {
    expect(validateJobName('fix-login_2.0')).toBeUndefined();
    expect(validateJobName('   ')).toBe('A job name is required.');
    expect(validateJobName('has space')).toBeDefined();
    expect(validateJobName('-leading')).toBeDefined();
  });
});

describe('jobDetailRows', () => {
  it('lists every known detail', () => {
    const now = Date.parse('2026-11-16T10:05:00.000Z');
    const rows = jobDetailRows(
      job({
        sessionID: 'ses_1',
        agent: 'build',
        model: 'anthropic/claude',
        planId: 'plan-1',
        report: { status: 'progress', message: 'Halfway', progress: 50 },
        activity: { currentTool: 'edit', currentFile: 'src/a.ts', filesEdited: 1 },
      }),
      now,
    );

    expect(rows).toEqual([
      { label: 'Status', value: 'running (5m)' },
      { label: 'Branch', value: 'mc/alpha' },
      { label: 'Worktree', value: '/tmp/wt/alpha' },
      { label: 'Session', value: 'ses_1' },
      { label: 'Agent', value: 'build' },
      { label: 'Model', value: 'anthropic/claude' },
      { label: 'Plan', value: 'plan-1' },
      { label: 'Report', value: '[progress] (50%) Halfway' },
      { label: 'Activity', value: 'edit · src/a.ts · 1 file edited' },
    ]);
  });

  it('omits what is unknown', () => {
    expect(jobDetailRows(job(), Date.parse('2026-11-16T10:00:30.000Z')).map((row) => row.label)).toEqual([
      'Status',
      'Branch',
      'Worktree',
    ]);
  });
});

describe('footer', () => {
  it('summarizes the counts', () => {
    expect(footerSummary({ running: 3, blocked: 1, completed: 5, failed: 1, stopped: 0 })).toBe(
      'MC ▶3 ⚠1 ✓5 ✗1',
    );
    expect(footerSummary({ running: 0, blocked: 0, completed: 0, failed: 0, stopped: 2 })).toBe('MC ■2');
  });

  it('is hidden when there are no jobs or no snapshot', () => {
    expect(footerSummary({ running: 0, blocked: 0, completed: 0, failed: 0, stopped: 0 })).toBe('');
    expect(footerSummary(undefined)).toBe('');
    expect(footerSegments(undefined)).toEqual([]);
  });

  it('gives each segment a tone', () => {
    expect(footerSegments({ running: 1, blocked: 1, completed: 1, failed: 1, stopped: 1 })).toEqual([
      { text: '▶1', tone: 'info' },
      { text: '⚠1', tone: 'warning' },
      { text: '✓1', tone: 'success' },
      { text: '✗1', tone: 'error' },
      { text: '■1', tone: 'muted' },
    ]);
  });
});

describe('plan', () => {
  it('computes merged/total progress', () => {
    expect(planProgress(plan())).toEqual({ merged: 1, total: 3 });
    expect(planProgress(plan({ jobs: [] }))).toEqual({ merged: 0, total: 0 });
  });

  it('summarizes the plan, preferring a checkpoint over the status', () => {
    expect(planSummary(plan())).toBe('Release · running · 1/3 merged');
    expect(planSummary(plan({ status: 'paused', checkpoint: 'pre_merge' }))).toBe(
      'Release · checkpoint pre_merge · 1/3 merged',
    );
  });

  it('knows which plans are active', () => {
    expect(isPlanActive(plan())).toBe(true);
    expect(isPlanActive(plan({ status: 'paused' }))).toBe(true);
    expect(isPlanActive(plan({ status: 'completed' }))).toBe(false);
    expect(isPlanActive(plan({ status: 'canceled' }))).toBe(false);
    expect(isPlanActive(null)).toBe(false);
  });

  it('presents plan jobs with their dependencies', () => {
    expect(planJobLine({ name: 'b', status: 'ready_to_merge', dependsOn: ['a'] })).toBe(
      '◆ b  ready to merge  ← a',
    );
    expect(planJobLine({ name: 'a', status: 'merged', dependsOn: [] })).toBe('✓ a  merged');
    expect([planJobIcon('running'), planJobTone('running')]).toEqual(['▶', 'info']);
    expect([planJobIcon('conflict'), planJobTone('conflict')]).toEqual(['✗', 'error']);
    expect([planJobIcon('queued'), planJobTone('queued')]).toEqual(['○', 'muted']);
    expect([planJobIcon('canceled'), planJobTone('merged')]).toEqual(['■', 'success']);
  });
});

describe('selection', () => {
  it('clamps and moves within the list', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(2);
  });
});

describe('events', () => {
  it('narrows toast data', () => {
    expect(toastFromEvent({ message: 'job finished', variant: 'not-a-variant' })).toEqual({
      title: 'Mission Control',
      message: 'job finished',
      variant: 'info',
      duration: 5000,
    });
    expect(toastFromEvent({ title: 'T', message: 'm', variant: 'error', duration: 100 })).toEqual({
      title: 'T',
      message: 'm',
      variant: 'error',
      duration: 100,
    });
  });

  it('parses attention data and rejects malformed data', () => {
    expect(
      parseAttention({ kind: 'blocked', title: 'Blocked', message: 'help', jobName: 'a', sessionID: 'ses_1' }),
    ).toEqual({ kind: 'blocked', title: 'Blocked', message: 'help', jobName: 'a', sessionID: 'ses_1' });
    expect(parseAttention({ kind: 'complete', message: 'done' })).toEqual({
      kind: 'complete',
      title: 'Mission Control',
      message: 'done',
    });
    expect(parseAttention({ kind: 'unknown', message: 'x' })).toBeUndefined();
    expect(parseAttention({ kind: 'failed' })).toBeUndefined();
  });

  it('parses open data', () => {
    expect(parseOpen({ sessionID: 'ses_1', title: '[MC] a' })).toEqual({ sessionID: 'ses_1', title: '[MC] a' });
    expect(parseOpen({ sessionID: 'ses_1' })).toEqual({ sessionID: 'ses_1' });
    expect(parseOpen({ sessionID: '' })).toBeUndefined();
    expect(parseOpen({ title: 'x' })).toBeUndefined();
  });

  it('tells the user how to act on kinds that need them', () => {
    for (const kind of ['blocked', 'question', 'checkpoint'] as const) {
      const toast = attentionToast({ kind, title: 'T', message: 'Something happened.' });
      expect(toast.message).toContain('Something happened.');
      expect(toast.message).toContain('/mc-dashboard');
      expect(toast.variant).toBe('warning');
      expect(toast.duration).toBe(10000);
    }
    expect(attentionToast({ kind: 'checkpoint', title: 'T', message: 'm' }).message).toContain('approve');
    expect(attentionToast({ kind: 'blocked', title: 'T', message: 'm' }).message).toContain('answer');
  });

  it('keeps informational kinds short', () => {
    expect(attentionToast({ kind: 'complete', title: 'Job "a" completed', message: 'Branch: mc/a' })).toEqual({
      title: 'Job "a" completed',
      message: 'Branch: mc/a',
      variant: 'success',
      duration: 5000,
    });
    expect(attentionToast({ kind: 'failed', title: 'T', message: 'm' }).variant).toBe('error');
    expect(attentionToast({ kind: 'needs_review', title: 'T', message: 'm' }).variant).toBe('info');
  });

  it('picks a sound per kind', () => {
    expect(attentionSound('complete')).toBe('done');
    expect(attentionSound('failed')).toBe('error');
    expect(attentionSound('blocked')).toBe('question');
    expect(attentionSound('question')).toBe('question');
    expect(attentionSound('checkpoint')).toBe('permission');
    expect(attentionSound('needs_review')).toBe('default');
  });

  it('matches events to the TUI location', () => {
    expect(sameLocation({ directory: '/p/a' }, { directory: '/p/a' })).toBe(true);
    expect(sameLocation({ directory: '/p/a/' }, { directory: '/p/a' })).toBe(true);
    expect(sameLocation({ directory: '/p/b' }, { directory: '/p/a' })).toBe(false);
    expect(sameLocation(undefined, { directory: '/p/a' })).toBe(true);
    expect(sameLocation({ directory: '/p/a' }, undefined)).toBe(true);
  });
});

describe('forms', () => {
  const color: FormField = {
    key: 'color',
    type: 'string',
    title: 'Color',
    description: 'Pick one',
    options: [
      { value: 'r', label: 'Red' },
      { value: 'b', label: 'Blue' },
    ],
  };
  const confirm: FormField = { key: 'ok', type: 'boolean', title: 'Proceed?' };
  const link: FormField = { key: 'docs', type: 'external', url: 'https://example.com' };
  const hidden: FormField = { key: 'secret', type: 'string', hidden: true };

  const form = {
    id: 'frm_1',
    sessionID: 'ses_job',
    title: 'Which color?',
    fields: [color, link, hidden, confirm],
  } as unknown as FormInfo;

  it('keeps only the fields a person answers', () => {
    expect(answerableFields(form).map((field) => field.key)).toEqual(['color', 'ok']);
  });

  it('describes a field for a prompt dialog', () => {
    expect(formFieldPrompt(form, color)).toEqual({
      title: 'Which color?',
      description: 'Color\nPick one\nOptions: Red, Blue',
      placeholder: 'one of the options',
    });
    expect(formFieldPrompt(form, confirm)).toEqual({
      title: 'Which color?',
      description: 'Proceed?',
      placeholder: 'yes or no',
    });
    expect(formFieldPrompt({ title: '' }, { key: 'n', type: 'number' })).toEqual({
      title: 'Answer',
      placeholder: 'a number',
    });
  });

  it('builds the reply from one response per answerable field', () => {
    expect(buildFormReply(form, ['blue', 'yes'])).toEqual({
      sessionID: 'ses_job',
      formID: 'frm_1',
      answer: { color: 'b', ok: true },
    });
  });

  it('treats a missing response as empty', () => {
    expect(buildFormReply(form, ['Red'])).toEqual({
      sessionID: 'ses_job',
      formID: 'frm_1',
      answer: { color: 'r', ok: false },
    });
  });
});
