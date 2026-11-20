import { Plugin as Tui } from '@opencode/plugin/tui';
import { setupMissionControl } from './tui/setup';
import { createViews } from './tui/views';

export default Tui.define({
  id: 'opencode-mission-control-tui',
  setup(context) {
    return setupMissionControl(context, createViews);
  },
});
