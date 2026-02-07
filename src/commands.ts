import type { PluginInput, ToolContext } from '@opencode-ai/plugin';

type Client = PluginInput['client'];

// Minimal context for programmatic tool invocation from commands
const dummyContext: ToolContext = {
  sessionID: '',
  messageID: '',
  agent: '',
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

// Helper to send output to user without triggering LLM
async function sendMessage(client: Client, sessionID: string, text: string) {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: 'text' as const, text, ignored: true }],
    },
  });
}

// Register commands in config hook
export function registerCommands(config: any) {
  if (!config.command) config.command = {};

  config.command['mc-jobs'] = {
    template: '',
    description: 'List all Mission Control jobs and their status',
  };
  config.command['mc-launch'] = {
    template:
      'Launch a new Mission Control parallel coding session with these instructions: $ARGUMENTS',
    description: 'Launch a new parallel AI agent job',
  };
  config.command['mc-status'] = {
    template: '',
    description: 'Get detailed status of a specific job',
  };
  config.command['mc-attach'] = {
    template: '',
    description: 'Get the tmux attach command for a job',
  };
  config.command['mc-cleanup'] = {
    template: '',
    description: 'Clean up finished job worktrees and metadata',
  };
}

// Handle command execution for direct commands
export function createCommandHandler(client: Client) {
  return async (
    input: { command: string; sessionID: string; arguments: string },
    _output: { parts: any[] }
  ) => {
    // Only handle our direct commands (not mc-launch which is template-based)
    const ourCommands = ['mc-jobs', 'mc-status', 'mc-attach', 'mc-cleanup'];
    if (!ourCommands.includes(input.command)) return;

    try {
      let result: string;
      const args = input.arguments.trim();

      switch (input.command) {
        case 'mc-jobs': {
          const { mc_jobs } = await import('./tools/jobs');
          result = await mc_jobs.execute({}, dummyContext);
          break;
        }
        case 'mc-status': {
          if (!args) {
            const { mc_jobs } = await import('./tools/jobs');
            const jobList = await mc_jobs.execute({}, dummyContext);
            result =
              'No job name provided. Here are your current jobs:\n\n' + jobList;
            break;
          }
          const { mc_status } = await import('./tools/status');
          result = await mc_status.execute({ name: args }, dummyContext);
          break;
        }
        case 'mc-attach': {
          if (!args) {
            const { mc_jobs } = await import('./tools/jobs');
            const jobList = await mc_jobs.execute({}, dummyContext);
            result =
              'No job name provided. Here are your current jobs:\n\n' + jobList;
            break;
          }
          const { mc_attach } = await import('./tools/attach');
          result = await mc_attach.execute({ name: args }, dummyContext);
          break;
        }
        case 'mc-cleanup': {
          const { mc_cleanup } = await import('./tools/cleanup');
          if (args) {
            result = await mc_cleanup.execute({ name: args }, dummyContext);
          } else {
            result = await mc_cleanup.execute({ all: true }, dummyContext);
          }
          break;
        }
        default:
          return; // Not our command
      }

      await sendMessage(client, input.sessionID, result);
    } catch (err: any) {
      // If it's our marker, rethrow
      if (err?.message === '__MC_HANDLED__') throw err;
      // Otherwise, display the error to the user
      await sendMessage(
        client,
        input.sessionID,
        `Error: ${err?.message || 'Unknown error'}`
      );
    }

    // Prevent LLM from processing this command
    throw new Error('__MC_HANDLED__');
  };
}
