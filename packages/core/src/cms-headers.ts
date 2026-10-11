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

/**
 * Runs a `/cms` handler and returns its response with the header set. A
 * handler that throws (an invalid environment, a database failure) is answered
 * with a plain 500 that carries the same header, so no error path under `/cms`
 * can be indexed and none carries an error message. Only the error's name is
 * logged: a message could hold a connection string or a path.
 */
export async function cmsGuard(
  run: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    return withCmsHeaders(await run());
  } catch (error) {
    process.stderr.write(
      `[@plakboek/core] /cms request failed: ${error instanceof Error ? error.name : typeof error}\n`,
    );
    return withCmsHeaders(
      new Response('Internal Server Error', {
        status: 500,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
    );
  }
}
