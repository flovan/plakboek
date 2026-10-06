import { plakboek } from '@plakboek/core/vite';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site/index.ts',
    }),
    reactRouter(),
  ],
});
