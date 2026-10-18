import type { ReactElement } from 'react';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';

/**
 * The visually hidden region that tells a screen reader what just happened:
 * what got selected, which mode the page is in now. It is polite, so it waits
 * for the user to finish what they are hearing, and it carries only names and
 * positions the editor already sees on screen.
 */
export function LiveRegion(props: {
  readonly store: EditorStore;
}): ReactElement {
  const announcement = useEditorStore(
    props.store,
    (state) => state.announcement,
  );
  return (
    <div role="status" className="sr-only" data-live-region="">
      {announcement}
    </div>
  );
}
