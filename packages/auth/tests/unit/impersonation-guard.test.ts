import { describe, expect, it } from 'vitest';
import {
  ImpersonationTargetForbiddenError,
  assertImpersonationTargetAllowed,
  auditActorFromSession,
} from '../../src/impersonation.js';

const SUPERADMIN = { userId: 'a', roleKey: 'superadmin' };

function refusalOf(run: () => void): ImpersonationTargetForbiddenError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ImpersonationTargetForbiddenError);
  return caught as ImpersonationTargetForbiddenError;
}

describe('impersonation target guard (D-13)', () => {
  it('allows a superadmin to impersonate an editor', () => {
    expect(() =>
      assertImpersonationTargetAllowed(
        { userId: 't', roleKey: 'editor' },
        SUPERADMIN,
      ),
    ).not.toThrow();
  });

  it('allows an admin target', () => {
    expect(() =>
      assertImpersonationTargetAllowed(
        { userId: 't', roleKey: 'admin' },
        SUPERADMIN,
      ),
    ).not.toThrow();
  });

  it('refuses a superadmin target', () => {
    const error = refusalOf(() => {
      assertImpersonationTargetAllowed(
        { userId: 't', roleKey: 'superadmin' },
        SUPERADMIN,
      );
    });
    expect(error.reason).toBe('target-is-superadmin');
    expect(error.targetUserId).toBe('t');
  });

  it('refuses impersonating oneself, whatever the roles', () => {
    for (const roleKey of ['editor', 'admin', 'superadmin', 'orphaned-role']) {
      const error = refusalOf(() => {
        assertImpersonationTargetAllowed(
          { userId: 'same', roleKey },
          { userId: 'same', roleKey },
        );
      });
      expect(error.reason).toBe('target-is-self');
      expect(error.targetUserId).toBe('same');
    }
  });

  it('allows a target whose role key is unknown to the role map, since an orphaned role holds nothing', () => {
    for (const roleKey of ['retired-role', 'Superadmin', '__proto__', '']) {
      expect(() =>
        assertImpersonationTargetAllowed({ userId: 't', roleKey }, SUPERADMIN),
      ).not.toThrow();
    }
  });

  it('names the reason and the opaque target id, and nothing else about anyone', () => {
    const target = {
      userId: 'user-7f3a',
      roleKey: 'superadmin',
      // Fields a caller might have on hand must not reach the error.
      email: 'other-owner@example.com',
      name: 'Other Owner',
      sessionToken: 'tok_4e1d9c',
    };
    const error = refusalOf(() => {
      assertImpersonationTargetAllowed(target, {
        ...SUPERADMIN,
        email: 'owner@example.com',
      } as typeof SUPERADMIN);
    });

    expect(error.name).toBe('ImpersonationTargetForbiddenError');
    expect(error.message.startsWith('@plakboek/auth: ')).toBe(true);
    expect(error.message).toContain('target-is-superadmin');
    expect(error.message).toContain('user-7f3a');

    const serialised = `${error.message} ${JSON.stringify(error)}`;
    for (const leaked of [
      'other-owner@example.com',
      'Other Owner',
      'tok_4e1d9c',
      'owner@example.com',
    ]) {
      expect(serialised).not.toContain(leaked);
    }
  });
});

describe('audit actor derivation (D-11)', () => {
  it('records the impersonated user as the actor and the superadmin as the annotation', () => {
    expect(
      auditActorFromSession({
        userId: 'u',
        roleKey: 'editor',
        impersonatedBy: 'a',
      }),
    ).toEqual({ userId: 'u', roleKey: 'editor', impersonatedBy: 'a' });
  });

  it('leaves impersonatedBy absent for an ordinary session', () => {
    const actor = auditActorFromSession({ userId: 'u', roleKey: 'editor' });
    expect(actor).toEqual({ userId: 'u', roleKey: 'editor' });
    expect(Object.hasOwn(actor, 'impersonatedBy')).toBe(false);
  });

  it('never makes the impersonator the actor of an impersonated session', () => {
    const sessions = [
      { userId: 'u', roleKey: 'editor', impersonatedBy: 'a' },
      { userId: 'u2', roleKey: 'admin', impersonatedBy: 'a' },
      { userId: 'u3', roleKey: 'orphaned-role', impersonatedBy: 'b' },
    ];
    for (const session of sessions) {
      const actor = auditActorFromSession(session);
      expect(actor.userId).toBe(session.userId);
      expect(actor.userId).not.toBe(session.impersonatedBy);
      expect(actor.impersonatedBy).toBe(session.impersonatedBy);
    }
  });

  it('refuses a session that claims to impersonate its own user, rather than record one identity twice', () => {
    const error = refusalOf(() => {
      auditActorFromSession({
        userId: 'a',
        roleKey: 'superadmin',
        impersonatedBy: 'a',
      });
    });
    expect(error.reason).toBe('target-is-self');
  });
});
