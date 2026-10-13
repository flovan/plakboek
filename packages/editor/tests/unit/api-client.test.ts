import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  createApiClient,
  failureKindOf,
} from '../../src/client/session/api-client.js';
import type { LockView } from '../../src/api-types.js';

type Call = { readonly url: string; readonly init: RequestInit };

/** A fetch that records its calls and answers with the given JSON. */
function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { calls, fetchImpl };
}

async function failure(promise: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error('the request did not fail');
}

describe('createApiClient', () => {
  it('posts JSON with the session cookie and returns the parsed answer', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { pageId: 'p1' });
    const answer = await createApiClient(fetchImpl).open('/about');
    expect(answer).toEqual({ pageId: 'p1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/cms/api/open');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(calls[0]?.init.headers).toEqual({
      'Content-Type': 'application/json',
    });
    expect(calls[0]?.init.body).toBe('{"path":"/about"}');
  });

  it('reads with a GET and no body', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { ok: true });
    await createApiClient(fetchImpl).tree('p1');
    expect(calls[0]?.url).toBe('/cms/api/pages/p1/tree');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('names the lock action in the route', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { ok: true });
    await createApiClient(fetchImpl).lockAction('p1', 'take-over');
    expect(calls[0]?.url).toBe('/cms/api/pages/p1/lock/take-over');
  });

  it('returns a refused preview as an answer, not an error', async () => {
    const refused = { ok: false, issues: [{ key: 'text', code: 'required' }] };
    const { fetchImpl } = fakeFetch(200, refused);
    const answer = await createApiClient(fetchImpl).preview(
      'p1',
      { blockId: 'b1' },
      new AbortController().signal,
    );
    expect(answer).toEqual(refused);
  });

  it('throws the status, code and lock view of an error answer', async () => {
    const lock: LockView = {
      enabled: true,
      state: 'other',
      holder: { name: 'Edith', lastActiveAt: '2026-10-14T10:00:00.000Z' },
      canTakeOver: false,
      expiresAt: null,
    };
    const { fetchImpl } = fakeFetch(423, {
      ok: false,
      error: { code: 'locked', lock },
    });
    const error = await failure(createApiClient(fetchImpl).lock('p1'));
    expect(error.status).toBe(423);
    expect(error.code).toBe('locked');
    expect(error.lock).toEqual(lock);
  });

  it('throws a null status when no answer came', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('down'));
    const error = await failure(createApiClient(fetchImpl).tree('p1'));
    expect(error.status).toBeNull();
    expect(error.code).toBeNull();
  });

  it('lets a cancelled preview surface its own abort', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchImpl: typeof fetch = () => Promise.reject(abort);
    await expect(
      createApiClient(fetchImpl).preview('p1', { blockId: 'b1' }),
    ).rejects.toBe(abort);
  });
});

describe('failureKindOf', () => {
  it.each([
    [null, null, 'network'],
    [500, 'server-error', 'network'],
    [503, null, 'network'],
    [409, 'stale-page', 'stale'],
    [409, 'stale-block', 'stale'],
    [409, 'conflict', 'refused'],
    [423, 'locked', 'locked'],
    [401, 'unauthenticated', 'session'],
    [400, 'invalid-props', 'refused'],
    [403, 'forbidden', 'refused'],
  ] as const)('maps %s %s to %s', (status, code, kind) => {
    expect(failureKindOf(new ApiRequestError(status, code))).toBe(kind);
  });

  it('treats anything that is not an api error as a refusal', () => {
    expect(failureKindOf(new Error('boom'))).toBe('refused');
  });
});
