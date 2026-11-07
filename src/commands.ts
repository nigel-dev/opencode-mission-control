import type { Plugin } from '@opencode/plugin';

type Client = Plugin.Context;

const DIRECT_COMMANDS = [
  'mc',
  'mc-jobs',
  'mc-status',
  'mc-attach',
  'mc-cleanup',
  'mc-capture',
  'mc-diff',
  'mc-approve',
] as const;

const TEMPLATE_COMMANDS: Record<string, string> = {
  'mc-launch':
    'Launch a new Mission Control parallel coding session with these instructions: $ARGUMENTS',
  'mc-plan':
    'Create and execute a Mission Control orchestrated plan for: $ARGUMENTS',
};

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  'mc-jobs': 'List all Mission Control jobs and their status',
  mc: 'Show Mission Control dashboard overview',
  'mc-launch': 'Launch a new parallel AI agent job',
  'mc-status': 'Get detailed status of a specific job',
  'mc-attach': 'Get the tmux attach command for a job',
  'mc-cleanup': 'Clean up finished job worktrees and metadata',
  'mc-capture': 'Capture terminal output from a running job',
  'mc-diff': "Show changes in a job's branch compared to base",
  'mc-approve': 'Approve a pending plan or clear a supervisor checkpoint',
  'mc-plan': 'Create a multi-job orchestrated plan',
};

function isCheckpoint(
  value: string,
): value is 'pre_merge' | 'on_error' | 'pre_pr' {
  return value === 'pre_merge' || value === 'on_error' || value === 'pre_pr';
}

async function runDirectCommand(
  ctx: Client,
  sessionID: string,
  command: string,
  args: string,
): Promise<void> {
  let content: string;

  switch (command) {
    case 'mc': {
      const { mc_overview } = await import('./tools/overview');
      content = (await mc_overview.execute()).content;
      break;
    }
    case 'mc-jobs': {
      const { mc_jobs } = await import('./tools/jobs');
      content = (await mc_jobs.execute({})).content;
      break;
    }
    case 'mc-status': {
      if (!args) {
        const { mc_jobs } = await import('./tools/jobs');
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      const { mc_status } = await import('./tools/status');
      content = (await mc_status.execute({ name: args })).content;
      break;
    }
    case 'mc-attach': {
      if (!args) {
        const { mc_jobs } = await import('./tools/jobs');
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      const { mc_attach } = await import('./tools/attach');
      content = (await mc_attach.execute({ name: args })).content;
      break;
    }
    case 'mc-cleanup': {
      const { mc_cleanup } = await import('./tools/cleanup');
      content = args
        ? (await mc_cleanup.execute({ name: args })).content
        : (await mc_cleanup.execute({ all: true })).content;
      break;
    }
    case 'mc-capture': {
      if (!args) {
        const { mc_jobs } = await import('./tools/jobs');
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      const { mc_capture } = await import('./tools/capture');
      content = (await mc_capture.execute({ name: args })).content;
      break;
    }
    case 'mc-diff': {
      if (!args) {
        const { mc_jobs } = await import('./tools/jobs');
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      const { mc_diff } = await import('./tools/diff');
      content = (await mc_diff.execute({ name: args })).content;
      break;
    }
    case 'mc-approve': {
      const { mc_plan_approve } = await import('./tools/plan-approve');
      content =
        args && isCheckpoint(args)
          ? (await mc_plan_approve.execute({ checkpoint: args })).content
          : (await mc_plan_approve.execute({})).content;
      break;
    }
    default:
      return;
  }

  await ctx.session.synthetic({ sessionID, text: content });
}

export async function registerCommands(ctx: Client): Promise<void> {
  await ctx.command.transform((editor) => {
    for (const name of DIRECT_COMMANDS) {
      editor.add({
        name,
        description: COMMAND_DESCRIPTIONS[name],
        execute: async (input) => {
          const args = input.prompt.text.trim();
          try {
            await runDirectCommand(ctx, input.sessionID, name, args);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Error: ${message || 'Unknown error'}`,
            });
          }
        },
      });
    }

    for (const [name, template] of Object.entries(TEMPLATE_COMMANDS)) {
      editor.add({
        name,
        description: COMMAND_DESCRIPTIONS[name],
        execute: async (input) => {
          const args = input.prompt.text.trim();
          const expanded = template.replace('$ARGUMENTS', args);
          await ctx.session.prompt({ sessionID: input.sessionID, text: expanded });
        },
      });
    }
  });
}
