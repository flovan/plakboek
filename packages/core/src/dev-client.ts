/**
 * Development-only: adds Vite's client to a server-rendered HTML response so
 * the browser receives the `full-reload` message the plugin sends when a
 * server module changes. Visitor pages ship no client React, so there is
 * nothing to hot-swap; a whole-page reload is the live-reload mechanism.
 */

const DEV_CLIENT_TAG = '<script type="module" src="/@vite/client"></script>';

/**
 * Returns the response with the Vite client inserted immediately before
 * `</head>`. Anything that is not a 200 HTML document with a head, and any
 * body-less response, is returned unchanged. ETag and Content-Length are
 * dropped because the body changes.
 */
export async function injectDevClient(response: Response): Promise<Response> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (
    response.status !== 200 ||
    response.body === null ||
    !contentType.toLowerCase().includes('text/html')
  ) {
    return response;
  }

  const html = await response.text();
  const headEnd = html.indexOf('</head>');
  const body =
    headEnd === -1
      ? html
      : `${html.slice(0, headEnd)}${DEV_CLIENT_TAG}${html.slice(headEnd)}`;

  const headers = new Headers(response.headers);
  headers.delete('ETag');
  headers.delete('Content-Length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
