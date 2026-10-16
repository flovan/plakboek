import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import type { SaveStatus } from '../../client/session/save-queue.js';
import {
  useEditorStore,
  type DrawerOpener,
  type EditorMode,
  type EditorStore,
  type Notice,
} from '../../client/session/store.js';
import { RAIL_CONTROL } from '../controls.js';
import {
  AlertIcon,
  BlocksIcon,
  CheckIcon,
  EditPointerIcon,
  InteractHandIcon,
  LockIcon,
  PropertiesIcon,
  RedoIcon,
  SpinnerIcon,
  UndoIcon,
} from '../icons.js';
import { formatString, STRINGS } from '../strings.js';
import { Tooltip } from '../tooltip.js';
import { closeOnEscape } from './drawer.js';
import { isApplePlatform, useHistoryState } from './tool-group.js';

const HISTORY_CONTROL = `${RAIL_CONTROL} aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-surface`;
const DRAWER_CONTROL = `${RAIL_CONTROL} aria-expanded:bg-surface-muted`;
const STATUS_SQUARE = 'flex h-10 w-10 items-center justify-center';

/** Notices that need the editor's attention more than a plain heads-up. */
function dotClass(notice: Notice | null): string {
  return notice?.kind === 'taken-over' || notice?.kind === 'session-ended'
    ? 'bg-destructive'
    : 'bg-attention';
}

function SaveIndicator(props: {
  readonly status: SaveStatus;
  readonly canRetry: boolean;
  readonly onRetry?: () => void;
}): ReactElement {
  const { status, canRetry, onRetry } = props;
  switch (status) {
    case 'saving':
      return (
        <Tooltip label={STRINGS['save.saving']}>
          <div role="status" className={`${STATUS_SQUARE} text-text-muted`}>
            <SpinnerIcon />
            <span className="sr-only">{STRINGS['save.saving']}</span>
          </div>
        </Tooltip>
      );
    case 'failed':
      return (
        <Tooltip label={STRINGS['save.failed']}>
          <div role="alert" className={`${STATUS_SQUARE} text-destructive`}>
            {canRetry ? (
              <button
                type="button"
                aria-label={`${STRINGS['save.failed']}. ${STRINGS['save.retry']}`}
                onClick={onRetry}
                className={`${RAIL_CONTROL} text-destructive`}
              >
                <AlertIcon />
              </button>
            ) : (
              <>
                <AlertIcon />
                <span className="sr-only">{STRINGS['save.failed']}</span>
              </>
            )}
          </div>
        </Tooltip>
      );
    case 'paused':
      return (
        <Tooltip label={STRINGS['save.paused']}>
          <div role="alert" className={`${STATUS_SQUARE} text-attention`}>
            <AlertIcon />
            <span className="sr-only">{STRINGS['save.paused']}</span>
          </div>
        </Tooltip>
      );
    default:
      return (
        <Tooltip label={STRINGS['save.saved']}>
          <div role="status" className={`${STATUS_SQUARE} text-text-muted`}>
            <CheckIcon />
            <span className="sr-only">{STRINGS['save.saved']}</span>
          </div>
        </Tooltip>
      );
  }
}

export type RailToolsProps = {
  readonly store: EditorStore;
  readonly onMode: (mode: EditorMode) => void;
  readonly onRetry?: () => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  /** Opens the drawer for a button; the shell decides whether the frame has room. */
  readonly onOpenDrawer: (opener: DrawerOpener) => void;
};

/**
 * The editing tools of the full-width rail, as 40px icon buttons with
 * tooltips: the mode button, Undo, Redo, the save status, and Page structure
 * and Properties, which open the panel drawer. A page this tab is not editing has
 * no tools; if it has a notice, one button opens the drawer to read it. A dot
 * on the Properties (or that) button marks a notice nobody has opened the
 * drawer to read.
 */
export function RailTools(props: RailToolsProps): ReactElement | null {
  const { store, onMode, onRetry, onUndo, onRedo, onOpenDrawer } = props;
  const editing = useEditorStore(store, (state) => state.status === 'editing');
  const mode = useEditorStore(store, (state) => state.mode);
  const saveStatus = useEditorStore(store, (state) => state.queue.status);
  const canRetry = useEditorStore(
    store,
    (state) => state.queue.lastFailure === 'network',
  );
  const drawer = useEditorStore(store, (state) => state.drawer);
  const notice = useEditorStore(store, (state) => state.notice);
  const noticeSeen = useEditorStore(store, (state) => state.noticeSeen);
  const expiring = useEditorStore(
    store,
    (state) => state.renewal?.failing === true,
  );
  const history = useHistoryState(store);
  const unread = (notice !== null && notice !== noticeSeen) || expiring;

  if (!editing && notice === null) return null;

  const modifier = isApplePlatform() ? 'Meta' : 'Control';
  const reason = STRINGS['toolbar.reason.noDeletePermission'];
  const undoActs = history.canUndo && !history.undoNeedsDelete;
  const redoActs = history.canRedo && !history.redoNeedsDelete;

  const dotted = (
    opener: DrawerOpener,
    label: string,
    icon: ReactNode,
    marked: boolean,
  ): ReactElement => (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={marked ? formatString('rail.withNotice', { label }) : label}
        aria-expanded={drawer === opener}
        data-rail-button={opener}
        onClick={() => {
          if (drawer === opener) store.closeDrawer();
          else onOpenDrawer(opener);
        }}
        className={DRAWER_CONTROL}
      >
        {icon}
      </button>
      {marked ? (
        <span
          aria-hidden="true"
          data-rail-dot=""
          className={`pointer-events-none absolute top-1 right-1 size-2 rounded-full ${dotClass(notice)}`}
        />
      ) : null}
    </Tooltip>
  );

  return (
    <div
      data-rail-tools=""
      className="flex shrink-0 flex-col items-center gap-2 border-b border-border pb-2"
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        closeOnEscape(store, event);
      }}
    >
      {editing ? (
        <>
          <Tooltip label={STRINGS['tools.mode.railTooltip']}>
            <button
              type="button"
              aria-label={STRINGS['tools.mode.railLabel']}
              aria-pressed={mode === 'interact'}
              aria-keyshortcuts="I"
              data-rail-button="mode"
              onClick={() => {
                onMode(mode === 'interact' ? 'edit' : 'interact');
              }}
              className={RAIL_CONTROL}
            >
              {mode === 'interact' ? <InteractHandIcon /> : <EditPointerIcon />}
            </button>
          </Tooltip>
          <Tooltip
            label={
              history.canUndo && history.undoNeedsDelete
                ? reason
                : STRINGS['tools.undo']
            }
          >
            <button
              type="button"
              aria-label={STRINGS['tools.undo']}
              aria-disabled={!undoActs}
              aria-keyshortcuts={`${modifier}+Z`}
              onClick={() => {
                if (undoActs) onUndo?.();
              }}
              className={HISTORY_CONTROL}
            >
              <UndoIcon />
            </button>
          </Tooltip>
          <Tooltip
            label={
              history.canRedo && history.redoNeedsDelete
                ? reason
                : STRINGS['tools.redo']
            }
          >
            <button
              type="button"
              aria-label={STRINGS['tools.redo']}
              aria-disabled={!redoActs}
              aria-keyshortcuts={`${modifier}+Shift+Z`}
              onClick={() => {
                if (redoActs) onRedo?.();
              }}
              className={HISTORY_CONTROL}
            >
              <RedoIcon />
            </button>
          </Tooltip>
          <SaveIndicator
            status={saveStatus}
            canRetry={canRetry}
            onRetry={onRetry}
          />
          {dotted(
            'structure',
            STRINGS['rail.structure'],
            <BlocksIcon />,
            false,
          )}
          {dotted(
            'properties',
            STRINGS['rail.properties'],
            <PropertiesIcon />,
            unread,
          )}
        </>
      ) : (
        dotted('notice', STRINGS['rail.notice'], <LockIcon />, unread)
      )}
    </div>
  );
}
