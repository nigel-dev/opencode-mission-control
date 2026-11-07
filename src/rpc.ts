import { Rpc } from '@opencode/plugin';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
}

export const missionControlRpc = Rpc.define({
  id: 'opencode-mission-control',
  methods: {},
  events: {
    toast: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          variant: {
            type: 'string',
            enum: ['info', 'success', 'warning', 'error'],
          },
          duration: { type: 'number' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  },
});

type ToastEmitter = (options: ToastOptions) => Promise<void>;

let toastEmitter: ToastEmitter | null = null;

export function setToastEmitter(emitter: ToastEmitter | null): void {
  toastEmitter = emitter;
}

export async function showToast(options: ToastOptions): Promise<void> {
  if (!toastEmitter) return;
  try {
    await toastEmitter(options);
  } catch {
    // Toasts are best-effort; never block job notification flow on a toast failure.
  }
}
