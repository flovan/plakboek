import { plakboek } from '@plakboek/core/vite';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site/index.ts',
    }),
    reactRouter(),
  ],
});
