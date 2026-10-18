import { MutationObserver, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEditorQueryClient,
  shouldRetryWrite,
  writeRetryDelay,
} from '../../src/client/session/query-client.js';

describe('shouldRetryWrite', () => {
  it('retries a network failure and a server failure below three attempts', () => {
    expect(shouldRetryWrite(0, { status: null })).toBe(true);
    expect(shouldRetryWrite(2, { status: 503 })).toBe(true);
  });

  it('stops after three failures', () => {
    expect(shouldRetryWrite(3, { status: null })).toBe(false);
    expect(shouldRetryWrite(3, { status: 503 })).toBe(false);
  });

  it.each([400, 401, 403, 404, 409, 422, 423])(
    'never retries a %i refusal',
    (status) => {
      expect(shouldRetryWrite(0, { status })).toBe(false);
    },
  );

  it('does not retry an error without a status', () => {
    expect(shouldRetryWrite(0, new Error('boom'))).toBe(false);
  });
});

describe('writeRetryDelay', () => {
  it('doubles from 500 ms and caps at 4000 ms', () => {
    expect([0, 1, 2, 3, 4].map(writeRetryDelay)).toEqual([
      500, 1000, 2000, 4000, 4000,
    ]);
  });
});

describe('createEditorQueryClient', () => {
  it('wires the write policy into mutation defaults', () => {
    const defaults = createEditorQueryClient().getDefaultOptions();
    expect(defaults.mutations?.retry).toBe(shouldRetryWrite);
    expect(defaults.mutations?.retryDelay).toBe(writeRetryDelay);
  });

  describe('while the browser reports offline', () => {
    afterEach(() => {
      onlineManager.setOnline(true);
    });

    it('still runs a write, so a dropped request fails instead of waiting forever', async () => {
      onlineManager.setOnline(false);
      const observer = new MutationObserver<string, Error, undefined>(
        createEditorQueryClient(),
        { mutationFn: () => Promise.reject(new Error('no network')) },
      );
      const outcome = await Promise.race([
        observer.mutate(undefined).then(
          () => 'saved',
          () => 'failed',
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('paused');
          }, 50);
        }),
      ]);
      expect(outcome).toBe('failed');
    });
  });
});
