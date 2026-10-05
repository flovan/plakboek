/**
 * The CMS's route table. A host spreads `cmsRoutes()` into its own
 * `app/routes.ts`; every `file` is an absolute path to a built route module
 * inside this package.
 */
import { fileURLToPath } from 'node:url';
import { index, route, type RouteConfigEntry } from '@react-router/dev/routes';

/** Works natively and inside Vite's config loader alike. */
function file(name: string): string {
  return fileURLToPath(new URL(`./route-modules/${name}.js`, import.meta.url));
}

export function cmsRoutes(): RouteConfigEntry[] {
  return [
    // A splat does not match "/", so the visitor route needs both entries.
    index(file('visitor'), { id: 'plakboek-visitor-index' }),
    route('*', file('visitor'), { id: 'plakboek-visitor' }),
  ];
}
