import { describe, expect, it } from 'vitest';
import {
  TWO_FACTOR_ENROLMENT_PATH,
  TWO_FACTOR_REQUIRED_ROLE_KEYS,
  TwoFactorEnrolmentRequiredError,
  assertTwoFactorSatisfied,
  isTwoFactorRequiredForRole,
  needsTwoFactorEnrolment,
} from '../../src/two-factor-gate.js';

describe('which roles require two-factor (D-03)', () => {
  it('requires it for superadmin only', () => {
    expect(isTwoFactorRequiredForRole('superadmin')).toBe(true);
    expect(isTwoFactorRequiredForRole('admin')).toBe(false);
    expect(isTwoFactorRequiredForRole('editor')).toBe(false);
  });

  it('matches the role key exactly', () => {
    expect(isTwoFactorRequiredForRole('Superadmin')).toBe(false);
    expect(isTwoFactorRequiredForRole('SUPERADMIN')).toBe(false);
    expect(isTwoFactorRequiredForRole(' superadmin')).toBe(false);
  });

  it('treats prototype-chain keys and the empty string as absent without throwing', () => {
    for (const roleKey of ['__proto__', 'constructor', 'toString', '']) {
      expect(() => isTwoFactorRequiredForRole(roleKey)).not.toThrow();
      expect(isTwoFactorRequiredForRole(roleKey)).toBe(false);
    }
  });

  it('keeps the required-role list frozen, so a caller cannot widen or empty it', () => {
    expect([...TWO_FACTOR_REQUIRED_ROLE_KEYS]).toEqual(['superadmin']);
    expect(Object.isFrozen(TWO_FACTOR_REQUIRED_ROLE_KEYS)).toBe(true);

    const list = TWO_FACTOR_REQUIRED_ROLE_KEYS as unknown as string[];
    expect(() => list.push('editor')).toThrow(TypeError);
    expect(() => list.splice(0, 1)).toThrow(TypeError);

    expect(isTwoFactorRequiredForRole('editor')).toBe(false);
    expect(isTwoFactorRequiredForRole('superadmin')).toBe(true);
  });
});

describe('enrolment requirement', () => {
  it('sends an unenrolled superadmin to enrolment', () => {
    expect(
      needsTwoFactorEnrolment({
        roleKey: 'superadmin',
        twoFactorEnabled: false,
      }),
    ).toBe(true);
  });

  it('lets an enrolled superadmin through', () => {
    expect(
      needsTwoFactorEnrolment({
        roleKey: 'superadmin',
        twoFactorEnabled: true,
      }),
    ).toBe(false);
  });

  it('never forces any other role into enrolment, enrolled or not', () => {
    for (const roleKey of ['admin', 'editor', 'orphaned-role', '__proto__']) {
      for (const twoFactorEnabled of [false, true]) {
        expect(needsTwoFactorEnrolment({ roleKey, twoFactorEnabled })).toBe(
          false,
        );
      }
    }
  });
});

describe('assertTwoFactorSatisfied', () => {
  it('throws TwoFactorEnrolmentRequiredError for an unenrolled superadmin', () => {
    expect(() =>
      assertTwoFactorSatisfied({
        roleKey: 'superadmin',
        twoFactorEnabled: false,
      }),
    ).toThrow(TwoFactorEnrolmentRequiredError);
  });

  it('returns for an enrolled superadmin and for every other role', () => {
    expect(() =>
      assertTwoFactorSatisfied({
        roleKey: 'superadmin',
        twoFactorEnabled: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertTwoFactorSatisfied({ roleKey: 'editor', twoFactorEnabled: false }),
    ).not.toThrow();
    expect(() =>
      assertTwoFactorSatisfied({ roleKey: 'admin', twoFactorEnabled: false }),
    ).not.toThrow();
  });

  it('routes to the enrolment path and names the role key, but no user', () => {
    const subject = {
      roleKey: 'superadmin',
      twoFactorEnabled: false,
      // Extra session fields a loader might pass along must not leak.
      userId: 'user-0b7e',
      email: 'owner@example.com',
      name: 'Owner Name',
    };

    let caught: unknown;
    try {
      assertTwoFactorSatisfied(subject);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TwoFactorEnrolmentRequiredError);
    const error = caught as TwoFactorEnrolmentRequiredError;
    expect(error.name).toBe('TwoFactorEnrolmentRequiredError');
    expect(error.redirectTo).toBe(TWO_FACTOR_ENROLMENT_PATH);
    expect(error.roleKey).toBe('superadmin');
    expect(error.message.startsWith('@plakboek/auth: ')).toBe(true);
    expect(error.message).toContain('superadmin');

    const serialised = `${error.message} ${JSON.stringify(error)}`;
    for (const leaked of ['user-0b7e', 'owner@example.com', 'Owner Name']) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it('routes every caller to one enrolment path under /cms', () => {
    expect(TWO_FACTOR_ENROLMENT_PATH).toBe('/cms/settings/2fa/enrol');
  });
});
