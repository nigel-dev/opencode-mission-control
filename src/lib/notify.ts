import { getProjectDirectory } from './project-context';

export type NotifyCallback = (message: string, targetSessionID?: string) => void;

// Keyed by project directory: one server hosts a plugin instance per location.
const notifyCallbacks = new Map<string, NotifyCallback>();

export function setSharedNotifyCallback(callback: NotifyCallback): void {
  notifyCallbacks.set(getProjectDirectory(), callback);
}

export function getSharedNotifyCallback(): NotifyCallback | null {
  return notifyCallbacks.get(getProjectDirectory()) ?? null;
}

export function clearSharedNotifyCallback(): void {
  notifyCallbacks.delete(getProjectDirectory());
}
