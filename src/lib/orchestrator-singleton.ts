import { JobMonitor } from './monitor';
import type { NotifyCallback, Orchestrator, ToastCallback } from './orchestrator';
import { showToast } from '../rpc';

let sharedMonitor: JobMonitor | null = null;
let sharedNotifyCallback: NotifyCallback | null = null;
let sharedOrchestrator: Orchestrator | null = null;

export function getSharedMonitor(): JobMonitor {
  if (!sharedMonitor) {
    sharedMonitor = new JobMonitor();
  }
  return sharedMonitor;
}

export function setSharedNotifyCallback(callback: NotifyCallback): void {
  sharedNotifyCallback = callback;
}

export function getSharedNotifyCallback(): NotifyCallback | null {
  return sharedNotifyCallback;
}

/**
 * Callbacks for Orchestrator instances created by tools. Besides the
 * notification callback, route toasts through the plugin RPC so they reach the
 * TUI (the orchestrator otherwise has no toast sink).
 */
export function getSharedOrchestratorCallbacks(): {
  toast: ToastCallback;
  notify?: NotifyCallback;
} {
  return {
    toast: (title, message, variant, duration) => {
      void showToast({ title, message, variant, duration });
    },
    notify: sharedNotifyCallback ?? undefined,
  };
}

export function setSharedOrchestrator(orchestrator: Orchestrator | null): void {
  sharedOrchestrator = orchestrator;
}

export function getSharedOrchestrator(): Orchestrator | null {
  return sharedOrchestrator;
}
