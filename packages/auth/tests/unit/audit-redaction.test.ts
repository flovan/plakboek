import { describe, expect, it } from 'vitest';
import {
  REDACTED_KEYS,
  REDACTION_MARKER,
  redactAuditPayload,
} from '../../src/audit-redaction.js';

const CYCLE_MARKER = '[circular]';
const DEPTH_MARKER = '[truncated]';

/** Builds `{ level: 0, child: { level: 1, child: ... } }` with `levels`
 * nested objects in total. */
function nestedChain(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { level: levels - 1 };
  for (let level = levels - 2; level >= 0; level -= 1) {
    node = { level, child: node };
  }
  return node;
}

/** Follows `child` links `steps` times. */
function descend(value: unknown, steps: number): unknown {
  let node = value;
  for (let step = 0; step < steps; step += 1) {
    node = (node as Record<string, unknown>).child;
  }
  return node;
}

describe('redactAuditPayload', () => {
  it('replaces the value of a sensitive key and keeps the key', () => {
    expect(
      redactAuditPayload({ email: 'a@b.test', password: 'hunter2' }),
    ).toEqual({ email: 'a@b.test', password: '[redacted]' });
    expect(REDACTION_MARKER).toBe('[redacted]');
  });

  it('matches keys regardless of case and separators', () => {
    expect(
      redactAuditPayload({
        password: 'plain',
        password_hash: 'snake',
        passwordHash: 'camel',
        PasswordHash: 'pascal',
        'PASSWORD-HASH': 'kebab',
        'session token': 'spaced',
        name: 'Ada',
      }),
    ).toEqual({
      password: '[redacted]',
      password_hash: '[redacted]',
      passwordHash: '[redacted]',
      PasswordHash: '[redacted]',
      'PASSWORD-HASH': '[redacted]',
      'session token': '[redacted]',
      name: 'Ada',
    });
  });

  it('redacts the whole value of a sensitive key, even when it is a structure', () => {
    expect(
      redactAuditPayload({ backupCodes: ['1111', '2222'], secret: { k: 1 } }),
    ).toEqual({ backupCodes: '[redacted]', secret: '[redacted]' });
  });

  it('walks nested objects and arrays of objects to full depth', () => {
    const payload = {
      user: {
        profile: { apiKey: 'k-123', label: 'kept' },
        sessions: [
          { id: 's1', sessionToken: 't1' },
          { id: 's2', token: 't2', nested: [{ otp: '123456' }] },
        ],
      },
      tags: ['a', 'b'],
    };
    expect(redactAuditPayload(payload)).toEqual({
      user: {
        profile: { apiKey: '[redacted]', label: 'kept' },
        sessions: [
          { id: 's1', sessionToken: '[redacted]' },
          { id: 's2', token: '[redacted]', nested: [{ otp: '[redacted]' }] },
        ],
      },
      tags: ['a', 'b'],
    });
  });

  it('never lets a credential value survive into the serialised payload', () => {
    const serialised = JSON.stringify(
      redactAuditPayload({
        account: { accessToken: 'at-1', refreshToken: 'rt-1', idToken: 'it-1' },
        twoFactor: { twoFactorSecret: 'tfs-1', code: '654321' },
      }),
    );
    for (const value of ['at-1', 'rt-1', 'it-1', 'tfs-1', '654321']) {
      expect(serialised).not.toContain(value);
    }
  });

  it('replaces a cycle with a fixed marker instead of recursing forever', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    node.children = [{ parent: node, name: 'child' }];

    expect(redactAuditPayload(node)).toEqual({
      name: 'root',
      self: CYCLE_MARKER,
      children: [{ parent: CYCLE_MARKER, name: 'child' }],
    });
  });

  it('walks a shared, non-cyclic reference at each place it appears', () => {
    const shared = { label: 'shared', token: 'tok' };
    expect(redactAuditPayload({ first: shared, second: shared })).toEqual({
      first: { label: 'shared', token: '[redacted]' },
      second: { label: 'shared', token: '[redacted]' },
    });
  });

  it('returns undefined and null unchanged', () => {
    expect(redactAuditPayload(undefined)).toBeUndefined();
    expect(redactAuditPayload(null)).toBeNull();
  });

  it('returns primitives unchanged', () => {
    expect(redactAuditPayload('text')).toBe('text');
    expect(redactAuditPayload(42)).toBe(42);
    expect(redactAuditPayload(false)).toBe(false);
  });

  it('truncates below a default depth of 8 with a marker', () => {
    const redacted = redactAuditPayload(nestedChain(20));

    expect(descend(redacted, 7)).toEqual({ level: 7, child: DEPTH_MARKER });
    expect(descend(redacted, 8)).toBe(DEPTH_MARKER);
  });

  it('honours a caller-supplied maxDepth', () => {
    expect(
      redactAuditPayload({ a: { b: { c: 1 } }, top: 1 }, { maxDepth: 2 }),
    ).toEqual({ a: { b: DEPTH_MARKER }, top: 1 });
  });

  it('rejects a maxDepth that is not a non-negative integer', () => {
    for (const maxDepth of [-1, 1.5, Number.NaN]) {
      expect(() => redactAuditPayload({ a: 1 }, { maxDepth })).toThrow(
        /@plakboek\/auth/,
      );
    }
  });

  it('serialises what JSON would store: toJSON output is walked too', () => {
    const entity = {
      toJSON: () => ({ id: 'u1', passwordHash: 'h' }),
    };
    const at = new Date('2026-01-02T03:04:05.000Z');

    expect(redactAuditPayload({ entity, at })).toEqual({
      entity: { id: 'u1', passwordHash: '[redacted]' },
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('keeps an own "__proto__" key as data rather than a prototype', () => {
    const payload: unknown = JSON.parse(
      '{"__proto__": {"password": "p", "kept": 1}}',
    );
    const redacted = redactAuditPayload(payload);

    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(JSON.stringify(redacted)).toBe(
      '{"__proto__":{"password":"[redacted]","kept":1}}',
    );
  });

  it('returns a new structure and does not mutate its input', () => {
    const input = {
      password: 'hunter2',
      nested: { token: 't', list: [{ secret: 's' }] },
    };
    const snapshot = structuredClone(input);

    const redacted = redactAuditPayload(input);

    expect(input).toEqual(snapshot);
    expect(redacted).not.toBe(input);
    expect((redacted as typeof input).nested).not.toBe(input.nested);
    expect((redacted as typeof input).nested.list).not.toBe(input.nested.list);
  });
});

describe('REDACTED_KEYS', () => {
  it('holds the normalised forms of the required sensitive keys', () => {
    for (const key of [
      'password',
      'passwordhash',
      'token',
      'secret',
      'backupcodes',
      'sessiontoken',
      'apikey',
      'otp',
      'code',
      'twofactorsecret',
    ]) {
      expect(REDACTED_KEYS).toContain(key);
    }
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(REDACTED_KEYS)).toBe(true);
    expect(() => {
      (REDACTED_KEYS as string[]).push('extra');
    }).toThrow(TypeError);
  });
});
