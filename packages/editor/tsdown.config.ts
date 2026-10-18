import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: { server: 'src/server.ts' },
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: true,
    fixedExtension: false,
  },
  {
    entry: { client: 'src/client.ts' },
    format: 'esm',
    platform: 'browser',
    dts: true,
    clean: false,
    fixedExtension: false,
  },
  {
    entry: { hot: 'src/hot.ts' },
    format: 'esm',
    platform: 'browser',
    dts: true,
    clean: false,
    fixedExtension: false,
    // The one value it needs from the render package is a constant; bundling
    // it keeps React, which that package's root also exports, out of the graph.
    deps: { alwaysBundle: ['@plakboek/render'] },
  },
]);
