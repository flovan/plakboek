/**
 * `If-None-Match` evaluation for the visitor handler. Module-level on
 * purpose: it is part of the handler's behaviour, not of the package's public
 * API.
 */

const WEAK_PREFIX = 'W/';

/** An entity tag is a quoted opaque string, optionally weak. */
function opaqueTag(candidate: string): string | null {
  const tag = candidate.startsWith(WEAK_PREFIX)
    ? candidate.slice(WEAK_PREFIX.length)
    : candidate;
  return tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')
    ? tag
    : null;
}

/**
 * Whether an `If-None-Match` header names `etag`. `*` matches anything; a
 * comma separated list matches when any entry does, and the comparison is the
 * weak one (a `W/` prefix is ignored on both sides), which is what
 * `If-None-Match` uses. An entry that is not a quoted tag never matches and
 * never throws, and the header is split once, so a hostile header costs time
 * linear in its length.
 */
export function matchesIfNoneMatch(
  header: string | null,
  etag: string,
): boolean {
  if (header === null) return false;
  if (header.trim() === '*') return true;
  const target = opaqueTag(etag);
  if (target === null) return false;
  for (const entry of header.split(',')) {
    if (opaqueTag(entry.trim()) === target) return true;
  }
  return false;
}
