import { TWO_FACTOR_ENROLMENT_PATH } from '@plakboek/auth';
import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY } from '../../src/server/layout-script.js';
import { ENROLMENT_PATH, mustEnrol } from '../../src/client/login/mount.js';
import {
  editAddress,
  TIMINGS,
  targetFrameRect,
} from '../../src/client/login/transition.js';
import { LAYOUT_KEY } from '../../src/client/shell/layout.js';

describe('targetFrameRect', () => {
  const viewport = { width: 1400, height: 900 };

  it('leaves the sidebar and 24px of stage on every side when framed', () => {
    expect(targetFrameRect('framed', viewport)).toEqual({
      left: 304,
      top: 24,
      width: 1072,
      height: 852,
    });
  });

  it('leaves only the rail when full', () => {
    expect(targetFrameRect('full', viewport)).toEqual({
      left: 56,
      top: 0,
      width: 1344,
      height: 900,
    });
  });
});

describe('editAddress', () => {
  it.each([
    ['/about', '/about?_edit=1'],
    ['/', '/?_edit=1'],
    ['/about?utm=x', '/about?utm=x&_edit=1'],
    ['/about#team', '/about?_edit=1#team'],
    ['/about?utm=x#team', '/about?utm=x&_edit=1#team'],
  ])('opens %s as %s', (next, expected) => {
    expect(editAddress(next)).toBe(expected);
  });
});

describe('TIMINGS', () => {
  it('finishes within the 700ms the hand-over may take', () => {
    const ends = Object.values(TIMINGS).map((t) => t.delay + t.duration);
    expect(Math.max(...ends)).toBeLessThanOrEqual(700);
  });
});

describe('mustEnrol', () => {
  const roles = ['superadmin', 'admin'];
  const user = (role: string | null, twoFactorEnabled: boolean) => ({
    name: 'Ada',
    email: 'ada@example.com',
    role,
    twoFactorEnabled,
  });

  it('is true for a required role without two-step sign-in', () => {
    expect(mustEnrol(user('admin', false), roles)).toBe(true);
  });

  it('is false once two-step sign-in is on, for other roles and without a role', () => {
    expect(mustEnrol(user('admin', true), roles)).toBe(false);
    expect(mustEnrol(user('editor', false), roles)).toBe(false);
    expect(mustEnrol(user(null, false), roles)).toBe(false);
  });

  it('reads a list of roles', () => {
    expect(mustEnrol(user('editor, admin', false), roles)).toBe(true);
  });
});

describe('constants repeated from other modules', () => {
  it('names the auth package set-up path', () => {
    expect(ENROLMENT_PATH).toBe(TWO_FACTOR_ENROLMENT_PATH);
  });

  it('names the layout key the shell and its pre-paint script use', () => {
    expect(LAYOUT_KEY).toBe(LAYOUT_STORAGE_KEY);
  });
});
