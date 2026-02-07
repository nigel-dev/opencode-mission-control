import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { capturePane } from '../lib/tmux';

export const mc_capture: ToolDefinition = tool({
  description: 'Capture current terminal output from a job',
  args: {
    name: tool.schema.string().describe('Job name'),
    lines: tool.schema.number().optional().describe('Number of lines (default: 100)'),
  },
  async execute(args) {
    // 1. Find job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Use capturePane to get output
    const lineCount = args.lines ?? 100;
    const output = await capturePane(job.tmuxTarget, lineCount);

    // 3. Return text content
    return output;
  },
});
