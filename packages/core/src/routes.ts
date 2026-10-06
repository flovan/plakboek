/**
 * The CMS's route table. A host spreads `cmsRoutes()` into its own
 * `app/routes.ts`; every `file` is an absolute path to a built route module
 * inside this package.
 *
 * Precedence: React Router matches by specificity and, between equally
 * specific routes, the earlier entry wins. The visitor splat does not match
 * `/`, so the visitor route also has an index entry. A host therefore writes
 *
 *   export default [...hostRoutes, ...cmsRoutes()] satisfies RouteConfig;
 *
 * with its own routes first: they win every tie, including a host index route
 * at `/`, and every path the host does not claim falls through to the CMS.
 *
 * Reserved paths: `/cms/*` (health and first-run setup now, the editor later) and
 * `/api/auth/*` belong to the CMS. A page whose first slug segment is `cms`
 * or `api` is shadowed by them and unreachable; reserved-slug enforcement is
 * carried to Phase 7.
 */
import { fileURLToPath } from 'node:url';
import { index, route, type RouteConfigEntry } from '@react-router/dev/routes';

/** Works natively and inside Vite's config loader alike. */
function file(name: string): string {
  return fileURLToPath(new URL(`./route-modules/${name}.js`, import.meta.url));
}

export function cmsRoutes(): RouteConfigEntry[] {
  return [
    route('cms/health', file('health'), { id: 'plakboek-health' }),
    route('cms/setup', file('setup'), { id: 'plakboek-setup' }),
    route('cms/setup/test-email', file('test-email'), {
      id: 'plakboek-setup-test-email',
    }),
    route('api/auth/*', file('auth-api'), { id: 'plakboek-auth' }),
    // The visitor entries stay last: a splat does not match "/", so the
    // visitor route needs both an index and a splat entry.
    index(file('visitor'), { id: 'plakboek-visitor-index' }),
    route('*', file('visitor'), { id: 'plakboek-visitor' }),
  ];
}
