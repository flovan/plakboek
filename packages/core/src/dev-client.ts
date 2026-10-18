/**
 * Development-only: adds Vite's client and the block swap module to a
 * server-rendered HTML response, so the browser receives what the plugin
 * sends when a server module changes: a `full-reload`, or for a block change
 * the `plakboek:blocks-changed` event that the swap module answers by
 * replacing just the changed blocks (D-29). Visitor pages ship no client
 * React, so this is the only client code a development page runs.
 */

const DEV_CLIENT_TAG =
  '<script type="module" src="/@vite/client"></script><script type="module" src="/@id/__x00__virtual:plakboek/dev-swap"></script>';

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
