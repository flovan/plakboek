/**
 * Keeps this tab's hold on the page while the editor works, and watches a page
 * someone else holds until it is free.
 *
 * The lock is renewed every heartbeat interval and again the moment the tab
 * becomes visible (a hidden tab's timers are throttled, so its lock may have
 * lapsed meanwhile). A renew that finds nobody holding the page takes it
 * again; a renew refused because someone else holds it ends the heartbeat and
 * reports the loss. When the page goes away the lock is released with a
 * request that outlives it.
 *
 * One request runs at a time: a tick that arrives while the last is still
 * unanswered is skipped, so a slow server is never hit by a pile of renewals.
 * A renew that fails for any other reason is simply tried again on the next
 * tick, and the client reports that renewals are failing so the chrome can
 * count down to the lapse; a 401 ends the heartbeat and reports the ended
 * session. `renew` lets the editor ask for a renewal now.
 *
 * `startLockWatch` is the other side: while another editor holds the page it
 * reads the lock once per heartbeat interval and reports the moment the page
 * is free.
 */
import { EDITOR_API_BASE, type LockView } from '../../api-types.js';
import { ApiRequestError, type ApiClient } from './api-client.js';

export type LockClientOptions = {
  readonly api: Pick<ApiClient, 'lock' | 'lockAction'>;
  readonly pageId: string;
  readonly heartbeatSeconds: number;
  /** Called with every view the server answers with. */
  readonly onLock: (view: LockView) => void;
  /** Called once when another editor holds the page. */
  readonly onLost: (view: LockView) => void;
  /** Called when renewals start or stop failing, with when one last worked. */
  readonly onRenewState?: (state: RenewState) => void;
  /** Called once when the session is over (a 401), and the heartbeat ends. */
  readonly onSessionEnded?: () => void;
  /** The clock, in milliseconds. */
  readonly now?: () => number;
  /** The document whose visibility and page lifecycle are followed. */
  readonly document?: Document;
  /** The request that releases the lock when the page goes away. */
  readonly sendRelease?: (url: string) => void;
};

/** Whether renewals are failing, and when one last succeeded (milliseconds). */
export type RenewState = {
  readonly failing: boolean;
  readonly lastRenewAt: number;
};

/** How long the editor has left before its lock lapses, and when to say so. */
export type ExpiryState = {
  readonly visible: boolean;
  readonly remainingSeconds: number;
  /** The announcement threshold the countdown has reached, if any. */
  readonly announceAt: 60 | 30 | 10 | null;
};

const ANNOUNCE_AT = [60, 30, 10] as const;

/**
 * What the own-lock row shows. A heartbeat renews the lock indefinitely, so the
 * row is there only while renewals fail, and counts down from the last renewal
 * that worked against the lock's lifetime. `announceAt` is the smallest of the
 * announcement moments (a minute, half a minute, ten seconds) the countdown has
 * reached, so a coarse tick never skips one.
 */
export function expiryState(
  lastSuccessfulRenew: number,
  now: number,
  ttlSeconds: number,
  renewFailing: boolean,
): ExpiryState {
  const remainingSeconds = Math.max(
    0,
    Math.ceil(ttlSeconds - (now - lastSuccessfulRenew) / 1000),
  );
  if (!renewFailing) {
    return { visible: false, remainingSeconds, announceAt: null };
  }
  const announceAt =
    ANNOUNCE_AT.toReversed().find((moment) => remainingSeconds <= moment) ??
    null;
  return { visible: true, remainingSeconds, announceAt };
}

/** The event a tab fires when it is hidden or shown. */
const VISIBILITY_EVENT = 'visibilitychange';

function releaseWithKeepalive(url: string): void {
  void fetch(url, {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => undefined);
}

/** The heartbeat's stop function, with the means to renew at once. */
export type LockClientHandle = (() => void) & {
  /** Renews now; true when the lock was renewed (or taken again). */
  readonly renew: () => Promise<boolean>;
};

/** Starts the heartbeat. Returns the function that stops it. */
export function startLockClient(options: LockClientOptions): LockClientHandle {
  const { api, pageId, heartbeatSeconds, onLock, onLost } = options;
  const doc = options.document ?? document;
  const view = doc.defaultView;
  const sendRelease = options.sendRelease ?? releaseWithKeepalive;
  const now = options.now ?? Date.now;

  let stopped = false;
  let inFlight: Promise<boolean> | null = null;
  let lastRenewAt = now();
  let failing = false;

  async function lostView(error: ApiRequestError): Promise<LockView | null> {
    if (error.lock !== undefined) return error.lock;
    try {
      return (await api.lock(pageId)).lock;
    } catch {
      return null;
    }
  }

  function reportRenewState(next: boolean): void {
    if (next === failing) return;
    failing = next;
    options.onRenewState?.({ failing, lastRenewAt });
  }

  async function attempt(): Promise<boolean> {
    try {
      let answer = await api.lockAction(pageId, 'renew');
      // Nobody holds the page any more: take it again.
      if (answer.lock.enabled && answer.lock.state === 'free') {
        answer = await api.lockAction(pageId, 'acquire');
      }
      lastRenewAt = now();
      if (stopped) return true;
      reportRenewState(false);
      onLock(answer.lock);
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 423) {
        const held = await lostView(error);
        if (held !== null && !stopped) {
          stop();
          onLost(held);
        }
        return false;
      }
      if (error instanceof ApiRequestError && error.status === 401) {
        if (!stopped) {
          stop();
          options.onSessionEnded?.();
        }
        return false;
      }
      if (!stopped) reportRenewState(true);
      return false;
    }
  }

  /** One request runs at a time; a caller that arrives meanwhile shares its answer. */
  function renew(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (inFlight !== null) return inFlight;
    const run = attempt().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  }

  const timer = globalThis.setInterval(() => {
    void renew();
  }, heartbeatSeconds * 1000);

  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') void renew();
  };
  // A page restored from the back/forward cache may have lost its lock.
  const onShow = (event: Event): void => {
    if (Reflect.get(event, 'persisted') === true) void renew();
  };
  const onHide = (): void => {
    sendRelease(
      `${EDITOR_API_BASE}/pages/${encodeURIComponent(pageId)}/lock/release`,
    );
  };

  doc.addEventListener(VISIBILITY_EVENT, onVisibility);
  view?.addEventListener('pageshow', onShow);
  view?.addEventListener('pagehide', onHide);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    globalThis.clearInterval(timer);
    doc.removeEventListener(VISIBILITY_EVENT, onVisibility);
    view?.removeEventListener('pageshow', onShow);
    view?.removeEventListener('pagehide', onHide);
  }
  return Object.assign(stop, { renew });
}

export type LockWatchOptions = {
  readonly api: Pick<ApiClient, 'lock'>;
  readonly pageId: string;
  readonly heartbeatSeconds: number;
  /** Called with every view that still shows another editor holding the page. */
  readonly onHeld: (view: LockView) => void;
  /** Called once with the first view that no longer shows another editor; the watch ends. */
  readonly onFree: (view: LockView) => void;
  /** Called once when the session is over (a 401); the watch ends. */
  readonly onSessionEnded?: () => void;
};

/** Whether a polled view means the page can be opened for editing now. */
export function isFreeToOpen(view: LockView): boolean {
  return view.state !== 'other';
}

/**
 * Reads the lock once per heartbeat interval while another editor holds the
 * page, and reports the first view that is free (released or lapsed). One read
 * runs at a time; a failed read is simply repeated on the next beat. Returns
 * the function that stops the watch.
 */
export function startLockWatch(options: LockWatchOptions): () => void {
  const { api, pageId, heartbeatSeconds } = options;
  let stopped = false;
  let running = false;

  async function poll(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const { lock } = await api.lock(pageId);
      if (stopped) return;
      if (isFreeToOpen(lock)) {
        stop();
        options.onFree(lock);
      } else {
        options.onHeld(lock);
      }
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status === 401 &&
        !stopped
      ) {
        stop();
        options.onSessionEnded?.();
      }
    } finally {
      running = false;
    }
  }

  const timer = globalThis.setInterval(() => {
    void poll();
  }, heartbeatSeconds * 1000);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    globalThis.clearInterval(timer);
  }
  return stop;
}
