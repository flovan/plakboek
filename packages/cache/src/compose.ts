/**
 * Multi-layer purge fan-out (D-17). A deployment can hold several cache
 * layers, an in-process LRU and later a reverse proxy or CDN; a publish must
 * purge every one of them, and one failing layer must never stop the others.
 */
import type { CacheInvalidator } from './backend.js';
import { pageTag } from './tags.js';

/** Thrown by a composed purge when one or more layers failed. The message
 * names the failure count only: a layer's own error can quote its endpoint
 * or credentials, so the errors travel in `failures` for the caller's hook. */
export class CachePurgeError extends Error {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[], layerCount: number) {
    super(
      `[@plakboek/cache] ${failures.length} of ${layerCount} cache layers failed to purge`,
    );
    this.name = 'CachePurgeError';
    this.failures = failures;
  }
}

/**
 * Fans one purge out to every layer in parallel. Every layer is called even
 * when another rejects; when any rejected, the returned promise rejects with
 * a `CachePurgeError` carrying every failure.
 */
export function composeInvalidators(
  ...layers: readonly CacheInvalidator[]
): CacheInvalidator {
  return {
    async purge(tags) {
      const settled = await Promise.allSettled(
        layers.map(async (layer) => await layer.purge(tags)),
      );
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length > 0) {
        throw new CachePurgeError(failures, layers.length);
      }
    },
  };
}

/**
 * Purges the page tag of each page id. An empty list makes no call. This is
 * the one-liner a scheduled publish or a subtree write calls from its own
 * after-commit step (D-19).
 */
export async function purgePageTags(
  invalidator: CacheInvalidator,
  pageIds: readonly string[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await invalidator.purge(pageIds.map((id) => pageTag(id)));
}
