import type { Plugin } from '@opencode/plugin';
import * as fs from 'fs';
import { join } from 'path';
import { canonicalPath, getXdgDataDir } from './paths';
import { readFileIfExists } from './utils';
import { getProjectDirectory } from './project-context';

/**
 * Native job runtime: every job is an ordinary OpenCode session running in the
 * job's worktree on the same server as the launching session. There is no
 * tmux, no per-job `opencode serve`, and no port or password to manage.
 */

export type RuntimeClient = Plugin.Context;

export type JobOutcome = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface JobModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface StartJobSessionOptions {
  jobId: string;
  jobName: string;
  worktreePath: string;
  prompt: string;
  agent?: string;
  model?: JobModel;
  planId?: string;
  launchSessionID?: string;
}

// Keyed by project directory: one server hosts a plugin instance per location.
const clients = new Map<string, RuntimeClient>();

// Session IDs known to belong to jobs, per project directory. Job sessions
// share the server (and its event stream) with the user's own sessions, so
// code that tracks "the session the user is in" must be able to tell them apart.
const jobSessions = new Map<string, Set<string>>();

export function setRuntimeClient(client: RuntimeClient | null): void {
  const directory = getProjectDirectory();
  if (client) {
    clients.set(directory, client);
  } else {
    clients.delete(directory);
    jobSessions.delete(directory);
  }
}

/** Record that a session belongs to a job. */
export function registerJobSession(sessionID: string): void {
  const directory = getProjectDirectory();
  let sessions = jobSessions.get(directory);
  if (!sessions) {
    sessions = new Set();
    jobSessions.set(directory, sessions);
  }
  sessions.add(sessionID);
}

/** Whether a session is known to belong to a job of the current project. */
export function isJobSession(sessionID: string): boolean {
  return jobSessions.get(getProjectDirectory())?.has(sessionID) ?? false;
}

/**
 * Background work (shells, subagents) a job's session still had running when
 * it last went idle. Written by the plugin instance loaded in the job's
 * worktree, read by the monitor of the project that owns the job.
 *
 * Each location loads its own copy of the plugin's modules, so this cannot be
 * module state: it is a marker file per session, in a directory per worktree.
 * A plugin reload keeps the markers (the work is still running); a marker left
 * by a previous server process is ignored (the work died with that process).
 */
const SAME_SERVER_TOLERANCE_MS = 5_000;

function backgroundDir(worktreePath: string): string {
  // The worktree's path, flattened into one directory name.
  const key = canonicalPath(worktreePath).replace(/[^A-Za-z0-9._-]/g, '_');
  return join(getXdgDataDir(), '.background', key);
}

function markerName(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Record how much background work the current worktree's session left running. */
export function recordBackgroundWork(sessionID: string, count: number): void {
  const dir = backgroundDir(getProjectDirectory());
  const marker = join(dir, markerName(sessionID));
  if (count > 0) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ count, serverStartedAt: serverStartedAt() }));
  } else {
    fs.rmSync(marker, { force: true });
  }
}

/** Whether the session of the job in `worktreePath` went idle with background work still running. */
export function hasBackgroundWork(worktreePath: string, sessionID: string): boolean {
  const content = readFileIfExists(join(backgroundDir(worktreePath), markerName(sessionID)));
  if (content === null) {
    return false;
  }
  try {
    const marker = JSON.parse(content) as { serverStartedAt?: unknown };
    return (
      typeof marker.serverStartedAt === 'number' &&
      Math.abs(marker.serverStartedAt - serverStartedAt()) <= SAME_SERVER_TOLERANCE_MS
    );
  } catch (error) {
    // A marker cut off mid-write says nothing reliable; treat it as absent.
    console.warn(`[Mission Control] Ignoring an unreadable background-work marker for ${worktreePath}:`, error);
    return false;
  }
}

/** Forget the background work recorded for a job's worktree (when the job is cleaned up). */
export function clearBackgroundWork(worktreePath: string): void {
  fs.rmSync(backgroundDir(worktreePath), { recursive: true, force: true });
}

/** What a tool call knows about its caller (a subset of the host's tool context). */
export interface ToolCallContext {
  sessionID?: string;
  agent?: string;
  messageID?: string;
  id?: string;
}

/**
 * Ask the calling session's permission rules (and, when they say so, the
 * user) before a tool does something on the user's behalf. Resolves when
 * allowed; a denial rejects and must propagate out of the tool unchanged.
 * Calls without a session (the TUI dashboard, slash commands) are made by the
 * user directly and are not asked again.
 */
export async function assertToolPermission(
  context: ToolCallContext | undefined,
  action: string,
  resources: string[],
): Promise<void> {
  if (!context?.sessionID) {
    return;
  }
  await getRuntimeClient().permission.assert({
    sessionID: context.sessionID,
    ...(context.agent ? { agent: context.agent } : {}),
    action,
    resources,
    ...(context.messageID && context.id
      ? { source: { type: 'tool' as const, messageID: context.messageID, id: context.id } }
      : {}),
  });
}

/** Whether an error from the session API says the session does not exist (any more). */
export function isSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { _tag?: unknown; name?: unknown; message?: unknown };
  if (candidate._tag === 'SessionNotFoundError' || candidate.name === 'SessionNotFoundError') {
    return true;
  }
  return typeof candidate.message === 'string' && /session\b.*\bnot found/i.test(candidate.message);
}

export function getRuntimeClient(): RuntimeClient {
  const client = clients.get(getProjectDirectory());
  if (!client) {
    throw new Error(
      'Mission Control is not initialized for this project. Reload OpenCode (/reload) and try again.',
    );
  }
  return client;
}

export function hasRuntimeClient(): boolean {
  return clients.has(getProjectDirectory());
}

/**
 * Parse "provider/model" or "provider/model#variant" into a model reference.
 */
export function parseModel(model: string | undefined): JobModel | undefined {
  if (!model) return undefined;
  const [ref, variant] = model.split('#', 2);
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

export function jobSessionTitle(jobName: string): string {
  return `[MC] ${jobName}`;
}

/**
 * Create the job's session in its worktree and send the prompt. The job runs
 * without interactive approval: permission requests it raises are answered by
 * the monitor from the job's permission policy.
 */
export async function startJobSession(options: StartJobSessionOptions): Promise<string> {
  const client = getRuntimeClient();

  const session = await client.session.create({
    location: { directory: options.worktreePath },
    title: jobSessionTitle(options.jobName),
    agent: options.agent,
    model: options.model,
    metadata: {
      missionControl: {
        jobId: options.jobId,
        jobName: options.jobName,
        ...(options.planId ? { planId: options.planId } : {}),
        ...(options.launchSessionID ? { launchSessionID: options.launchSessionID } : {}),
      },
    },
  });
  registerJobSession(session.id);

  try {
    await client.session.prompt({ sessionID: session.id, text: options.prompt });
  } catch (error) {
    await client.session.remove({ sessionID: session.id }).catch((removeError: unknown) => {
      console.warn(`[Mission Control] Failed to remove session ${session.id} after a failed launch:`, removeError);
    });
    throw new Error(
      `Failed to send prompt to job session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return session.id;
}

/** Send a follow-up prompt to a job, waking it if it is idle. */
export async function promptJobSession(sessionID: string, text: string): Promise<void> {
  await getRuntimeClient().session.prompt({ sessionID, text });
}

/** Stop a job's current run without resuming queued work. */
export async function stopJobSession(sessionID: string): Promise<void> {
  await getRuntimeClient().session.interrupt({ sessionID, resume: false });
}

/** Delete a job's session, stopping it first if it is still running. */
export async function removeJobSession(sessionID: string): Promise<void> {
  await getRuntimeClient().session.remove({ sessionID });
}

/** When the server process hosting this plugin started. */
export function serverStartedAt(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * Resolve the job's state from its session. A session with no recorded outcome
 * is still running (or has not started its first turn yet).
 *
 * A session last written before this server process started cannot still be
 * running: its turn belonged to a process that is gone (the server was killed
 * or restarted mid-turn) and it never recorded an outcome. It is reported as
 * `interrupted` so it is resumed like any other turn cut off by a restart.
 */
export async function getJobOutcome(
  sessionID: string,
  startedAt: number = serverStartedAt(),
): Promise<JobOutcome> {
  const session = await getRuntimeClient().session.get({ sessionID });
  // `outcome` keeps the previous turn's result while a follow-up turn runs.
  const busy = session.time.busy ?? 0;
  if (busy > (session.time.idle ?? 0)) {
    const lastWrite = session.time.updated ?? busy;
    return lastWrite < startedAt ? 'interrupted' : 'running';
  }
  return session.outcome ?? 'running';
}

export interface JobUsage {
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export async function getJobUsage(sessionID: string): Promise<JobUsage> {
  const session = await getRuntimeClient().session.get({ sessionID });
  return {
    cost: session.cost,
    inputTokens: session.tokens.input + session.tokens.cache.read + session.tokens.cache.write,
    outputTokens: session.tokens.output + session.tokens.reasoning,
  };
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'description', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return '';
}

/**
 * Render the tail of a job's transcript as plain text: what the agent said and
 * which tools it ran. Replaces capturing a terminal pane.
 */
export async function captureJobSession(sessionID: string, lines = 100): Promise<string> {
  const messages = await getRuntimeClient().session.context({ sessionID });
  const output: string[] = [];

  for (const message of messages) {
    if (message.type === 'user') {
      output.push(`> ${message.text}`);
      continue;
    }
    if (message.type !== 'assistant') continue;

    for (const part of message.content) {
      if (part.type === 'text') {
        output.push(part.text);
      } else if (part.type === 'tool') {
        const detail = summarizeToolInput(part.state.input);
        output.push(`[${part.name}${detail ? ` ${detail}` : ''}] ${part.state.status}`);
      }
    }
    if (message.error) {
      output.push(`[error] ${message.error.message}`);
    }
  }

  return output.join('\n').split('\n').slice(-lines).join('\n');
}
