import { useEffect, useRef, useState, type ReactElement } from 'react';
import { expiryState } from '../../client/session/lock-client.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { LockIcon } from '../icons.js';
import { formatString, STRINGS } from '../strings.js';

const BUTTON =
  'h-8 w-fit cursor-pointer rounded-lg border border-control-border bg-surface px-3 text-caption font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-surface';

/** Seconds as `m:ss`. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const rest = whole % 60;
  return `${String(Math.floor(whole / 60))}:${rest < 10 ? '0' : ''}${String(rest)}`;
}

export type LockExpiryProps = {
  readonly store: EditorStore;
  /** Renews the lock now; true when it worked. */
  readonly onKeepEditing: () => Promise<boolean>;
};

/**
 * The own-lock row under the save status. A heartbeat renews the lock for as
 * long as the tab can reach the server, so the row is there only while
 * renewals fail, counting down to the lapse. The countdown text is not live;
 * the live region gets one message at a minute, half a minute and ten seconds.
 */
export function LockExpiry(props: LockExpiryProps): ReactElement | null {
  const { store, onKeepEditing } = props;
  const renewal = useEditorStore(store, (state) => state.renewal);
  const ttl = useEditorStore(
    store,
    (state) => state.session?.limits.lockTtlSeconds ?? 0,
  );
  const failing = renewal?.failing === true;
  const [now, setNow] = useState(() => Date.now());
  const [renewing, setRenewing] = useState(false);
  const [failed, setFailed] = useState(false);
  const announced = useRef<number | null>(null);

  useEffect(() => {
    if (!failing) return undefined;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [failing]);

  const state =
    renewal === null
      ? null
      : expiryState(renewal.lastRenewAt, now, ttl, renewal.failing);

  const reached = state?.announceAt ?? null;
  useEffect(() => {
    if (!failing) {
      announced.current = null;
      return;
    }
    if (reached === null || reached === announced.current) return;
    announced.current = reached;
    store.announce(formatString('lock.expiring', { time: clockText(reached) }));
  }, [failing, reached, store]);

  if (state === null || !state.visible) return null;
  return (
    <div data-lock-expiry="" className="flex flex-col gap-2">
      <div className="flex items-start gap-2 text-body text-attention wrap-anywhere">
        <LockIcon className="mt-1 shrink-0" />
        <span>
          {formatString('lock.expiring', {
            time: clockText(state.remainingSeconds),
          })}
        </span>
      </div>
      <button
        type="button"
        className={BUTTON}
        aria-disabled={renewing}
        onClick={() => {
          if (renewing) return;
          setRenewing(true);
          setFailed(false);
          void onKeepEditing().then((worked) => {
            setRenewing(false);
            setFailed(!worked);
          });
        }}
      >
        {renewing ? STRINGS['lock.renewing'] : STRINGS['lock.keepEditing']}
      </button>
      {failed ? (
        <p role="alert" className="m-0 text-body text-destructive">
          {STRINGS['notice.retryFailed']}
        </p>
      ) : null}
    </div>
  );
}
