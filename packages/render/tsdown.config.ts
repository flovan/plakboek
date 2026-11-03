import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', server: 'src/server.ts' },
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  fixedExtension: false,
  outputOptions: {
    // The edit-mode attribute names get a chunk of their own, so a consumer
    // that needs only them (the editor's framework-free hot entry) does not
    // pull in the React code that shares the root and server entries.
    codeSplitting: {
      groups: [{ name: 'live-edit', test: /src\/live-edit\.ts$/ }],
    },
  },
});
