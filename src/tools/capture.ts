import { z } from 'zod';
import { getJobByName } from '../lib/job-state';
import { capturePane } from '../lib/tmux';
import { getSharedMonitor } from '../lib/orchestrator-singleton';

export const mc_capture = {
  name: 'mc_capture',
  description: 'Capture current terminal output or structured events from a job',
  input: z.object({
    name: z.string().describe('Job name'),
    lines: z.number().describe('Number of lines for TUI mode (default: 100)'),
    filter: z.enum(['file.edited', 'tool', 'error', 'all']).describe('Event filter for serve-mode jobs (default: all)'),
  }).strict(),
  async execute(args: { name: string; lines?: number; filter?: 'file.edited' | 'tool' | 'error' | 'all' }) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    const isServeMode = job.port !== undefined && job.port > 0;

    if (isServeMode) {
      const monitor = getSharedMonitor();
      const accumulator = monitor.getEventAccumulator(job.id);
      const filter = args.filter ?? 'all';

      if (!accumulator) {
        return { content: JSON.stringify({
          job: job.name,
          mode: 'serve',
          status: job.status,
          events: [],
          message: 'No events accumulated yet',
        }, null, 2) };
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

      const result = {
        job: job.name,
        mode: 'serve',
        status: job.status,
        filter,
        summary: {
          totalEvents: accumulator.eventCount,
          filesEdited: accumulator.filesEdited.length,
          currentTool: accumulator.currentTool,
          currentFile: accumulator.currentFile,
          lastActivityAt: new Date(accumulator.lastActivityAt).toISOString(),
        },
        events,
      };

      return { content: JSON.stringify(result, null, 2) };
    }

    const lineCount = args.lines ?? 100;
    const output = await capturePane(job.tmuxTarget, lineCount);
    return { content: output };
  },
};
