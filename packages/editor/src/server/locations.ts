/**
 * The two URLs of one edited page. The handler hands an entrypoint the page's
 * `visitorLocation` (the path and query without `_edit`); the shell lives at
 * that location plus `_edit=1` and the framed site at the same location plus
 * `_edit=frame`, so the page's own query string is kept in both.
 */
import { EDIT_PARAM } from '@plakboek/render';

/** The pathname of a location. */
export function pathOf(location: string): string {
  const separator = location.indexOf('?');
  return separator === -1 ? location : location.slice(0, separator);
}

/** `path` plus the query of `visitorLocation` and one `_edit` value. */
export function editLocation(
  path: string,
  visitorLocation: string,
  value: 'frame' | '1',
): string {
  const separator = visitorLocation.indexOf('?');
  const query = separator === -1 ? '' : visitorLocation.slice(separator + 1);
  const parts = [query, `${EDIT_PARAM}=${value}`].filter((part) => part !== '');
  return `${path}?${parts.join('&')}`;
}

/** The framed site's URL for a visitor location. */
export function frameLocation(visitorLocation: string): string {
  return editLocation(pathOf(visitorLocation), visitorLocation, 'frame');
}
