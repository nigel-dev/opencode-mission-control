import { Plugin as Tui } from '@opencode/plugin/tui';
import { missionControlRpc, type ToastVariant } from './rpc';

function toVariant(value: unknown): ToastVariant {
  if (
    value === 'info' ||
    value === 'success' ||
    value === 'warning' ||
    value === 'error'
  ) {
    return value;
  }
  return 'info';
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export default Tui.define({
  id: 'opencode-mission-control-tui',
  setup(ctx) {
    const rpc = ctx.client.rpc(missionControlRpc);
    const unsubscribe = rpc.events.on('toast', (event) => {
      const data = event.data;
      ctx.ui.toast.show({
        title: toText(data.title) || 'Mission Control',
        message: toText(data.message),
        variant: toVariant(data.variant),
        duration: typeof data.duration === 'number' ? data.duration : 5000,
      });
    });
    return () => {
      unsubscribe();
    };
  },
});
