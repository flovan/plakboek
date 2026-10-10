import type { ReactElement } from 'react';
import { STRINGS } from './strings.js';

/** The centred column both panels share: at most 400px wide, text wrapping
 * inside it, filling the frame's area. */
const PANEL =
  'mx-auto flex h-full w-full max-w-[400px] flex-col items-center justify-center text-center';

const HEADING = 'm-0 text-heading font-semibold text-text wrap-anywhere';
const BODY = 'm-0 mt-2 text-body text-text-muted wrap-anywhere';

/**
 * Shown in the frame's place when the page could not be rendered for editing.
 * It carries no detail of the failure: no stack, no id, no message.
 */
export function FrameErrorPanel(props: {
  readonly onReload?: () => void;
}): ReactElement {
  return (
    <div role="alert" className={PANEL}>
      <h1 className={HEADING}>{STRINGS['frame.error.heading']}</h1>
      <p className={BODY}>{STRINGS['frame.error.body']}</p>
      <button
        type="button"
        onClick={props.onReload}
        className="mt-6 h-11 cursor-pointer rounded-lg border-0 bg-accent px-6 text-body font-semibold text-accent-contrast hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {STRINGS['frame.error.reload']}
      </button>
    </div>
  );
}

/**
 * Shown in the frame's place below 1024px, where the shell does not attempt a
 * layout. It has no button: Exit edit mode in the sidebar is the action.
 */
export function NarrowWindowPanel(): ReactElement {
  return (
    <div role="status" className={PANEL}>
      <h1 className={HEADING}>{STRINGS['frame.narrow.heading']}</h1>
      <p className={BODY}>{STRINGS['frame.narrow.body']}</p>
    </div>
  );
}
