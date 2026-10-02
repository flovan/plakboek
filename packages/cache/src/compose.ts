/**
 * Multi-layer purge fan-out (D-17). A deployment can hold several cache
 * layers, an in-process LRU and later a reverse proxy or CDN; a publish must
 * purge every one of them, and one failing layer must never stop the others.
 */
import type { CacheInvalidator } from './backend.js';
import { pageTag } from './tags.js';

/** Thrown by a composed purge when one or more layers failed. The message
 * names the failure count only: a layer's own error can quote its endpoint
 * or credentials, so the errors travel in `failures` for the caller's hook.
 * `failedLayers` holds the zero-based position, in the order the layers were
 * given to `composeInvalidators`, of each layer that failed, parallel to
 * `failures`, so a log can name which layer needs attention. */
export class CachePurgeError extends Error {
  readonly failures: readonly unknown[];
  readonly failedLayers: readonly number[];

  constructor(
    failures: readonly unknown[],
    layerCount: number,
    failedLayers: readonly number[] = [],
  ) {
    super(
      `[@plakboek/cache] ${failures.length} of ${layerCount} cache layers failed to purge`,
    );
    this.name = 'CachePurgeError';
    this.failures = failures;
    this.failedLayers = failedLayers;
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
      const failures: unknown[] = [];
      const failedLayers: number[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          failures.push(result.reason as unknown);
          failedLayers.push(index);
        }
      });
      if (failures.length > 0) {
        throw new CachePurgeError(failures, layers.length, failedLayers);
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
