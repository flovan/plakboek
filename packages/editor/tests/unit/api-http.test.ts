/**
 * The editor API's request gate and error mapping: who counts as this site,
 * how a body is read, and which status and code each engine error becomes.
 */
import { PermissionDeniedError } from '@plakboek/auth';
import {
  BlockDepthExceededError,
  BlockEditLimitError,
  BlockIdConflictError,
  BlockLayoutValidationError,
  BlockNotFoundError,
  BlockOwnershipError,
  BlockPlacementError,
  BlockPropsValidationError,
  CircularMoveError,
  InvalidSiblingReferenceError,
  PageLockedError,
  PageLockingDisabledError,
  PageLockNotFoundError,
  PageLockStateChangedError,
  PageLockTakeoverForbiddenError,
  PageNotFoundError,
  SectionColumnRequiredError,
  SectionNestingDepthExceededError,
  SectionRequiredError,
  StaleBlockVersionError,
  StalePageVersionError,
  UnknownBlockTypeError,
} from '@plakboek/pages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LockView } from '../../src/api-types.js';
import {
  apiErrorFor,
  ApiHttpError,
  checkOrigin,
  jsonResponse,
  readJsonBody,
} from '../../src/server/api/http.js';

const SITE = 'https://site.test';

function post(headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/cms/api/open`, { method: 'POST', headers });
}

describe('checkOrigin', () => {
  it('accepts the site origin and the request’s own origin', () => {
    expect(checkOrigin(post({ Origin: SITE }), SITE)).toBe(true);
    expect(
      checkOrigin(post({ Origin: SITE }), 'https://other.test/some/path'),
    ).toBe(true);
    expect(
      checkOrigin(post({ Origin: 'https://proxy.test' }), 'https://proxy.test'),
    ).toBe(true);
  });

  it('refuses a foreign origin', () => {
    expect(checkOrigin(post({ Origin: 'https://evil.test' }), SITE)).toBe(
      false,
    );
  });

  it('falls back to Sec-Fetch-Site when Origin is missing or null', () => {
    expect(checkOrigin(post(), SITE)).toBe(false);
    expect(checkOrigin(post({ Origin: 'null' }), SITE)).toBe(false);
    expect(checkOrigin(post({ 'Sec-Fetch-Site': 'same-origin' }), SITE)).toBe(
      true,
    );
    expect(
      checkOrigin(
        post({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }),
        SITE,
      ),
    ).toBe(true);
    expect(
      checkOrigin(
        post({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }),
        SITE,
      ),
    ).toBe(false);
  });

  it('does not check a read', () => {
    expect(checkOrigin(new Request(`${SITE}/cms/api/x`), SITE)).toBe(true);
  });
});

function jsonPost(body: BodyInit, type = 'application/json'): Request {
  return new Request(`${SITE}/cms/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
  });
}

async function refusal(promise: Promise<unknown>): Promise<ApiHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiHttpError) return error;
    throw error;
  }
  throw new Error('expected the body read to be refused');
}

describe('readJsonBody', () => {
  it('parses a JSON body, whatever the charset suffix', async () => {
    expect(await readJsonBody(jsonPost('{"a":1}'))).toEqual({ a: 1 });
    expect(
      await readJsonBody(
        jsonPost('{"a":1}', 'application/json; charset=utf-8'),
      ),
    ).toEqual({ a: 1 });
  });

  it('refuses a body that is not declared JSON with 415', async () => {
    const error = await refusal(readJsonBody(jsonPost('{}', 'text/plain')));
    expect([error.status, error.code]).toEqual([415, 'invalid-request']);
  });

  it('refuses text that does not parse with 400', async () => {
    const error = await refusal(readJsonBody(jsonPost('{nope')));
    expect([error.status, error.code]).toEqual([400, 'invalid-request']);
  });

  it('refuses a body over the cap with 413, whether declared or streamed', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(200) });
    const streamed = await refusal(readJsonBody(jsonPost(big), 64));
    expect([streamed.status, streamed.code]).toEqual([413, 'too-large']);

    const declared = new Request(`${SITE}/cms/api/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '9999' },
      body: '{}',
    });
    const header = await refusal(readJsonBody(declared, 64));
    expect(header.status).toBe(413);
  });
});

describe('jsonResponse', () => {
  it('is no-store JSON that cannot be sniffed', async () => {
    const response = jsonResponse(201, { ok: true });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(await response.json()).toEqual({ ok: true });
  });
});

const LOCK: LockView = {
  enabled: true,
  state: 'other',
  holder: { name: 'Someone', lastActiveAt: '2026-10-10T09:00:00.000Z' },
  canTakeOver: false,
  expiresAt: null,
};

describe('apiErrorFor', () => {
  const placement = new BlockPlacementError('owner-type', 'a', null, 'page');
  const cases: readonly (readonly [string, unknown, number, string])[] = [
    [
      'no permission',
      new PermissionDeniedError('pages:edit', 'viewer'),
      403,
      'forbidden',
    ],
    [
      'takeover forbidden',
      new PageLockTakeoverForbiddenError('p'),
      403,
      'forbidden',
    ],
    ['page missing', new PageNotFoundError('p'), 404, 'not-found'],
    ['lock page missing', new PageLockNotFoundError('p'), 404, 'not-found'],
    ['block missing', new BlockNotFoundError('b'), 404, 'not-found'],
    ['block elsewhere', new BlockOwnershipError('b'), 404, 'not-found'],
    ['stale page', new StalePageVersionError('p', 1, 2), 409, 'stale-page'],
    ['stale block', new StaleBlockVersionError('b', 1, 2), 409, 'stale-block'],
    ['id taken', new BlockIdConflictError('b'), 409, 'conflict'],
    ['lock moved', new PageLockStateChangedError('p'), 409, 'lock-changed'],
    ['locking off', new PageLockingDisabledError(), 409, 'locking-disabled'],
    ['placement', placement, 422, 'placement'],
    ['section required', new SectionRequiredError('text'), 422, 'placement'],
    ['nesting', new SectionNestingDepthExceededError(2, 3), 422, 'placement'],
    ['depth', new BlockDepthExceededError(12, 13), 422, 'placement'],
    ['cycle', new CircularMoveError('a', 'b'), 422, 'placement'],
    [
      'bad sibling',
      new InvalidSiblingReferenceError('s', null, 'x'),
      422,
      'placement',
    ],
    ['unknown type', new UnknownBlockTypeError('nope'), 422, 'unknown-type'],
    [
      'column required',
      new SectionColumnRequiredError('s'),
      422,
      'section-column-required',
    ],
    ['too many ops', new BlockEditLimitError('ops'), 413, 'too-large'],
  ];

  it.each(cases)('maps %s', (_name, error, status, code) => {
    const failed = apiErrorFor(error);
    expect(failed.status).toBe(status);
    expect(failed.body).toEqual({ ok: false, error: { code } });
  });

  it('maps a locked page to 423 and carries the lock view', () => {
    const failed = apiErrorFor(new PageLockedError('p', 'en', 'user-1'), LOCK);
    expect(failed.status).toBe(423);
    expect(failed.body).toEqual({
      ok: false,
      error: { code: 'locked', lock: LOCK },
    });
    // The holder's user id is in the engine error and must not be in the answer.
    expect(JSON.stringify(failed.body)).not.toContain('user-1');
  });

  it('maps refused values to their keys and codes, and no value', () => {
    const props = apiErrorFor(
      new BlockPropsValidationError([
        { propertyKey: 'text', code: 'REQUIRED' },
      ]),
    );
    expect(props.status).toBe(422);
    expect(props.body).toEqual({
      ok: false,
      error: {
        code: 'invalid-props',
        issues: [{ key: 'text', code: 'REQUIRED' }],
      },
    });
    const layout = apiErrorFor(
      new BlockLayoutValidationError([{ key: 'columns', code: 'INVALID' }]),
    );
    expect(layout.body).toEqual({
      ok: false,
      error: {
        code: 'invalid-layout',
        issues: [{ key: 'columns', code: 'INVALID' }],
      },
    });
  });

  it('keeps the request plumbing’s own status and issues', () => {
    const failed = apiErrorFor(
      new ApiHttpError(400, 'invalid-request', [{ key: 'path', code: 'x' }]),
    );
    expect(failed.status).toBe(400);
    expect(failed.body).toEqual({
      ok: false,
      error: { code: 'invalid-request', issues: [{ key: 'path', code: 'x' }] },
    });
  });

  describe('an error it does not know', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is a 500 that logs the error name and never its message', () => {
      const logged = vi.spyOn(console, 'error').mockReturnValue();
      const secret = new Error('postgres://user:secret@host/db');
      secret.name = 'ConnectionError';
      const failed = apiErrorFor(secret);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({
        ok: false,
        error: { code: 'server-error' },
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.mock.calls)).toContain('ConnectionError');
      expect(JSON.stringify(logged.mock.calls)).not.toContain('secret');
    });
  });
});
