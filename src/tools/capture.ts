import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { capturePane } from '../lib/tmux';
import { getSharedMonitor } from '../lib/orchestrator-singleton';

export const mc_capture: ToolDefinition = tool({
  description: 'Capture current terminal output or structured events from a job',
  args: {
    name: tool.schema.string().describe('Job name'),
    lines: tool.schema.number().optional().describe('Number of lines for TUI mode (default: 100)'),
    filter: tool.schema.enum(['file.edited', 'tool', 'error', 'all']).optional().describe('Event filter for serve-mode jobs (default: all)'),
  },
  async execute(args) {
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
        return JSON.stringify({
          job: job.name,
          mode: 'serve',
          status: job.status,
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

      return JSON.stringify(result, null, 2);
    }

    const lineCount = args.lines ?? 100;
    const output = await capturePane(job.tmuxTarget, lineCount);
    return output;
  },
});
