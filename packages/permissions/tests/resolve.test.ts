import { describe, expect, it, vi } from 'vitest';
import type { Permission } from '../src/catalogue.js';
import {
  createPermissionResolver,
  type OrphanedRoleEvent,
} from '../src/resolve.js';
import { defaultRoles, defineRoles } from '../src/roles.js';

const roles = defineRoles(defaultRoles);

/** A controllable injected clock for rate-limit tests. */
function makeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('resolve for known roles', () => {
  it("returns a Set equal to defaultRoles.editor for 'editor'", () => {
    const resolver = createPermissionResolver(roles);
    expect(resolver.resolve('editor')).toStrictEqual(new Set(roles.editor));
  });

  it("returns a Set of size 45 for 'superadmin'", () => {
    const resolver = createPermissionResolver(roles);
    expect(resolver.resolve('superadmin').size).toBe(45);
  });

  it('a role defined as [] returns size 0, emits nothing, and isKnownRole returns true for it', () => {
    const rolesWithGuest = defineRoles({ ...defaultRoles, guest: [] });
    const events: OrphanedRoleEvent[] = [];
    const resolver = createPermissionResolver(rolesWithGuest, {
      onOrphanedRole: (event) => events.push(event),
    });
    expect(resolver.resolve('guest').size).toBe(0);
    expect(events).toHaveLength(0);
    expect(resolver.isKnownRole('guest')).toBe(true);
  });
});

describe('isKnownRole', () => {
  it('returns true for defined roles and false for an unknown one', () => {
    const resolver = createPermissionResolver(roles);
    expect(resolver.isKnownRole('editor')).toBe(true);
    expect(resolver.isKnownRole('ghost')).toBe(false);
  });
});

describe('returned Set independence', () => {
  it("deleting a permission from the Set returned for 'editor' leaves the next resolve('editor') unchanged", () => {
    const resolver = createPermissionResolver(roles);
    const first = resolver.resolve('editor');
    // @ts-expect-error -- intentionally mutating the ReadonlySet's runtime Set for the test
    first.delete('pages:read');
    const second = resolver.resolve('editor');
    expect(second).toStrictEqual(new Set(roles.editor));
  });
});

describe('orphaned role keys (D-15, USER-10)', () => {
  it("resolve('writer', { userId: 'u1' }) returns size 0 and calls the hook once with suppressedCount 0", () => {
    const clock = makeClock(1_000_000);
    const events: OrphanedRoleEvent[] = [];
    const resolver = createPermissionResolver(roles, {
      onOrphanedRole: (event) => events.push(event),
      now: clock.now,
    });
    const result = resolver.resolve('writer', { userId: 'u1' });
    expect(result.size).toBe(0);
    expect(events).toStrictEqual([
      {
        roleKey: 'writer',
        userId: 'u1',
        occurredAt: new Date(1_000_000),
        suppressedCount: 0,
      },
    ]);
  });

  it('five more calls inside the window call the hook zero more times; after the window, the next call emits suppressedCount 5', () => {
    const clock = makeClock(0);
    const events: OrphanedRoleEvent[] = [];
    const resolver = createPermissionResolver(roles, {
      onOrphanedRole: (event) => events.push(event),
      now: clock.now,
      rateLimitMs: 60_000,
    });

    resolver.resolve('writer');
    expect(events).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      clock.advance(1_000);
      resolver.resolve('writer');
    }
    expect(events).toHaveLength(1);

    clock.advance(60_000);
    resolver.resolve('writer');
    expect(events).toHaveLength(2);
    expect(events[1]?.suppressedCount).toBe(5);
  });

  it("resolve('writer') then resolve('ghost') emit two events in that order even inside one window", () => {
    const events: OrphanedRoleEvent[] = [];
    const resolver = createPermissionResolver(roles, {
      onOrphanedRole: (event) => events.push(event),
    });
    resolver.resolve('writer');
    resolver.resolve('ghost');
    expect(events.map((event) => event.roleKey)).toStrictEqual([
      'writer',
      'ghost',
    ]);
  });

  it.each(['Editor', ' editor', '', '__proto__', 'constructor', 'toString'])(
    'role key %j returns size 0 and emits an event carrying that exact key',
    (roleKey) => {
      const events: OrphanedRoleEvent[] = [];
      const resolver = createPermissionResolver(roles, {
        onOrphanedRole: (event) => events.push(event),
      });
      expect(resolver.resolve(roleKey).size).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.roleKey).toBe(roleKey);
    },
  );

  it('a hook that throws does not make resolve throw, and resolve still returns size 0', () => {
    const resolver = createPermissionResolver(roles, {
      onOrphanedRole: () => {
        throw new Error('boom');
      },
    });
    let result: ReadonlySet<Permission> | undefined;
    expect(() => {
      result = resolver.resolve('ghost');
    }).not.toThrow();
    expect(result?.size).toBe(0);
  });

  it("resolve(null as never) and resolve(42 as never) return size 0 and emit roleKey 'null' and '42'", () => {
    const events: OrphanedRoleEvent[] = [];
    const resolver = createPermissionResolver(roles, {
      onOrphanedRole: (event) => events.push(event),
    });
    // `as never` intentionally bypasses the `roleKey: string` parameter type
    // to exercise resolve()'s runtime String() coercion for non-string
    // input (e.g. a caller ignoring the type, or a JS consumer).
    expect(resolver.resolve(null as never).size).toBe(0);
    expect(resolver.resolve(42 as never).size).toBe(0);
    expect(events.map((event) => event.roleKey)).toStrictEqual(['null', '42']);
  });

  it("without onOrphanedRole, console.warn receives a message containing the role key and 'denying all permissions'", () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const resolver = createPermissionResolver(roles);
      resolver.resolve('ghost');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0];
      expect(message).toContain('ghost');
      expect(message).toContain('denying all permissions');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('the event object has exactly the keys roleKey, userId (when given), occurredAt, suppressedCount', () => {
    const events: OrphanedRoleEvent[] = [];
    const resolver = createPermissionResolver(roles, {
      onOrphanedRole: (event) => events.push(event),
    });
    resolver.resolve('ghost');
    resolver.resolve('ghost2', { userId: 'u1' });
    expect(Object.keys(events[0] ?? {}).toSorted()).toStrictEqual([
      'occurredAt',
      'roleKey',
      'suppressedCount',
    ]);
    expect(Object.keys(events[1] ?? {}).toSorted()).toStrictEqual([
      'occurredAt',
      'roleKey',
      'suppressedCount',
      'userId',
    ]);
  });
});
