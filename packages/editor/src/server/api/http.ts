/**
 * The request and answer plumbing of the editor API: who may call it, how a
 * body is read, how an answer is written and how the engine's errors become
 * the codes the client understands.
 *
 * Every answer is JSON and `no-store`. An error carries a code and, for a
 * refused value, the keys and codes of what was refused; never a message,
 * a stored value or anything about who else is editing. An error this file
 * does not know is logged by its class name only and answered as 500.
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
import type {
  ApiError,
  ApiErrorCode,
  ApiIssue,
  LockView,
} from '../../api-types.js';

/** The most a request body may hold before it is refused unread. */
export const EDITOR_API_BODY_LIMIT_BYTES = 1_048_576;

const NO_STORE = 'no-store';

/** A failure with a known status and code, thrown by the request plumbing
 * itself (a bad body, a missing page route) rather than by the engine. */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues: readonly ApiIssue[] | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    issues?: readonly ApiIssue[],
  ) {
    super(`editor api refused a request: ${code}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/** An answer's status and body, before it becomes a `Response`. */
export type ApiFailure = {
  readonly status: number;
  readonly body: ApiError;
};

/**
 * Whether a request came from this site's own pages. Only state-changing
 * methods are checked. `siteOrigin` is authoritative; the request's own
 * origin is accepted too, because behind a TLS-terminating proxy the two can
 * legitimately differ and a foreign page can forge neither.
 *
 * A browser sends no usable `Origin` in two cases that matter: none at all,
 * and the literal `null` (a document with `Referrer-Policy: no-referrer`, as
 * the edit shell is). Both fall back to the browser's own `Sec-Fetch-Site`,
 * which a page cannot set and which must say `same-origin`.
 */
export function checkOrigin(request: Request, siteOrigin: string): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('Origin');
  if (origin === null || origin === 'null') {
    return request.headers.get('Sec-Fetch-Site') === 'same-origin';
  }
  const allowed = new Set<string>();
  for (const candidate of [siteOrigin, request.url]) {
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // An unparseable value contributes no origin.
    }
  }
  return allowed.has(origin);
}

/** The body's bytes, read in chunks and abandoned the moment they exceed
 * `limit`, so an oversized body is never held in memory. */
async function readCapped(
  request: Request,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) return null;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The request's JSON body. Throws `ApiHttpError`: 415 for a content type
 * that is not JSON, 413 past `limit` bytes, 400 for text that does not
 * parse.
 */
export async function readJsonBody(
  request: Request,
  limit: number = EDITOR_API_BODY_LIMIT_BYTES,
): Promise<unknown> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new ApiHttpError(415, 'invalid-request');
  }
  const bytes = await readCapped(request, limit);
  if (bytes === null) throw new ApiHttpError(413, 'too-large');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiHttpError(400, 'invalid-request');
  }
}

/** A JSON answer that no cache may keep. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': NO_STORE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function failure(
  status: number,
  code: ApiErrorCode,
  extra: {
    readonly issues?: readonly ApiIssue[];
    readonly lock?: LockView;
  } = {},
): ApiFailure {
  return {
    status,
    body: {
      ok: false,
      error: {
        code,
        ...(extra.issues !== undefined ? { issues: extra.issues } : {}),
        ...(extra.lock !== undefined ? { lock: extra.lock } : {}),
      },
    },
  };
}

/** The class name of whatever was thrown; never its message, which can
 * quote stored content. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The status and body for an error. `lock` is the lock view to attach when
 * the error is a refusal because another editor holds the page; the caller
 * reads it, because this function has no database.
 */
export function apiErrorFor(error: unknown, lock?: LockView): ApiFailure {
  if (error instanceof ApiHttpError) {
    return failure(error.status, error.code, { issues: error.issues });
  }
  if (
    error instanceof PermissionDeniedError ||
    error instanceof PageLockTakeoverForbiddenError
  ) {
    return failure(403, 'forbidden');
  }
  if (
    error instanceof PageNotFoundError ||
    error instanceof PageLockNotFoundError ||
    error instanceof BlockNotFoundError ||
    error instanceof BlockOwnershipError
  ) {
    return failure(404, 'not-found');
  }
  if (error instanceof StalePageVersionError) return failure(409, 'stale-page');
  if (error instanceof StaleBlockVersionError) {
    return failure(409, 'stale-block');
  }
  if (error instanceof BlockIdConflictError) return failure(409, 'conflict');
  if (error instanceof PageLockStateChangedError) {
    return failure(409, 'lock-changed');
  }
  if (error instanceof PageLockingDisabledError) {
    return failure(409, 'locking-disabled');
  }
  if (error instanceof PageLockedError) {
    return failure(423, 'locked', { lock });
  }
  if (
    error instanceof BlockPlacementError ||
    error instanceof SectionRequiredError ||
    error instanceof SectionNestingDepthExceededError ||
    error instanceof BlockDepthExceededError ||
    error instanceof CircularMoveError ||
    error instanceof InvalidSiblingReferenceError
  ) {
    return failure(422, 'placement');
  }
  if (error instanceof UnknownBlockTypeError) {
    return failure(422, 'unknown-type');
  }
  if (error instanceof BlockPropsValidationError) {
    return failure(422, 'invalid-props', {
      issues: error.issues.map((issue) => ({
        key: issue.propertyKey,
        code: issue.code,
      })),
    });
  }
  if (error instanceof BlockLayoutValidationError) {
    return failure(422, 'invalid-layout', {
      issues: error.issues.map((issue) => ({
        key: issue.key,
        code: issue.code,
      })),
    });
  }
  if (error instanceof SectionColumnRequiredError) {
    return failure(422, 'section-column-required');
  }
  if (error instanceof BlockEditLimitError) return failure(413, 'too-large');

  // oxlint-disable-next-line no-console -- the one place an unexpected API failure is reported; carries the error's class name only
  console.error('[@plakboek/editor] api request failed', errorName(error));
  return failure(500, 'server-error');
}
