import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Box } from '../../../client/overlay/geometry.js';
import { pickerPlacement } from '../../../client/overlay/slot-geometry.js';
import { STRINGS } from '../../strings.js';

export type UnsupportedNoticeProps = {
  /** The field the notice is about, in the framed document's coordinates. */
  readonly anchor: Box;
  /** The part of the document the frame shows, in the same coordinates. */
  readonly visible: Box;
  /** "Keep as is": closes the notice and leaves the text as it is. */
  readonly onKeep: () => void;
  /**
   * "Remove unsupported formatting": strips what the theme no longer allows,
   * keeping every word, and saves it as a normal write.
   */
  readonly onRemove: () => Promise<unknown>;
};

const BUTTON =
  'h-8 shrink-0 cursor-pointer rounded-lg border px-3 text-caption font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-60';

/**
 * The keep-data notice of a text field whose stored formatting the theme no
 * longer allows. The field is not mounted, so nothing can strip it by
 * accident; the editor keeps it or removes the unsupported formatting. It is
 * drawn in the interaction plane below the field (above it when there is no
 * room), kept 8px inside the visible part of the frame. It is announced once
 * as an alert and is an ordinary note after that.
 */
export function UnsupportedNotice(props: UnsupportedNoticeProps): ReactElement {
  const { anchor, visible, onKeep, onRemove } = props;
  const [announced, setAnnounced] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setAnnounced(true);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const placement = pickerPlacement(anchor, visible);

  return (
    <div
      ref={root}
      role={announced ? 'note' : 'alert'}
      className="pk-unsupported-notice"
      data-unsupported-notice=""
      data-side={placement.side}
      style={{
        left: placement.left,
        top: placement.top,
        transform: placement.side === 'above' ? 'translateY(-100%)' : undefined,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onKeep();
        }
      }}
    >
      <p className="m-0 text-body font-semibold text-text">
        {STRINGS['text.unsupported.heading']}
      </p>
      <p className="m-0 text-body text-text-muted">
        {STRINGS['text.unsupported.body']}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={`${BUTTON} border-control-border bg-surface text-text hover:bg-surface-muted`}
          onClick={onKeep}
        >
          {STRINGS['text.unsupported.keep']}
        </button>
        <button
          type="button"
          disabled={busy}
          className={`${BUTTON} border-transparent bg-accent text-accent-contrast`}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onRemove())
              // The save queue already reports a save that failed.
              .catch(() => undefined)
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {STRINGS['text.unsupported.remove']}
        </button>
      </div>
    </div>
  );
}
