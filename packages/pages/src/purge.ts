/**
 * The one registration point for cache purges from this package's write
 * paths. Every write that changes what a visitor can see purges after its
 * transaction commits (D-18, D-19): purging first would let a concurrent
 * visitor re-fill the old HTML, and purging for a refused or rolled-back
 * write would only cost cache hits. The tag list is computed inside the
 * transaction from rows the mutation already locked, then handed to
 * `context.afterCommit`, which the audit recorder runs only once the
 * transaction has committed and never lets fail the write.
 *
 * Internal wiring: withheld from the barrel, so a host cannot register a
 * purge for a write this package did not perform.
 */
import type { AuditMutationContext } from '@plakboek/auth';
import { GLOBAL_TAG, purgePageTags } from '@plakboek/cache';
import type { PagesDeps } from './config.js';

/** Registers an after-commit purge of the page tag of every given page.
 * Registers nothing when the deps carry no invalidator or the list is empty;
 * repeated ids are purged once. */
export function registerPagePurge(
  deps: PagesDeps,
  context: AuditMutationContext,
  pageIds: readonly string[],
): void {
  const { invalidator } = deps;
  if (invalidator === undefined || pageIds.length === 0) return;
  const ids = [...new Set(pageIds)];
  context.afterCommit(async () => {
    await purgePageTags(invalidator, ids);
  });
}

/** Registers an after-commit purge of the `global` tag, for a change that
 * can alter every cached page (a URL pattern change, a locale purge). */
export function registerGlobalPurge(
  deps: PagesDeps,
  context: AuditMutationContext,
): void {
  const { invalidator } = deps;
  if (invalidator === undefined) return;
  context.afterCommit(async () => {
    await invalidator.purge([GLOBAL_TAG]);
  });
}
