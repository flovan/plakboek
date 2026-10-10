/**
 * The header every `/cms` response carries: the admin entry, its link
 * landings, health, setup and logout must never be indexed (EDIT-02, D-22).
 *
 * It is applied by the route modules themselves, not by the Hono layer, so it
 * also holds under `react-router dev`, where there is no Hono layer, and for
 * every path casing React Router matches.
 */

/** The value of `X-Robots-Tag` on every `/cms` response. */
export const CMS_ROBOTS_TAG = 'noindex, nofollow';

/**
 * The same response with `X-Robots-Tag: noindex, nofollow` set. Every other
 * header, the status and the body are kept. A new `Response` is built rather
 * than the headers mutated, because the headers of a response that came from
 * `fetch` or `Response.redirect` are immutable.
 */
export function withCmsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', CMS_ROBOTS_TAG);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
