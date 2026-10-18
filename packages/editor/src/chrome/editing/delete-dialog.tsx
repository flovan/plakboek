import { useEffect, useRef, type ReactElement } from 'react';
import {
  deleteImpact,
  itemText,
} from '../../client/session/structure-actions.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { formatString, STRINGS } from '../strings.js';

const HEADING_ID = 'plakboek-delete-heading';

const BUTTON =
  'flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-lg px-4 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const CANCEL = `${BUTTON} border border-control-border bg-surface text-text hover:bg-surface-muted`;
const CONFIRM = `${BUTTON} border-0 bg-destructive text-destructive-contrast hover:opacity-90`;

export type DeleteDialogProps = {
  readonly store: EditorStore;
  /** The editor chose to delete the item. */
  readonly onConfirm: (id: string) => void;
  /** The dialog closed with nothing deleted, by Cancel or Escape. */
  readonly onCancel: () => void;
};

/**
 * Asks before an item that holds blocks is deleted, saying how many go with it.
 * A native modal `<dialog>` in the login card's skeleton: it is also the scrim,
 * Cancel takes the initial focus, and Escape closes it with no change. It
 * draws nothing while no delete is waiting.
 */
export function DeleteDialog(props: DeleteDialogProps): ReactElement | null {
  const { store, onConfirm, onCancel } = props;
  const state = useEditorStore(store, (current) => current);
  const request = state.deleteRequest;
  const node = request === null ? undefined : state.model?.get(request.id);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const open = request !== null && node !== undefined;

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
    cancel.current?.focus();
  }, [open]);

  // The item went away under the dialog (another write): nothing is left to ask about.
  useEffect(() => {
    if (request !== null && node === undefined) onCancel();
  }, [request, node, onCancel]);

  if (request === null || node === undefined || state.model === null) {
    return null;
  }
  const count = deleteImpact(state.model, node.id);
  const kind =
    node.kind === 'section'
      ? STRINGS['kind.section']
      : node.kind === 'column'
        ? STRINGS['kind.column']
        : itemText(state, node.id).toLowerCase();
  return (
    <dialog
      ref={dialog}
      className="pk-login"
      aria-labelledby={HEADING_ID}
      data-delete-dialog=""
      onClose={onCancel}
    >
      <div className="pk-card">
        <h2
          id={HEADING_ID}
          className="m-0 text-heading font-semibold text-text wrap-anywhere"
        >
          {formatString('delete.heading', { kind })}
        </h2>
        <p className="m-0 mt-2 text-body text-text wrap-anywhere">
          {count === 1
            ? STRINGS['delete.body.one']
            : formatString('delete.body.other', { count: String(count) })}
        </p>
        <p className="m-0 mt-1 text-body text-text-muted wrap-anywhere">
          {STRINGS['delete.note']}
        </p>
        <div className="mt-6 flex gap-2">
          <button
            ref={cancel}
            type="button"
            className={CANCEL}
            onClick={onCancel}
          >
            {STRINGS['delete.cancel']}
          </button>
          <button
            type="button"
            className={CONFIRM}
            onClick={() => {
              onConfirm(node.id);
            }}
          >
            {formatString('delete.confirm', { kind })}
          </button>
        </div>
      </div>
    </dialog>
  );
}
