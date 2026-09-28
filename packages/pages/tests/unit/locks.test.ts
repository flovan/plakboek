/**
 * The page+locale edit lock's pure arithmetic (04-14-PLAN.md Task 1) -- no
 * database. `isPageLockLive`'s liveness boundary, `assertPageWritable`'s
 * four cases, and the constants matching `@plakboek/content`'s entry lock
 * exactly (D-39: the mechanism is reused unchanged).
 */
import {
  EDIT_LOCK_HEARTBEAT_SECONDS as ENTRY_EDIT_LOCK_HEARTBEAT_SECONDS,
  EDIT_LOCK_TTL_SECONDS as ENTRY_EDIT_LOCK_TTL_SECONDS,
} from '@plakboek/content';
import { describe, expect, it } from 'vitest';
import {
  assertPageWritable,
  isPageLockLive,
  PAGE_EDIT_LOCK_HEARTBEAT_SECONDS,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  PageLockedError,
} from '../../src/locks.js';

describe('PAGE_EDIT_LOCK_HEARTBEAT_SECONDS / PAGE_EDIT_LOCK_TTL_SECONDS (D-39)', () => {
  it('is 30 / 120, matching @plakboek/content exactly', () => {
    expect(PAGE_EDIT_LOCK_HEARTBEAT_SECONDS).toBe(30);
    expect(PAGE_EDIT_LOCK_TTL_SECONDS).toBe(120);
  });

  it('never drifts from the entry lock constants @plakboek/content exports', () => {
    expect(PAGE_EDIT_LOCK_HEARTBEAT_SECONDS).toBe(
      ENTRY_EDIT_LOCK_HEARTBEAT_SECONDS,
    );
    expect(PAGE_EDIT_LOCK_TTL_SECONDS).toBe(ENTRY_EDIT_LOCK_TTL_SECONDS);
  });
});

describe('isPageLockLive (D-43 lapse arithmetic, at page+locale granularity)', () => {
  it('is live 119999ms after lockedAt', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(lockedAt.getTime() + 119_999);
    expect(isPageLockLive('u1', lockedAt, now)).toBe(true);
  });

  it('is not live exactly 120000ms after lockedAt', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(lockedAt.getTime() + 120_000);
    expect(isPageLockLive('u1', lockedAt, now)).toBe(false);
  });

  it('is live at exactly 0ms (just locked)', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    expect(isPageLockLive('u1', lockedAt, lockedAt)).toBe(true);
  });

  it('a null holder is never live, whatever lockedAt/now are', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    expect(isPageLockLive(null, lockedAt, lockedAt)).toBe(false);
    expect(isPageLockLive(null, null, lockedAt)).toBe(false);
  });

  it('a non-null holder with a null lockedAt is never live', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isPageLockLive('u1', null, now)).toBe(false);
  });
});

describe('assertPageWritable (the write guard, no database)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const lapsedAt = new Date(
    now.getTime() - (PAGE_EDIT_LOCK_TTL_SECONDS + 1) * 1000,
  );
  const liveAt = new Date(now.getTime() - 1000);

  it('is a no-op when pageEditLocking is off, even with a live-looking lock held by someone else', () => {
    const rows = [
      { id: 'p1', locale: 'en', lockedBy: 'other-user', lockedAt: liveAt },
    ];
    expect(() => assertPageWritable(rows, false, 'actor', now)).not.toThrow();
  });

  it('is a no-op when the actor themselves holds the live lock', () => {
    const rows = [
      { id: 'p1', locale: 'en', lockedBy: 'actor', lockedAt: liveAt },
    ];
    expect(() => assertPageWritable(rows, true, 'actor', now)).not.toThrow();
  });

  it('throws PageLockedError, naming the page id/locale/holder, when another user holds a live lock', () => {
    const rows = [
      { id: 'p1', locale: 'en', lockedBy: 'other-user', lockedAt: liveAt },
    ];
    let caught: unknown;
    try {
      assertPageWritable(rows, true, 'actor', now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PageLockedError);
    expect(caught).toMatchObject({
      pageId: 'p1',
      locale: 'en',
      holderUserId: 'other-user',
    });
  });

  it('is a no-op for a lapsed lock, even one held by someone else', () => {
    const rows = [
      { id: 'p1', locale: 'en', lockedBy: 'other-user', lockedAt: lapsedAt },
    ];
    expect(() => assertPageWritable(rows, true, 'actor', now)).not.toThrow();
  });

  it('refuses on the first offending row in a multi-row list, checking in order', () => {
    const rows = [
      { id: 'p1', locale: 'en', lockedBy: null, lockedAt: null },
      { id: 'p2', locale: 'en', lockedBy: 'other-user', lockedAt: liveAt },
      { id: 'p3', locale: 'en', lockedBy: 'other-user', lockedAt: liveAt },
    ];
    let caught: unknown;
    try {
      assertPageWritable(rows, true, 'actor', now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PageLockedError);
    expect(caught).toMatchObject({ pageId: 'p2' });
  });
});
