import type { ToastOptions } from '../rpc';
import { getProjectDirectory } from './project-context';

type ToastEmitter = (options: ToastOptions) => Promise<void>;

// Keyed by project directory: each plugin instance emits through its own RPC registration.
const toastEmitters = new Map<string, ToastEmitter>();

export function setToastEmitter(emitter: ToastEmitter | null): void {
  const directory = getProjectDirectory();
  if (emitter) {
    toastEmitters.set(directory, emitter);
  } else {
    toastEmitters.delete(directory);
  }
}

export async function showToast(options: ToastOptions): Promise<void> {
  const toastEmitter = toastEmitters.get(getProjectDirectory());
  if (!toastEmitter) return;
  try {
    await toastEmitter(options);
  } catch {
    // Toasts are best-effort; never block job notification flow on a toast failure.
  }
}
