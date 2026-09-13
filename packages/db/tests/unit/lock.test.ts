import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withMigrationLock } from '../../src/lock.js';

/**
 * A minimal fake `Client` whose `query` resolves per-call from a queue,
 * regardless of the SQL text -- `withMigrationLock` only ever issues two
 * distinct queries (try-lock during `acquire`, unlock at the end), so
 * queueing responses in call order is enough to drive both branches without
 * a real Postgres connection.
 */
function fakeClient(responses: readonly (() => Promise<unknown>)[]): Client {
  const queue = [...responses];
  return {
    query: vi.fn(() => {
      const next = queue.shift();
      if (!next) {
        throw new Error('fakeClient: no more queued responses');
      }
      return next();
    }),
  } as unknown as Client;
}

function locked(): Promise<{ rows: { locked: boolean }[] }> {
  return Promise.resolve({ rows: [{ locked: true }] });
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
    // Silence the deliberate console.error this fix introduces.
  });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('withMigrationLock (unit, fake client)', () => {
  it("returns fn's result and logs, rather than throwing, when fn succeeds but the unlock query itself fails", async () => {
    const unlockError = new Error('connection terminated');
    const client = fakeClient([
      locked, // pg_try_advisory_lock succeeds
      () => Promise.reject(unlockError), // pg_advisory_unlock fails
    ]);

    const result = await withMigrationLock(client, async () => 'fn-result');

    expect(result).toBe('fn-result');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[1]).toBe(unlockError);
  });

  it("still throws fn's own error when fn fails, even if the unlock query also fails", async () => {
    const fnError = new Error('migration failed');
    const client = fakeClient([
      locked, // pg_try_advisory_lock succeeds
      () => Promise.reject(new Error('unlock also failed')),
    ]);

    let caught: unknown;
    try {
      await withMigrationLock(client, async () => {
        throw fnError;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(fnError);
  });

  it("returns fn's result normally when both fn and the unlock query succeed", async () => {
    const client = fakeClient([
      locked,
      () => Promise.resolve({ rows: [{ unlocked: true }] }),
    ]);

    const result = await withMigrationLock(client, async () => 'ok');

    expect(result).toBe('ok');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
