import { z } from 'zod';
import { getJobByName } from '../lib/job-state';
import { captureJobSession } from '../lib/job-runtime';
import { getSharedMonitor } from '../lib/orchestrator-singleton';

type CaptureFilter = 'file.edited' | 'tool' | 'error' | 'all';

export const mc_capture = {
  name: 'mc_capture',
  description: 'Capture the recent transcript of a job, or structured activity events with a filter',
  input: z.object({
    name: z.string().describe('Job name'),
    lines: z.number().optional().describe('Number of transcript lines to return (default: 100)'),
    filter: z.enum(['file.edited', 'tool', 'error', 'all']).optional().describe('Return structured activity events instead of the transcript: file.edited, tool, error, or all'),
  }).strict(),
  async execute(args: { name: string; lines?: number; filter?: CaptureFilter }) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    if (args.filter) {
      return { content: captureEvents(job.id, job.name, job.status, args.filter) };
    }

    if (!job.sessionID) {
      throw new Error(
        `Job "${args.name}" has no session to capture (it was launched by an older version of Mission Control).`,
      );
    }

    const output = await captureJobSession(job.sessionID, args.lines ?? 100);
    return { content: output };
  },
};

/** Activity the monitor accumulated from the job's events, as JSON. */
function captureEvents(jobId: string, jobName: string, status: string, filter: CaptureFilter): string {
  const accumulator = getSharedMonitor().getEventAccumulator(jobId);

  if (!accumulator) {
    return JSON.stringify({
      job: jobName,
      status,
      events: [],
      message: 'No events accumulated yet',
    }, null, 2);
  }

  const events: Array<{ type: string; timestamp: string; payload: unknown }> = [];

  if (filter === 'all' || filter === 'file.edited') {
    for (const file of accumulator.filesEdited) {
      events.push({
        type: 'file.edited',
        timestamp: new Date(accumulator.lastActivityAt).toISOString(),
        payload: { path: file },
      });
    }
  }

  if ((filter === 'all' || filter === 'tool') && accumulator.currentTool) {
    events.push({
      type: 'tool',
      timestamp: new Date(accumulator.lastActivityAt).toISOString(),
      payload: { tool: accumulator.currentTool, file: accumulator.currentFile },
    });
  }

  return JSON.stringify({
    job: jobName,
    status,
    filter,
    summary: {
      totalEvents: accumulator.eventCount,
      filesEdited: accumulator.filesEdited.length,
      currentTool: accumulator.currentTool,
      currentFile: accumulator.currentFile,
      lastActivityAt: new Date(accumulator.lastActivityAt).toISOString(),
    },
    events,
  }, null, 2);
}
