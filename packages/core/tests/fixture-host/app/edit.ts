import type { EditEntrypoint } from '@plakboek/render/server';

// A test fixture only: it performs no session check. The real entrypoint
// (Phase 7) verifies the editor's session before answering.
export const edit: EditEntrypoint = () =>
  Promise.resolve(
    new Response('edit seam reached', {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    }),
  );
