/**
 * Visitor path canonicalisation: the first thing every request goes through,
 * before the cache is read and before any database statement.
 *
 * Recorded rules (discretion for the address-normalisation decisions):
 *
 * - Runs of `/` collapse to one, a trailing `/` is dropped (except for the
 *   root `/`) and letters are lowercased. A request whose path is not already
 *   in that form is answered with a redirect to the canonical spelling, so
 *   every spelling of a page maps to one cache key.
 * - A canonical path must match `^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$`. Anything
 *   else, or a path longer than `MAX_VISITOR_PATH_LENGTH`, cannot be a stored
 *   address and is a not-found without a lookup.
 *
 * Why the filter is complete: a stored address is a page URL pattern's
 * literals, a locale code and slugs. `@plakboek/pages` restricts pattern
 * literals to lowercase letters, digits, hyphens and `/`, slugs follow
 * `SLUG_PATTERN` and locales follow `LOCALE_PATTERN`, so every address a page
 * can have is inside this alphabet and the filter can never reject a real
 * page.
 *
 * The shape is checked on the canonical form before any redirect is built, so
 * junk is never redirected and a protocol-relative `//host/x` collapses to
 * `/host/x`, which is a plain same-origin path, never a `Location` that
 * leaves the site.
 */

/** A longer path is rejected without a lookup. */
export const MAX_VISITOR_PATH_LENGTH = 2048;

export type VisitorPathResult =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'not-found' };

const CANONICAL_PATH_PATTERN = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;

/** Canonicalises a request pathname into one cache key, a redirect or a 404. */
export function normalizeVisitorPath(pathname: string): VisitorPathResult {
  if (pathname.length > MAX_VISITOR_PATH_LENGTH) return { kind: 'not-found' };

  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const trimmed =
    collapsed.length > 1 && collapsed.endsWith('/')
      ? collapsed.slice(0, -1)
      : collapsed;
  const canonical = trimmed.toLowerCase();

  if (!CANONICAL_PATH_PATTERN.test(canonical)) return { kind: 'not-found' };
  if (canonical !== pathname) return { kind: 'redirect', location: canonical };
  return { kind: 'ok', path: canonical };
}
