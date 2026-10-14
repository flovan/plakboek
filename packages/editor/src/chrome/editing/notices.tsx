import { useState, type ReactElement, type ReactNode } from 'react';
import {
  useEditorStore,
  type EditorStore,
  type Notice,
} from '../../client/session/store.js';
import { formatString, STRINGS } from '../strings.js';
import { TakeoverDialog } from './takeover-dialog.js';

const BOX =
  'mb-2 flex shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4';
const HEADING = 'm-0 text-body font-semibold text-text wrap-anywhere';
const BODY = 'm-0 text-body text-text-muted wrap-anywhere';
const BUTTON =
  'flex h-10 w-fit cursor-pointer items-center justify-center rounded-lg px-4 text-body font-semibold no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-60';
const SECONDARY = `${BUTTON} border border-control-border bg-surface text-text hover:bg-surface-muted aria-disabled:hover:bg-surface`;
const PRIMARY = `${BUTTON} border-0 bg-accent text-accent-contrast hover:bg-accent-hover aria-disabled:hover:bg-accent`;

/** The time of day of an ISO timestamp, in the editor's locale. */
export function lastActiveText(iso: string | undefined): string {
  if (iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export type NoticeSlotProps = {
  readonly store: EditorStore;
  /** Takes the page over; true when it worked. */
  readonly onTakeOver: () => Promise<boolean>;
  /** Reloads the shell for the stale notice. */
  readonly onReload: () => void;
  /** Where the session-ended notice's Sign in leads. */
  readonly signInHref: string;
};

function Box(props: {
  readonly role: 'status' | 'alert';
  readonly kind: Notice['kind'];
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div role={props.role} data-notice={props.kind} className={BOX}>
      {props.children}
    </div>
  );
}

/**
 * The banner at the top of the sidebar about the page's state: held by someone
 * else (with Take over for a user whose permissions cover the holder's), just
 * freed, taken over, changed in another tab, or the session ended. It names
 * the holder by display name and last activity only, and draws nothing while
 * the page is simply being edited.
 */
export function NoticeSlot(props: NoticeSlotProps): ReactElement | null {
  const { store, onTakeOver, onReload, signInHref } = props;
  const notice = useEditorStore(store, (state) => state.notice);
  const canTakeOver = useEditorStore(
    store,
    (state) => state.lock?.canTakeOver === true,
  );
  const [confirming, setConfirming] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState(false);
  if (notice === null) return null;
  const name = notice.holderName ?? '';

  switch (notice.kind) {
    case 'locked':
      return (
        <Box role="status" kind="locked">
          <p className={HEADING}>
            {formatString('notice.locked.heading', { name })}
          </p>
          <p className={BODY}>
            {formatString('notice.locked.body', {
              time: lastActiveText(notice.lastActiveAt),
            })}
          </p>
          {canTakeOver ? (
            <button
              type="button"
              className={SECONDARY}
              aria-disabled={inFlight}
              onClick={() => {
                if (inFlight) return;
                setFailed(false);
                setConfirming(true);
              }}
            >
              {inFlight
                ? STRINGS['takeover.inFlight']
                : STRINGS['notice.locked.takeOver']}
            </button>
          ) : null}
          {failed ? (
            <p role="alert" className="m-0 text-body text-destructive">
              {STRINGS['notice.retryFailed']}
            </p>
          ) : null}
          <TakeoverDialog
            open={confirming}
            holderName={name}
            inFlight={inFlight}
            onCancel={() => {
              if (!inFlight) setConfirming(false);
            }}
            onConfirm={() => {
              setInFlight(true);
              void onTakeOver().then((worked) => {
                setInFlight(false);
                setConfirming(false);
                setFailed(!worked);
              });
            }}
          />
        </Box>
      );
    case 'lapsed':
      return (
        <Box role="status" kind="lapsed">
          <p className={HEADING}>{formatString('notice.lapsed', { name })}</p>
        </Box>
      );
    case 'taken-over':
      return (
        <Box role="alert" kind="taken-over">
          <p className={HEADING}>
            {formatString('notice.takenOver.heading', { name })}
          </p>
          <p className={BODY}>{STRINGS['notice.takenOver.body']}</p>
        </Box>
      );
    case 'stale':
      return (
        <Box role="alert" kind="stale">
          <p className={HEADING}>{STRINGS['notice.stale.heading']}</p>
          <p className={BODY}>{STRINGS['notice.stale.body']}</p>
          <button type="button" className={PRIMARY} onClick={onReload}>
            {STRINGS['notice.stale.reload']}
          </button>
        </Box>
      );
    case 'session-ended':
      return (
        <Box role="alert" kind="session-ended">
          <p className={HEADING}>{STRINGS['notice.session.heading']}</p>
          <p className={BODY}>{STRINGS['notice.session.body']}</p>
          <a href={signInHref} className={PRIMARY}>
            {STRINGS['notice.session.signIn']}
          </a>
        </Box>
      );
  }
}
