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
  plugins: [
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site.ts',
    }),
    ...(process.env.E2E_REFRESH_PROBE === '1' ? [refreshProbe()] : []),
    reactRouter(),
  ],
});
