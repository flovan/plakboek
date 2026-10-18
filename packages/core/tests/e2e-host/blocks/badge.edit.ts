import { defineBlockEdit } from '@plakboek/render';

/**
 * Test-only: a hook that changes the site's DOM after the block is replaced,
 * so the dev swap spec can prove `rendered` ran in the edit frame.
 */
export default defineBlockEdit({
  blockType: 'badge',
  hooks: {
    rendered: ({ element }) => {
      element.setAttribute('data-rendered-by-hook', '1');
    },
  },
});
