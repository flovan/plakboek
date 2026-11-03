import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', 'rich-text': 'src/rich-text/index.ts' },
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  fixedExtension: false,
});
