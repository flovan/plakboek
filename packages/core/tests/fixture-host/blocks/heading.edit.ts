import { defineBlockEdit } from '@plakboek/render';

/** A string only this module holds, so a build test can find the chunk it
 * landed in. */
export const HEADING_EDIT_MARKER = 'pk-fixture-heading-edit-marker';

export default defineBlockEdit({
  blockType: 'heading',
  hooks: {
    select: ({ id }) => {
      sessionStorage.setItem(HEADING_EDIT_MARKER, id);
    },
  },
});
