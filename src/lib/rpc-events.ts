import type { AttentionEvent, OpenEvent, OutputEvent } from '../rpc';
import { getProjectDirectory } from './project-context';

export interface RpcEventEmitter {
  changed(data: { reason: string }): Promise<void>;
  attention(data: AttentionEvent): Promise<void>;
  open(data: OpenEvent): Promise<void>;
  output(data: OutputEvent): Promise<void>;
}

/** Bursts of state changes within this window reach clients as one `changed` event. */
export const CHANGED_DEBOUNCE_MS = 250;

interface ProjectEvents {
  emitter: RpcEventEmitter;
  timer?: ReturnType<typeof setTimeout>;
  reasons: Set<string>;
  /** When a client last asked this project for a snapshot. */
  clientSeenAt?: number;
}

/** A connected TUI refetches at least every 15s; allow for a few missed beats. */
export const CLIENT_SEEN_WINDOW_MS = 60_000;

// Keyed by project directory: each plugin instance emits through its own RPC registration.
const projects = new Map<string, ProjectEvents>();

function logFailure(event: string, error: unknown): void {
  // RPC events are best-effort: a client that missed one refetches on its
  // safety-net interval, so a failed emit must never break the caller.
  console.debug(`[Mission Control] Could not emit "${event}" event:`, error);
}

async function emitSafely(event: string, emit: () => Promise<void>): Promise<void> {
  try {
    await emit();
  } catch (error) {
    logFailure(event, error);
  }
}

export function setRpcEventEmitter(emitter: RpcEventEmitter | null): void {
  const directory = getProjectDirectory();
  const existing = projects.get(directory);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  if (emitter) {
    projects.set(directory, { emitter, reasons: new Set() });
  } else {
    projects.delete(directory);
  }
}

/**
 * Note that a client (the TUI part) just asked this project for state. RPC
 * events reach only connected clients and the server cannot list them, so a
 * recent request is the evidence that somebody is listening.
 */
export function recordClientSeen(): void {
  const project = projects.get(getProjectDirectory());
  if (project) {
    project.clientSeenAt = Date.now();
  }
}

/** Whether a client asked this project for state recently enough to be shown RPC events. */
export function hasRecentClient(windowMs: number = CLIENT_SEEN_WINDOW_MS): boolean {
  const seenAt = projects.get(getProjectDirectory())?.clientSeenAt;
  return seenAt !== undefined && Date.now() - seenAt <= windowMs;
}

/** Whether this project's plugin instance can emit RPC events. */
export function hasRpcEventEmitter(): boolean {
  return projects.has(getProjectDirectory());
}

/**
 * Tell connected clients that job or plan state changed. Calls within
 * `CHANGED_DEBOUNCE_MS` of the first one are coalesced into a single event
 * whose reason lists the distinct reasons.
 */
export function emitChanged(reason: string): void {
  const directory = getProjectDirectory();
  const project = projects.get(directory);
  if (!project) return;

  project.reasons.add(reason);
  if (project.timer) return;

  project.timer = setTimeout(() => {
    project.timer = undefined;
    const reasons = [...project.reasons].join(',');
    project.reasons.clear();
    // The registration may have been replaced or removed while waiting.
    if (projects.get(directory) !== project) return;
    void emitSafely('changed', () => project.emitter.changed({ reason: reasons }));
  }, CHANGED_DEBOUNCE_MS);
}

export async function emitAttention(data: AttentionEvent): Promise<void> {
  const project = projects.get(getProjectDirectory());
  if (!project) return;
  await emitSafely('attention', () => project.emitter.attention(data));
}

export async function emitOpen(data: OpenEvent): Promise<void> {
  const project = projects.get(getProjectDirectory());
  if (!project) return;
  await emitSafely('open', () => project.emitter.open(data));
}

export async function emitOutput(data: OutputEvent): Promise<void> {
  const project = projects.get(getProjectDirectory());
  if (!project) return;
  await emitSafely('output', () => project.emitter.output(data));
}
