import { useEffect, useRef, type ReactElement } from 'react';
import { formatString, STRINGS } from '../strings.js';

const HEADING_ID = 'plakboek-takeover-heading';

const BUTTON =
  'flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-lg px-4 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const CANCEL = `${BUTTON} border border-control-border bg-surface text-text hover:bg-surface-muted`;
const CONFIRM = `${BUTTON} border-0 bg-accent text-accent-contrast hover:bg-accent-hover aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-accent`;

export type TakeoverDialogProps = {
  readonly open: boolean;
  /** The display name of the editor who holds the page, and nothing else about them. */
  readonly holderName: string;
  /** The take-over request is in flight: the button says so and does nothing. */
  readonly inFlight: boolean;
  readonly onConfirm: () => void;
  /** The dialog closed with nothing taken over, by Cancel or Escape. */
  readonly onCancel: () => void;
};

/**
 * Asks before the page is taken from the editor who holds it. A native modal
 * `<dialog>` in the login card's skeleton: Cancel takes the initial focus and
 * Escape closes it with no change.
 */
export function TakeoverDialog(props: TakeoverDialogProps): ReactElement {
  const { open, holderName, inFlight, onConfirm, onCancel } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      element.showModal();
      cancel.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="pk-login"
      aria-labelledby={HEADING_ID}
      data-takeover-dialog=""
      onClose={onCancel}
    >
      <div className="pk-card">
        <h2
          id={HEADING_ID}
          className="m-0 text-heading font-semibold text-text wrap-anywhere"
        >
          {STRINGS['takeover.heading']}
        </h2>
        <p className="m-0 mt-2 text-body text-text wrap-anywhere">
          {formatString('takeover.body', { name: holderName })}
        </p>
        <div className="mt-6 flex gap-2">
          <button
            ref={cancel}
            type="button"
            className={CANCEL}
            onClick={onCancel}
          >
            {STRINGS['takeover.cancel']}
          </button>
          <button
            type="button"
            className={CONFIRM}
            aria-disabled={inFlight}
            onClick={() => {
              if (!inFlight) onConfirm();
            }}
          >
            {inFlight
              ? STRINGS['takeover.inFlight']
              : STRINGS['takeover.confirm']}
          </button>
        </div>
      </div>
    </dialog>
  );
}
