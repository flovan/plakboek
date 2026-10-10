import { reactRouter } from '@react-router/dev/vite';
import { plakboek } from '@plakboek/core/vite';
import { defineConfig } from 'vite';

// No `edit` option: the real editor is composed here once it exists.
export default defineConfig({
  plugins: [
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site.ts',
    }),
    reactRouter(),
  ],
});
