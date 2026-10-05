import { cmsRoutes } from '@plakboek/core/routes';
import { route, type RouteConfig } from '@react-router/dev/routes';

export default [
  route('hello', 'hello.tsx'),
  ...cmsRoutes(),
] satisfies RouteConfig;
