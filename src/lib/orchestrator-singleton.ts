import { JobMonitor } from './monitor';
import type { NotifyCallback, Orchestrator } from './orchestrator';

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

export function setSharedOrchestrator(orchestrator: Orchestrator | null): void {
  sharedOrchestrator = orchestrator;
}

export function getSharedOrchestrator(): Orchestrator | null {
  return sharedOrchestrator;
}
