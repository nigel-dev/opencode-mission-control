import { JobMonitor } from './monitor';
import { Orchestrator, type CheckpointAttentionCallback, type NotifyCallback, type ToastCallback } from './orchestrator';
import type { MCConfig } from './config';
import { getProjectDirectory } from './project-context';
import { showToast } from './toast';
import { emitAttention, hasRpcEventEmitter } from './rpc-events';
import * as notify from './notify';

// One OpenCode server hosts a plugin instance per location, all sharing these
// modules, so "shared" state is shared per project directory, not per process.
const sharedMonitors = new Map<string, JobMonitor>();
const sharedOrchestrators = new Map<string, Orchestrator>();

export function getSharedMonitor(): JobMonitor {
  const directory = getProjectDirectory();
  let monitor = sharedMonitors.get(directory);
  if (!monitor) {
    monitor = new JobMonitor();
    sharedMonitors.set(directory, monitor);
  }
  return monitor;
}

export function setSharedNotifyCallback(callback: NotifyCallback): void {
  notify.setSharedNotifyCallback(callback);
}

export function getSharedNotifyCallback(): NotifyCallback | null {
  return notify.getSharedNotifyCallback();
}

/**
 * Callbacks for Orchestrator instances created by tools. Besides the
 * notification callback, route toasts through the plugin RPC so they reach the
 * TUI (the orchestrator otherwise has no toast sink), and supervisor
 * checkpoints through the RPC `attention` event.
 */
export function getSharedOrchestratorCallbacks(): {
  toast: ToastCallback;
  notify?: NotifyCallback;
  attention: CheckpointAttentionCallback;
} {
  return {
    toast: (title, message, variant, duration) => {
      void showToast({ title, message, variant, duration });
    },
    notify: getSharedNotifyCallback() ?? undefined,
    attention: (checkpoint, message) => {
      if (!hasRpcEventEmitter()) {
        return false;
      }
      void emitAttention({ kind: 'checkpoint', title: `Checkpoint: ${checkpoint}`, message });
      return true;
    },
  };
}

function logDisposeFailure(error: unknown): void {
  console.warn('[Mission Control] An orchestrator did not shut down cleanly:', error);
}

/**
 * Make `orchestrator` the project's orchestrator (or clear it with null). The
 * instance it replaces is disposed: there is never more than one live
 * orchestrator per project.
 */
export function setSharedOrchestrator(orchestrator: Orchestrator | null): void {
  const directory = getProjectDirectory();
  const previous = sharedOrchestrators.get(directory);
  if (previous && previous !== orchestrator) {
    previous.dispose().catch(logDisposeFailure);
  }
  if (orchestrator) {
    sharedOrchestrators.set(directory, orchestrator);
  } else {
    sharedOrchestrators.delete(directory);
  }
}

export function getSharedOrchestrator(): Orchestrator | null {
  return sharedOrchestrators.get(getProjectDirectory()) ?? null;
}

/**
 * Retire the project's live orchestrator and install a fresh one. Waits for a
 * reconcile pass the old one still had in flight, so the two never work on the
 * plan at the same time. Every tool that needs an orchestrator goes through
 * here.
 */
export async function replaceSharedOrchestrator(config: MCConfig): Promise<Orchestrator> {
  const directory = getProjectDirectory();
  // Loop: another caller may install one while this one waits.
  for (
    let previous = sharedOrchestrators.get(directory);
    previous;
    previous = sharedOrchestrators.get(directory)
  ) {
    sharedOrchestrators.delete(directory);
    try {
      await previous.dispose();
    } catch (error) {
      logDisposeFailure(error);
    }
  }

  const orchestrator = new Orchestrator(getSharedMonitor(), config, getSharedOrchestratorCallbacks());
  sharedOrchestrators.set(directory, orchestrator);
  return orchestrator;
}

/**
 * Stop and forget the current project's shared state. Called when the plugin
 * instance unloads so a reload starts from a clean monitor and orchestrator.
 */
export function disposeSharedState(): void {
  const directory = getProjectDirectory();
  sharedOrchestrators.get(directory)?.dispose().catch(logDisposeFailure);
  sharedOrchestrators.delete(directory);
  sharedMonitors.get(directory)?.stop();
  sharedMonitors.delete(directory);
  notify.clearSharedNotifyCallback();
}
