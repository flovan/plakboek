/**
 * The one open-redirect guard for a `next` value: the page a user was on
 * when they started signing in, carried through emailed links, the login
 * modal and the `/cms` redirects (D-09, D-11).
 *
 * `sanitizeNextPath` accepts only a same-origin relative path and answers `/`
 * for everything else, so a caller never has to decide what to do with a bad
 * value: it lands home.
 */

/** Longest `next` accepted, in characters. */
const MAX_NEXT_LENGTH = 2048;

/** Only the scheme and host of this URL are ever looked at; it is never
 * requested and never returned. */
const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

/** The query parameter that switches the site into edit mode. It must not
 * survive into a `next`, or following the link would re-enter edit mode. */
const EDIT_PARAM = '_edit';

const BACKSLASH = 0x5c;
const LAST_C0_CONTROL = 0x1f;
const DELETE = 0x7f;

/** Raw control characters (C0 and DEL) and backslashes: browsers read a
 * backslash as a slash, and a control character can split a header. */
function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= LAST_C0_CONTROL || code === DELETE || code === BACKSLASH) {
      return true;
    }
  }
  return false;
}

/** The same characters in percent-encoded form (`%00`-`%1f`, `%7f`, `%5c`). */
const FORBIDDEN_ENCODED = /%(?:[01][0-9a-f]|7f|5c)/i;

/** Paths the shell and the auth API own; following one back would loop. */
const RESERVED_PATH = /^\/(?:cms|api)(?:\/|$)/i;

/** Whether `path`, or its percent-decoded form, is a reserved target. A
 * malformed escape cannot be decoded, so it is refused. */
function isReservedPath(path: string): boolean {
  if (RESERVED_PATH.test(path)) {
    return true;
  }
  try {
    return RESERVED_PATH.test(decodeURIComponent(path));
  } catch {
    return true;
  }
}

/** The query string without any `_edit` parameter, in its original
 * encoding, or the empty string when nothing is left. */
function queryWithoutEdit(search: string): string {
  const kept = search
    .slice(1)
    .split('&')
    .filter((segment) => {
      if (segment === '') {
        return false;
      }
      return new URLSearchParams(segment).keys().next().value !== EDIT_PARAM;
    });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/**
 * Returns `raw` as a same-origin path (with its query, without a fragment),
 * or `/` when it is not one.
 *
 * Refused: anything that is not a string; the empty string; more than 2048
 * characters; a value that does not start with a single `/` (so no absolute,
 * protocol-relative or scheme URL); backslashes and control characters, raw
 * or percent-encoded; any target under `/cms` or `/api`, whatever the case
 * and however it is encoded or reached through dot segments. Runs of slashes
 * in the path collapse to one, and every `_edit` parameter is removed.
 */
export function sanitizeNextPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    return '/';
  }
  if (raw.length > MAX_NEXT_LENGTH) {
    return '/';
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }
  if (hasForbiddenCharacter(raw) || FORBIDDEN_ENCODED.test(raw)) {
    return '/';
  }
  if (!URL.canParse(raw, PLACEHOLDER_ORIGIN)) {
    return '/';
  }
  const url = new URL(raw, PLACEHOLDER_ORIGIN);
  if (url.origin !== PLACEHOLDER_ORIGIN) {
    return '/';
  }
  const pathname = url.pathname.replaceAll(/\/{2,}/g, '/');
  if (isReservedPath(pathname)) {
    return '/';
  }
  return `${pathname}${queryWithoutEdit(url.search)}`;
}
