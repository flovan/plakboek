import { cmsRoutes } from '@plakboek/core/routes';
import type { RouteConfig, RouteConfigEntry } from '@react-router/dev/routes';

// Routes of your own, for example route('contact', 'routes/contact.tsx').
// They come first, so they win over every CMS route, including a host index
// route at "/". Every path you do not claim falls through to the CMS pages.
// Link to CMS pages with a plain <a href>: they have no client route module.
const hostRoutes: RouteConfigEntry[] = [];

export default [...hostRoutes, ...cmsRoutes()] satisfies RouteConfig;
