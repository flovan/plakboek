import { reactRouter } from '@react-router/dev/vite';
import { plakboek } from '@plakboek/core/vite';
import { defineConfig, type Plugin } from 'vite';

const EDITOR_CLIENT = '\0virtual:plakboek/editor-client';

/**
 * Test-only: with E2E_REFRESH_PROBE=1 the editor's client module also loads
 * a stateful probe component, so the Fast Refresh spec can edit it on disk.
 */
function refreshProbe(): Plugin {
  const probe = new URL('./app/refresh-probe.tsx', import.meta.url).pathname;
  return {
    name: 'e2e-refresh-probe',
    transform(code, id) {
      if (id !== EDITOR_CLIENT) return undefined;
      return `${code}\nimport ${JSON.stringify(probe)};`;
    },
  };
}

// No `edit` option: the real editor is composed here once it exists.
export default defineConfig({
  // The editor package is linked from this workspace, so Vite treats it as
  // source and meets its client dependencies only when the first edit page
  // loads. Optimizing one of them then reloads the page mid-hydration, which
  // the dev specs cannot wait out, so it is optimized at startup. An installed
  // editor is optimized as a whole and needs no such line.
  optimizeDeps: {
    include: ['@plakboek/core > @plakboek/editor > @tanstack/react-query'],
  },
  plugins: [
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site.ts',
    }),
    ...(process.env.E2E_REFRESH_PROBE === '1' ? [refreshProbe()] : []),
    reactRouter(),
  ],
});
