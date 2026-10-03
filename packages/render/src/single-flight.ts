/**
 * In-flight coalescing: concurrent callers with the same key share one task
 * and one result. One instance lives inside one handler, so there is no
 * module-level state and two handlers never share a flight (D-04).
 *
 * The entry is removed when its promise settles, whichever way, so a failed
 * flight is never remembered and the next caller starts a fresh task.
 */
export type SingleFlight<T> = {
  /** Runs `task` unless a flight for `key` is already in progress. */
  run(key: string, task: () => Promise<T>): Promise<T>;
  /** How many flights are in progress. */
  readonly size: number;
};

export function createSingleFlight<T>(): SingleFlight<T> {
  const flights = new Map<string, Promise<T>>();

  return {
    run(key, task) {
      const existing = flights.get(key);
      if (existing !== undefined) return existing;

      // `task` starts synchronously; a synchronous throw becomes a rejection.
      const promise = new Promise<T>((resolve) => {
        resolve(task());
      });
      flights.set(key, promise);
      const clear = (): void => {
        if (flights.get(key) === promise) flights.delete(key);
      };
      // Registered before any waiter, so the key is gone by the time they run.
      promise.then(clear, clear);
      return promise;
    },

    get size() {
      return flights.size;
    },
  };
}
