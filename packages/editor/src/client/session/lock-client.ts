/**
 * Keeps this tab's hold on the page while the editor works.
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
 * tick.
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
  /** The document whose visibility and page lifecycle are followed. */
  readonly document?: Document;
  /** The request that releases the lock when the page goes away. */
  readonly sendRelease?: (url: string) => void;
};

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

/** Starts the heartbeat. Returns the function that stops it. */
export function startLockClient(options: LockClientOptions): () => void {
  const { api, pageId, heartbeatSeconds, onLock, onLost } = options;
  const doc = options.document ?? document;
  const view = doc.defaultView;
  const sendRelease = options.sendRelease ?? releaseWithKeepalive;

  let stopped = false;
  let running = false;

  async function lostView(error: ApiRequestError): Promise<LockView | null> {
    if (error.lock !== undefined) return error.lock;
    try {
      return (await api.lock(pageId)).lock;
    } catch {
      return null;
    }
  }

  async function renew(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      let answer = await api.lockAction(pageId, 'renew');
      // Nobody holds the page any more: take it again.
      if (answer.lock.enabled && answer.lock.state === 'free') {
        answer = await api.lockAction(pageId, 'acquire');
      }
      if (!stopped) onLock(answer.lock);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 423) {
        const held = await lostView(error);
        if (held !== null && !stopped) {
          stop();
          onLost(held);
        }
      }
    } finally {
      running = false;
    }
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
  return stop;
}
