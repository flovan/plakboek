import { QueryClient } from '@tanstack/react-query';

/** The mutation scope every page write shares, so writes run one after another. */
export const WRITE_SCOPE_ID = 'plakboek-page-writes';

/** What a failed request carries: null status means the request never got an answer. */
export type ApiFailure = { readonly status: number | null };

const MAX_WRITE_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4000;

function failureStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const { status } = error as { status: unknown };
  if (status === null) return -1;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Retry a failed write only when repeating it can help: the network dropped it
 * or the server failed. A 4xx (stale version, lock, validation) must surface.
 */
export function shouldRetryWrite(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= MAX_WRITE_RETRIES) return false;
  const status = failureStatus(error);
  return status === -1 || (status !== undefined && status >= 500);
}

/** Exponential backoff for write retries: 500, 1000, 2000, then 4000 ms. */
export function writeRetryDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export function createEditorQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 0 },
      mutations: {
        // The default network mode pauses a mutation while the browser says it
        // is offline, so an offline write would never fail and never offer a
        // Retry. A write is always tried: a dropped request is a network failure.
        networkMode: 'always',
        retry: shouldRetryWrite,
        retryDelay: writeRetryDelay,
      },
    },
  });
}
