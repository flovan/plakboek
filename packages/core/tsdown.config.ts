import { readdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

// One build entry per route module, read from disk so adding a module never
// edits this file.
const routeModules = Object.fromEntries(
  readdirSync(new URL('./src/route-modules', import.meta.url))
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => {
      const base = name.replace(/\.tsx?$/, '');
      return [`route-modules/${base}`, `src/route-modules/${name}`];
    }),
);

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    routes: 'src/routes.ts',
    vite: 'src/vite.ts',
    server: 'src/server.ts',
    cli: 'src/cli/index.ts',
    ...routeModules,
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  fixedExtension: false,
  deps: { neverBundle: ['virtual:plakboek/host'] },
});
