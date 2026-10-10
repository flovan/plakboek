import type { ReactElement } from 'react';
import { STRINGS } from './strings.js';

/** The id the skip link moves focus to. */
export const STAGE_ID = 'plakboek-stage';

/**
 * The stage: the region the page is shown in, holding one same-origin iframe
 * used purely as a viewport onto the site. The iframe's `src` is the same in
 * the server markup and in the hydrated tree, so hydrating never reloads it.
 * Geometry (the padding around the frame, the layouts) lives in the chrome
 * stylesheet's `:host` rules.
 */
export function Stage(props: { readonly frameUrl: string }): ReactElement {
  return (
    <div
      id={STAGE_ID}
      className="pk-stage"
      role="region"
      aria-label={STRINGS['landmark.frame']}
      tabIndex={-1}
    >
      <iframe
        className="pk-frame"
        src={props.frameUrl}
        title={STRINGS['landmark.frame']}
      />
    </div>
  );
}
