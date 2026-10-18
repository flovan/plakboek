/**
 * Background work against a pooled database handle: shutdown stops it and
 * waits for it before the pool closes, because queries still queued in a
 * closing pool open fresh connections after the close. The pool never
 * connects here, so no database is needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllDbs, getDb, runInBackground } from '../../src/runtime/db.js';

const connectionString = 'postgres://nobody:nothing@127.0.0.1:1/unused';

afterEach(async () => {
  await closeAllDbs();
});

describe('runInBackground', () => {
  it('has closeAllDbs signal the work and wait for it before the handle closes', async () => {
    const handle = getDb(connectionString);
    const events: string[] = [];
    const closePool = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      events.push('closed');
      await closePool();
    });

    runInBackground(handle, async (closing) => {
      await new Promise<void>((resolve) => {
        closing.addEventListener('abort', () => resolve(), { once: true });
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      events.push('stopped');
    });

    await closeAllDbs();
    expect(events).toEqual(['stopped', 'closed']);
  });

  it('never lets a failure escape and starts nothing on a closing handle', async () => {
    const handle = getDb(connectionString);
    runInBackground(handle, () => Promise.reject(new Error('boom')));

    await expect(closeAllDbs()).resolves.toBeUndefined();

    const started = vi.fn();
    runInBackground(handle, () => {
      started();
      return Promise.resolve();
    });
    expect(started).not.toHaveBeenCalled();
  });
});
