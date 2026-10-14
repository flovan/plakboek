import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockResponse, LockView } from '../../src/api-types.js';
import { ApiRequestError } from '../../src/client/session/api-client.js';
import {
  expiryState,
  isFreeToOpen,
  startLockClient,
  startLockWatch,
} from '../../src/client/session/lock-client.js';

const view = (state: LockView['state']): LockView => ({
  enabled: true,
  state,
  holder: null,
  canTakeOver: false,
  expiresAt: null,
});
const answer = (state: LockView['state']): LockResponse => ({
  ok: true,
  lock: view(state),
});

/** A document stand-in that records the listeners and lets a test fire them. */
function fakeDocument() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const addEventListener = (
    type: string,
    listener: (event: Event) => void,
  ): void => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  const removeEventListener = (
    type: string,
    listener: (event: Event) => void,
  ): void => {
    listeners.get(type)?.delete(listener);
  };
  const doc = {
    visibilityState: 'visible',
    addEventListener,
    removeEventListener,
    defaultView: { addEventListener, removeEventListener },
  } as unknown as Document;
  const fire = (type: string, event: object = {}): void => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event as Event);
    }
  };
  return { doc, fire, count: (type: string) => listeners.get(type)?.size ?? 0 };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startLockClient', () => {
  it('renews on every heartbeat and reports each answer', async () => {
    const lockAction = vi.fn().mockResolvedValue(answer('mine'));
    const onLock = vi.fn();
    const { doc } = fakeDocument();
    const stop = startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock,
      onLost: vi.fn(),
      document: doc,
      sendRelease: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lockAction).toHaveBeenCalledTimes(2);
    expect(lockAction).toHaveBeenCalledWith('p1', 'renew');
    expect(onLock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lockAction).toHaveBeenCalledTimes(2);
  });

  it('renews at once when the tab becomes visible', async () => {
    const lockAction = vi.fn().mockResolvedValue(answer('mine'));
    const { doc, fire } = fakeDocument();
    startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock: vi.fn(),
      onLost: vi.fn(),
      document: doc,
      sendRelease: vi.fn(),
    });
    fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(lockAction).toHaveBeenCalledWith('p1', 'renew');
  });

  it('takes the page again when a renew finds nobody holding it', async () => {
    const lockAction = vi
      .fn()
      .mockResolvedValueOnce(answer('free'))
      .mockResolvedValueOnce(answer('mine'));
    const onLock = vi.fn();
    const { doc } = fakeDocument();
    startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock,
      onLost: vi.fn(),
      document: doc,
      sendRelease: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lockAction.mock.calls.map((call) => call[1])).toEqual([
      'renew',
      'acquire',
    ]);
    expect(onLock).toHaveBeenCalledWith(view('mine'));
  });

  it('reports the loss once and stops when someone else holds the page', async () => {
    const held = view('other');
    const lockAction = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(423, 'locked', held));
    const onLost = vi.fn();
    const { doc, count } = fakeDocument();
    startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock: vi.fn(),
      onLost,
      document: doc,
      sendRelease: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith(held);
    expect(lockAction).toHaveBeenCalledTimes(1);
    expect(count('visibilitychange')).toBe(0);
  });

  it('tries again on the next beat after a network failure', async () => {
    const lockAction = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(null, null))
      .mockResolvedValueOnce(answer('mine'));
    const onLost = vi.fn();
    const onLock = vi.fn();
    const { doc } = fakeDocument();
    startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock,
      onLost,
      document: doc,
      sendRelease: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLost).not.toHaveBeenCalled();
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the page goes away', () => {
    const sendRelease = vi.fn();
    const { doc, fire } = fakeDocument();
    startLockClient({
      api: { lock: vi.fn(), lockAction: vi.fn() },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock: vi.fn(),
      onLost: vi.fn(),
      document: doc,
      sendRelease,
    });
    fire('pagehide');
    expect(sendRelease).toHaveBeenCalledWith('/cms/api/pages/p1/lock/release');
  });
});

describe('renewals that fail', () => {
  it('reports failing renewals, then recovery, and renews on request', async () => {
    const lockAction = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(null, null))
      .mockResolvedValue(answer('mine'));
    const onRenewState = vi.fn();
    const { doc } = fakeDocument();
    let clock = 1_000;
    const client = startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock: vi.fn(),
      onLost: vi.fn(),
      onRenewState,
      now: () => clock,
      document: doc,
      sendRelease: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onRenewState).toHaveBeenLastCalledWith({
      failing: true,
      lastRenewAt: 1_000,
    });
    clock = 61_000;
    expect(await client.renew()).toBe(true);
    expect(onRenewState).toHaveBeenLastCalledWith({
      failing: false,
      lastRenewAt: 61_000,
    });
    client();
  });

  it('ends the heartbeat and reports the session when the answer is a 401', async () => {
    const lockAction = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(401, null));
    const onSessionEnded = vi.fn();
    const { doc } = fakeDocument();
    startLockClient({
      api: { lock: vi.fn(), lockAction },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onLock: vi.fn(),
      onLost: vi.fn(),
      onSessionEnded,
      document: doc,
      sendRelease: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(lockAction).toHaveBeenCalledTimes(1);
  });
});

describe('expiryState', () => {
  const ttl = 120;
  const at = (seconds: number, failing = true) =>
    expiryState(0, seconds * 1000, ttl, failing);

  it('is not shown while renewals work', () => {
    expect(at(100, false)).toEqual({
      visible: false,
      remainingSeconds: 20,
      announceAt: null,
    });
  });

  it('counts down from the last successful renewal while they fail', () => {
    expect(at(0)).toMatchObject({ visible: true, remainingSeconds: 120 });
    expect(at(90.5)).toMatchObject({ visible: true, remainingSeconds: 30 });
    expect(at(200)).toMatchObject({ visible: true, remainingSeconds: 0 });
  });

  it('names the announcement moment the countdown has reached', () => {
    expect(at(30).announceAt).toBeNull();
    expect(at(60).announceAt).toBe(60);
    expect(at(80).announceAt).toBe(60);
    expect(at(90).announceAt).toBe(30);
    expect(at(110).announceAt).toBe(10);
    expect(at(130).announceAt).toBe(10);
  });
});

describe('startLockWatch', () => {
  const held = { ...view('other'), holder: { name: 'A', lastActiveAt: 'x' } };

  it('treats anything but another editor holding the page as free', () => {
    expect(isFreeToOpen(view('other'))).toBe(false);
    expect(isFreeToOpen(view('free'))).toBe(true);
    expect(isFreeToOpen(view('mine'))).toBe(true);
  });

  it('reads the lock each beat and reports the first free view once', async () => {
    const lock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, lock: held })
      .mockResolvedValueOnce({ ok: true, lock: view('free') });
    const onHeld = vi.fn();
    const onFree = vi.fn();
    startLockWatch({
      api: { lock },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onHeld,
      onFree,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onHeld).toHaveBeenCalledWith(held);
    expect(onFree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onFree).toHaveBeenCalledWith(view('free'));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(onFree).toHaveBeenCalledTimes(1);
  });

  it('keeps watching after a failed read', async () => {
    const lock = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(null, null))
      .mockResolvedValueOnce({ ok: true, lock: view('free') });
    const onFree = vi.fn();
    startLockWatch({
      api: { lock },
      pageId: 'p1',
      heartbeatSeconds: 30,
      onHeld: vi.fn(),
      onFree,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFree).toHaveBeenCalledTimes(1);
  });
});
