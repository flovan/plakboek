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
]);
