import { describe, expect, it } from 'vitest';
import { EDIT_LOCK_TTL_SECONDS, isLockLive } from '../../src/locks.js';

describe('isLockLive (D-43 lapse arithmetic)', () => {
  it('EDIT_LOCK_TTL_SECONDS is 120', () => {
    expect(EDIT_LOCK_TTL_SECONDS).toBe(120);
  });

  it('is live 119999ms after lockedAt', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(lockedAt.getTime() + 119_999);
    expect(isLockLive('u1', lockedAt, now)).toBe(true);
  });

  it('is not live exactly 120000ms after lockedAt', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(lockedAt.getTime() + 120_000);
    expect(isLockLive('u1', lockedAt, now)).toBe(false);
  });

  it('is live at exactly 0ms (just locked)', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    expect(isLockLive('u1', lockedAt, lockedAt)).toBe(true);
  });

  it('a null holder is never live, whatever lockedAt/now are', () => {
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    expect(isLockLive(null, lockedAt, lockedAt)).toBe(false);
    expect(isLockLive(null, null, lockedAt)).toBe(false);
  });

  it('a non-null holder with a null lockedAt is never live', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isLockLive('u1', null, now)).toBe(false);
  });
});
