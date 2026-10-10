---
'@plakboek/core': minor
---

Serves the admin entry. `cmsRoutes()` now includes `/cms` and `/cms/*` (the login page and its email-link landings, with the host's own 404 for anything else, never a visitor page), `POST /cms/logout` and a default `/robots.txt` that disallows `/cms`. Logout ends the session on the server, accepts only requests from this site's own pages, reads at most 2 KB and redirects to a sanitised `next` without `_edit`. Every answer under `/cms`, including health, setup, logout and the 404, now carries `X-Robots-Tag: noindex, nofollow`, set by the route modules so it also holds under `react-router dev`. A host's own `public/robots.txt` is served instead of the default. When the host runtime is first built it reports pages that already sit at a reserved address (`cms` or `api` as the first segment) through the pages hook, keeping them as they are.
