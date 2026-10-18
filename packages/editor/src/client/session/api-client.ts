/**
 * The editor client's one door to `/cms/api`: a typed `fetch` wrapper per
 * route. Every call sends the session cookie, posts JSON, and either returns
 * the parsed answer or throws an `ApiRequestError` that says what kind of
 * failure it was, so the save queue and the chrome can react without ever
 * reading a response themselves.
 *
 * A request that got no answer has a `null` status. An error answer carries
 * the API's code and, when another editor holds the page, the lock view. A
 * preview the engine refused is not an error: it is an HTTP 200 answer with
 * `ok: false`, which this client returns as it is.
 */
import {
  EDITOR_API_BASE,
  type ApiErrorCode,
  type EditRequest,
  type EditResponse,
  type EditorSession,
  type LockResponse,
  type LockView,
  type PreviewRequest,
  type PreviewResponse,
  type TreeResponse,
} from '../../api-types.js';
import type { FailureKind } from './save-queue.js';

/** What a failed request carries. `status` is `null` when no answer came. */
export class ApiRequestError extends Error {
  readonly status: number | null;
  readonly code: ApiErrorCode | null;
  readonly lock: LockView | undefined;

  constructor(
    status: number | null,
    code: ApiErrorCode | null,
    lock?: LockView,
  ) {
    super(
      status === null
        ? 'editor api request got no answer'
        : `editor api request failed: ${status}`,
    );
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.lock = lock;
  }
}

/** The lock routes that change the lock. */
export type LockAction = 'acquire' | 'renew' | 'release' | 'take-over';

export type ApiClient = {
  /** Opens the page at a visitor path; the answer is the whole session. */
  open(path: string): Promise<EditorSession>;
  tree(pageId: string): Promise<TreeResponse>;
  lock(pageId: string): Promise<LockResponse>;
  lockAction(pageId: string, action: LockAction): Promise<LockResponse>;
  edit(pageId: string, request: EditRequest): Promise<EditResponse>;
  preview(
    pageId: string,
    request: PreviewRequest,
    signal?: AbortSignal,
  ): Promise<PreviewResponse>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'AbortError';
}

/** The code and lock view an error answer's body carries, when it has them. */
function errorDetails(body: unknown): {
  readonly code: ApiErrorCode | null;
  readonly lock: LockView | undefined;
} {
  if (!isRecord(body) || !isRecord(body['error'])) {
    return { code: null, lock: undefined };
  }
  const { code, lock } = body['error'];
  return {
    // The server writes only codes of ApiErrorCode, so a string is one.
    code: typeof code === 'string' ? (code as ApiErrorCode) : null,
    lock: isRecord(lock) ? (lock as LockView) : undefined,
  };
}

/**
 * Builds the client over a `fetch`. The default is the global one, read at
 * call time so a test or a polyfill installed later is honoured.
 */
export function createApiClient(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): ApiClient {
  async function send<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${EDITOR_API_BASE}${path}`, {
        method,
        credentials: 'same-origin',
        headers:
          method === 'POST'
            ? { 'Content-Type': 'application/json' }
            : undefined,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal,
      });
    } catch (error) {
      // A caller that cancelled a request wants to see its own abort.
      if (isAbort(error)) throw error;
      throw new ApiRequestError(null, null);
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // An answer with no readable body still has a status to act on.
    }
    if (!response.ok) {
      const { code, lock } = errorDetails(parsed);
      throw new ApiRequestError(response.status, code, lock);
    }
    return parsed as T;
  }

  const pagePath = (pageId: string, rest: string): string =>
    `/pages/${encodeURIComponent(pageId)}/${rest}`;

  return {
    open: (path) => send('/open', 'POST', { path }),
    tree: (pageId) => send(pagePath(pageId, 'tree'), 'GET'),
    lock: (pageId) => send(pagePath(pageId, 'lock'), 'GET'),
    lockAction: (pageId, action) =>
      send(pagePath(pageId, `lock/${action}`), 'POST', {}),
    edit: (pageId, request) => send(pagePath(pageId, 'edit'), 'POST', request),
    preview: (pageId, request, signal) =>
      send(pagePath(pageId, 'preview'), 'POST', request, signal),
  };
}

/** Statuses a proxy in front of the server answers when it could not take the request now. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * How a failed request counts for the save queue. No answer, a server failure
 * and a proxy's "try again" are the network's (a retry can help). A stale
 * version, a page or permission that changed under the editor, and a lock that
 * is switched off are stale: the page has to be read again. A lock that is held
 * or changed during the write is locked, a missing session is the session's,
 * and only a refusal of the change itself (validation, placement, a clash of
 * ids) is a refusal that drops it.
 */
export function failureKindOf(error: unknown): FailureKind {
  if (!(error instanceof ApiRequestError)) return 'refused';
  const { status, code } = error;
  if (status === null || status >= 500 || TRANSIENT_STATUSES.has(status)) {
    return 'network';
  }
  if (status === 409 && code !== null && code.startsWith('stale-')) {
    return 'stale';
  }
  if (status === 409 && code === 'lock-changed') return 'locked';
  if (status === 409 && code === 'locking-disabled') return 'stale';
  if (status === 423) return 'locked';
  if (status === 401) return 'session';
  if (status === 403 || status === 404) return 'stale';
  return 'refused';
}
