import { useEffect, useRef, type ReactElement } from 'react';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { STRINGS } from '../strings.js';

const HEADING_ID = 'plakboek-leave-heading';

const BUTTON =
  'flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-lg px-4 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const STAY = `${BUTTON} border border-control-border bg-surface text-text hover:bg-surface-muted`;
const LEAVE = `${BUTTON} border-0 bg-destructive text-destructive-contrast hover:opacity-90`;

export type LeaveDialogProps = {
  readonly store: EditorStore;
  /** The editor chose to stay: the dialog closed with nothing left. */
  readonly onStay: () => void;
  /** The editor chose to leave with the unsaved changes. */
  readonly onLeave: () => void;
};

/**
 * Asks whether to leave when the changes could not be saved first. A native
 * modal `<dialog>` in the login card's skeleton: Stay takes the initial focus
 * and Escape counts as Stay. It draws nothing until a leave is waiting.
 */
export function LeaveDialog(props: LeaveDialogProps): ReactElement | null {
  const { store, onStay, onLeave } = props;
  const waiting = useEditorStore(store, (state) => state.leaveRequest !== null);
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!waiting) return;
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
    stay.current?.focus();
  }, [waiting]);

  if (!waiting) return null;
  return (
    <dialog
      ref={dialog}
      className="pk-login"
      aria-labelledby={HEADING_ID}
      data-leave-dialog=""
      onClose={onStay}
    >
      <div className="pk-card">
        <h2
          id={HEADING_ID}
          className="m-0 text-heading font-semibold text-text wrap-anywhere"
        >
          {STRINGS['leave.heading']}
        </h2>
        <p className="m-0 mt-2 text-body text-text wrap-anywhere">
          {STRINGS['leave.body']}
        </p>
        <div className="mt-6 flex gap-2">
          <button ref={stay} type="button" className={STAY} onClick={onStay}>
            {STRINGS['leave.stay']}
          </button>
          <button type="button" className={LEAVE} onClick={onLeave}>
            {STRINGS['leave.confirm']}
          </button>
        </div>
      </div>
    </dialog>
  );
}
