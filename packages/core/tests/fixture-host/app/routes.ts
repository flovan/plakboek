import { cmsRoutes } from '@plakboek/core/routes';
import { index, route, type RouteConfig } from '@react-router/dev/routes';

// With FIXTURE_HOST_INDEX=1 the host claims "/" itself; its routes come first.
const hostIndex =
  process.env.FIXTURE_HOST_INDEX === '1' ? [index('home.tsx')] : [];

export default [
  ...hostIndex,
  route('hello', 'hello.tsx'),
  ...cmsRoutes(),
] satisfies RouteConfig;
