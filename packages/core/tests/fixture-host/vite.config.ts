import { reactRouter } from '@react-router/dev/vite';
import { plakboek } from '@plakboek/core/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site.ts',
      edit: './app/edit.ts',
    }),
    reactRouter(),
  ],
});
