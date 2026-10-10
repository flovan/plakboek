import { cmsRoutes } from '@plakboek/core/routes';
import type { RouteConfig } from '@react-router/dev/routes';

export default [...cmsRoutes()] satisfies RouteConfig;
