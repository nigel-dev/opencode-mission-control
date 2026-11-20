import type { Plugin } from '@opencode/plugin';
import { bindToDirectory, getProjectDirectory } from './lib/project-context';
import { emitOutput, hasRecentClient } from './lib/rpc-events';
import { mc_overview } from './tools/overview';
import { mc_jobs } from './tools/jobs';
import { mc_status } from './tools/status';
import { mc_attach } from './tools/attach';
import { mc_cleanup } from './tools/cleanup';
import { mc_capture } from './tools/capture';
import { mc_diff } from './tools/diff';
import { mc_plan_approve } from './tools/plan-approve';

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
  'mc-attach': "Show how to open a job's session",
  'mc-cleanup': 'Clean up finished job worktrees and metadata',
  'mc-capture': 'Capture the recent transcript of a job',
  'mc-diff': "Show changes in a job's branch compared to base",
  'mc-approve': 'Approve a pending plan or clear a supervisor checkpoint',
  'mc-plan': 'Create a multi-job orchestrated plan',
};

function isCheckpoint(
  value: string,
): value is 'pre_merge' | 'on_error' | 'pre_pr' {
  return value === 'pre_merge' || value === 'on_error' || value === 'pre_pr';
}

/**
 * Show a slash command's output to the person who ran it. With a TUI
 * connected it opens in a dialog and stays out of the conversation. RPC events
 * reach nobody when no TUI is listening (web and desktop clients), so the
 * output is then added to the session as a message that does not start a turn.
 */
async function deliverOutput(client: Client, sessionID: string, title: string, content: string): Promise<void> {
  if (hasRecentClient()) {
    await emitOutput({ title, content, sessionID });
    return;
  }
  await client.session.synthetic({ sessionID, text: `${title}\n\n${content}`, resume: false });
}

async function runDirectCommand(
  client: Client,
  sessionID: string,
  command: string,
  args: string,
): Promise<void> {
  let content: string;

  switch (command) {
    case 'mc': {
      content = (await mc_overview.execute()).content;
      break;
    }
    case 'mc-jobs': {
      content = (await mc_jobs.execute({})).content;
      break;
    }
    case 'mc-status': {
      if (!args) {
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      content = (await mc_status.execute({ name: args })).content;
      break;
    }
    case 'mc-attach': {
      if (!args) {
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      content = (await mc_attach.execute({ name: args })).content;
      break;
    }
    case 'mc-cleanup': {
      content = args
        ? (await mc_cleanup.execute({ name: args })).content
        : (await mc_cleanup.execute({ all: true })).content;
      break;
    }
    case 'mc-capture': {
      if (!args) {
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      content = (await mc_capture.execute({ name: args })).content;
      break;
    }
    case 'mc-diff': {
      if (!args) {
        const jobList = (await mc_jobs.execute({})).content;
        content =
          'No job name provided. Here are your current jobs:\n\n' + jobList;
        break;
      }
      content = (await mc_diff.execute({ name: args })).content;
      break;
    }
    case 'mc-approve': {
      content =
        args && isCheckpoint(args)
          ? (await mc_plan_approve.execute({ checkpoint: args })).content
          : (await mc_plan_approve.execute({})).content;
      break;
    }
    default:
      return;
  }

  await deliverOutput(client, sessionID, `/${command}`, content);
}

export async function registerCommands(ctx: Client): Promise<void> {
  // The host replays this transform from its own context; capture the project now.
  const directory = getProjectDirectory();

  await ctx.command.transform((editor) => {
    for (const name of DIRECT_COMMANDS) {
      editor.add({
        name,
        description: COMMAND_DESCRIPTIONS[name],
        execute: bindToDirectory(directory, async (input) => {
          const args = input.prompt.text.trim();
          try {
            await runDirectCommand(ctx, input.sessionID, name, args);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await deliverOutput(ctx, input.sessionID, `/${name}`, `Error: ${message || 'Unknown error'}`);
          }
        }),
      });
    }

    for (const [name, template] of Object.entries(TEMPLATE_COMMANDS)) {
      editor.add({
        name,
        description: COMMAND_DESCRIPTIONS[name],
        execute: bindToDirectory(directory, async (input) => {
          const args = input.prompt.text.trim();
          // A replacer function: `$&` and friends in the arguments stay literal.
          const expanded = template.replace('$ARGUMENTS', () => args);
          await ctx.session.prompt({ sessionID: input.sessionID, text: expanded });
        }),
      });
    }
  });
}
