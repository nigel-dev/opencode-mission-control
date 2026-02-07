import { JobMonitor } from './monitor';

let sharedMonitor: JobMonitor | null = null;

export function getSharedMonitor(): JobMonitor {
  if (!sharedMonitor) {
    sharedMonitor = new JobMonitor();
  }
  return sharedMonitor;
}
