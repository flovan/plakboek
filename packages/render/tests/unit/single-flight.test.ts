import { describe, expect, it } from 'vitest';
import { createSingleFlight } from '../../src/single-flight.js';

/** A task whose completion the test controls. */
function controlledTask<T>(): {
  readonly task: () => Promise<T>;
  readonly calls: () => number;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let count = 0;
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  return {
    task: () => {
      count += 1;
      return new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    calls: () => count,
    resolve: (value) => resolve(value),
    reject: (error) => reject(error),
  };
}

describe('createSingleFlight', () => {
  it('runs the task once for two calls before it settles and shares the value', async () => {
    const flights = createSingleFlight<string>();
    const controlled = controlledTask<string>();
    const first = flights.run('k', controlled.task);
    const second = flights.run('k', controlled.task);
    expect(controlled.calls()).toBe(1);
    expect(flights.size).toBe(1);
    controlled.resolve('shared');
    expect(await first).toBe('shared');
    expect(await second).toBe('shared');
  });

  it('runs different keys independently', async () => {
    const flights = createSingleFlight<string>();
    const one = controlledTask<string>();
    const two = controlledTask<string>();
    const first = flights.run('k1', one.task);
    const second = flights.run('k2', two.task);
    expect(one.calls()).toBe(1);
    expect(two.calls()).toBe(1);
    expect(flights.size).toBe(2);
    one.resolve('a');
    two.resolve('b');
    expect(await first).toBe('a');
    expect(await second).toBe('b');
  });

  it('removes the key once the shared promise settles, so the next call runs again', async () => {
    const flights = createSingleFlight<string>();
    const controlled = controlledTask<string>();
    const first = flights.run('k', controlled.task);
    controlled.resolve('one');
    await first;
    expect(flights.size).toBe(0);

    const again = flights.run('k', controlled.task);
    expect(controlled.calls()).toBe(2);
    controlled.resolve('two');
    expect(await again).toBe('two');
    expect(flights.size).toBe(0);
  });

  it('rejects every waiter with the same error and still clears the key', async () => {
    const flights = createSingleFlight<string>();
    const controlled = controlledTask<string>();
    const failure = new Error('render failed');
    const first = flights.run('k', controlled.task);
    const second = flights.run('k', controlled.task);
    controlled.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(flights.size).toBe(0);
    expect(controlled.calls()).toBe(1);
  });

  it('turns a task that throws synchronously into a rejection and clears the key', async () => {
    const flights = createSingleFlight<string>();
    const failure = new Error('sync');
    const run = flights.run('k', () => {
      throw failure;
    });
    await expect(run).rejects.toBe(failure);
    expect(flights.size).toBe(0);
  });
});
