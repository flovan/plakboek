import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { formatString, STRINGS } from '../strings.js';

/** How long the toast stays when nobody is pointing at or focused on it. */
const TOAST_MS = 8000;

export type UndoToastProps = {
  readonly store: EditorStore;
  /** The editor chose Undo: the same session undo as the toolbar's. */
  readonly onUndo: () => void;
};

/** One toast: its timer runs while it is neither hovered nor focused. */
function ToastBody(props: {
  readonly store: EditorStore;
  readonly label: string;
  readonly onUndo: () => void;
}): ReactElement {
  const { store, label, onUndo } = props;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(TOAST_MS);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      store.clearToast();
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - startedAt),
      );
    };
  }, [store, paused]);

  const text = formatString('toast.deleted', { label });
  return (
    <div
      role="status"
      className="pk-toast"
      data-toast=""
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <span
        className="min-w-0 flex-1 truncate text-body text-text"
        title={text}
      >
        {text}
      </span>
      <button
        type="button"
        className="h-8 shrink-0 cursor-pointer rounded-lg border border-control-border bg-surface px-3 text-caption font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        onClick={onUndo}
      >
        {STRINGS['toast.undo']}
      </button>
    </div>
  );
}

/**
 * The one undo toast: it names what was deleted and offers Undo for eight
 * seconds, pauses while it is hovered or holds focus, and is replaced by a
 * newer toast. It shows only while the delete it belongs to is still the next
 * undo, so its button can never undo something else.
 */
export function UndoToast(props: UndoToastProps): ReactElement | null {
  const { store, onUndo } = props;
  const toast = useEditorStore(store, (state) => state.toast);
  const current = useEditorStore(
    store,
    (state) =>
      state.toast !== null && state.undo.undo.at(-1) === state.toast.entry,
  );
  if (!current || toast === null) return null;
  return (
    <ToastBody
      key={toast.token}
      store={store}
      label={toast.label}
      onUndo={onUndo}
    />
  );
}

/** How long a status message stays. */
const MESSAGE_MS = 4000;

export type MessageToastProps = { readonly store: EditorStore };

/**
 * A transient status message in the toast's place, such as the note that a
 * paste lost formatting: four seconds, no button, announced politely. It sits
 * above the undo toast if both show.
 */
export function MessageToast(props: MessageToastProps): ReactElement | null {
  const { store } = props;
  const message = useEditorStore(store, (state) => state.message);
  const token = message?.token;
  useEffect(() => {
    if (token === undefined) return undefined;
    const timer = setTimeout(() => {
      store.clearMessage();
    }, MESSAGE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [store, token]);
  if (message === null) return null;
  return (
    <div
      key={message.token}
      role="status"
      className="pk-toast pk-toast-message"
      data-toast-message=""
    >
      <span className="min-w-0 flex-1 text-body text-text">
        {STRINGS[message.key]}
      </span>
    </div>
  );
}
