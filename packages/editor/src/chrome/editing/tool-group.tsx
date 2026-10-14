import {
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useEditorStore,
  type EditorMode,
  type EditorStore,
} from '../../client/session/store.js';
import type { SaveStatus } from '../../client/session/save-queue.js';
import {
  AlertIcon,
  CheckIcon,
  EditPointerIcon,
  InteractHandIcon,
  RedoIcon,
  SpinnerIcon,
  UndoIcon,
} from '../icons.js';
import { STRINGS } from '../strings.js';

const SEGMENT =
  'flex h-10 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 border-0 bg-surface px-3 text-body font-semibold text-text -outline-offset-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-checked:bg-text aria-checked:text-surface aria-checked:hover:bg-text';

const SMALL_BUTTON =
  'h-8 w-fit cursor-pointer rounded-lg border border-control-border bg-surface px-3 text-caption font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const MODES: readonly EditorMode[] = ['edit', 'interact'];

function ModeToggle(props: {
  readonly mode: EditorMode;
  readonly onMode: (mode: EditorMode) => void;
}): ReactElement {
  const { mode, onMode } = props;
  const segments = useRef(new Map<EditorMode, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLElement>): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next =
      MODES[(MODES.indexOf(mode) + step + MODES.length) % MODES.length];
    if (next === undefined) return;
    onMode(next);
    segments.current.get(next)?.focus();
  };

  const segment = (
    value: EditorMode,
    label: string,
    icon: ReactNode,
    divider: boolean,
  ): ReactElement => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      tabIndex={mode === value ? 0 : -1}
      ref={(element) => {
        if (element === null) segments.current.delete(value);
        else segments.current.set(value, element);
      }}
      onClick={() => {
        onMode(value);
      }}
      className={
        divider ? `${SEGMENT} border-l border-control-border` : SEGMENT
      }
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-1">
      <div
        role="radiogroup"
        aria-label={STRINGS['tools.mode.label']}
        aria-keyshortcuts="I"
        onKeyDown={move}
        className="flex h-10 w-full overflow-hidden rounded-lg border border-control-border"
      >
        {segment(
          'edit',
          STRINGS['tools.mode.edit'],
          <EditPointerIcon />,
          false,
        )}
        {segment(
          'interact',
          STRINGS['tools.mode.interact'],
          <InteractHandIcon />,
          true,
        )}
      </div>
      {mode === 'interact' ? (
        <p className="m-0 text-body text-text-muted wrap-anywhere">
          {STRINGS['tools.mode.interactHint']}
        </p>
      ) : null}
    </div>
  );
}

const HISTORY_BUTTON =
  'flex h-10 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-surface';

/** Whether Command, not Control, is the platform's shortcut key. */
function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

function HistoryRow(props: {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
}): ReactElement {
  const { canUndo, canRedo, onUndo, onRedo } = props;
  const modifier = isApplePlatform() ? 'Meta' : 'Control';
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className={HISTORY_BUTTON}
        aria-disabled={!canUndo}
        aria-keyshortcuts={`${modifier}+Z`}
        onClick={() => {
          if (canUndo) onUndo?.();
        }}
      >
        <UndoIcon />
        {STRINGS['tools.undo']}
      </button>
      <button
        type="button"
        className={HISTORY_BUTTON}
        aria-disabled={!canRedo}
        aria-keyshortcuts={`${modifier}+Shift+Z`}
        onClick={() => {
          if (canRedo) onRedo?.();
        }}
      >
        <RedoIcon />
        {STRINGS['tools.redo']}
      </button>
    </div>
  );
}

function SaveRow(props: {
  readonly status: SaveStatus;
  /** A refused write cannot be sent again, so only a network failure offers Retry. */
  readonly canRetry: boolean;
  readonly onRetry?: () => void;
}): ReactElement {
  const { status, canRetry, onRetry } = props;
  const row = 'flex items-start gap-2 text-body wrap-anywhere';
  const icon = 'mt-1 shrink-0';
  switch (status) {
    case 'saving':
      return (
        <div role="status" className={`${row} text-text-muted`}>
          <SpinnerIcon className={icon} />
          <span>{STRINGS['save.saving']}</span>
        </div>
      );
    case 'failed':
      return (
        <div role="alert" className="flex flex-col gap-2">
          <div className={`${row} text-destructive`}>
            <AlertIcon className={icon} />
            <span>{STRINGS['save.failed']}</span>
          </div>
          {canRetry ? (
            <button type="button" onClick={onRetry} className={SMALL_BUTTON}>
              {STRINGS['save.retry']}
            </button>
          ) : null}
        </div>
      );
    case 'paused':
      return (
        <div role="alert" className={`${row} text-attention`}>
          <AlertIcon className={icon} />
          <span>{STRINGS['save.paused']}</span>
        </div>
      );
    default:
      return (
        <div role="status" className={`${row} text-text-muted`}>
          <CheckIcon className={icon} />
          <span>{STRINGS['save.saved']}</span>
        </div>
      );
  }
}

/**
 * The editing tools of the sidebar: the Edit and Interact toggle with its
 * hint, and the save status. It draws nothing unless this tab is editing the
 * page, so a read-only or locked shell has no tool group.
 */
export function ToolGroup(props: {
  readonly store: EditorStore;
  readonly onMode: (mode: EditorMode) => void;
  readonly onRetry?: () => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
}): ReactElement | null {
  const { store, onMode, onRetry, onUndo, onRedo } = props;
  const editing = useEditorStore(store, (state) => state.status === 'editing');
  const mode = useEditorStore(store, (state) => state.mode);
  const saveStatus = useEditorStore(store, (state) => state.queue.status);
  const canRetry = useEditorStore(
    store,
    (state) => state.queue.lastFailure === 'network',
  );
  const canUndo = useEditorStore(store, (state) => state.undo.undo.length > 0);
  const canRedo = useEditorStore(store, (state) => state.undo.redo.length > 0);
  if (!editing) return null;
  return (
    <div
      data-tools=""
      className="mb-4 flex shrink-0 flex-col gap-2 border-b border-border pb-4"
    >
      <ModeToggle mode={mode} onMode={onMode} />
      <HistoryRow
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
      />
      <SaveRow status={saveStatus} canRetry={canRetry} onRetry={onRetry} />
    </div>
  );
}
