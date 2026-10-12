/**
 * The default `robots.txt`: crawlers are told to stay out of `/cms`. A host
 * that ships its own `public/robots.txt` owns the file: the static layer
 * (the production server, and Vite in development) serves it before any route
 * is consulted, so this route never runs for such a host.
 */

const BODY = 'User-agent: *\nDisallow: /cms\n';

export function loader(): Response {
  return new Response(BODY, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
