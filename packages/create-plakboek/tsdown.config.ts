import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  // Conservative target: the Node version check must be able to run and print
  // its error on a runtime older than the supported floor.
  target: 'node18',
  dts: false,
  clean: true,
  fixedExtension: false,
});
