/**
 * The editor's server entry behind the visitor handler's `_edit` seam.
 *
 * Two requests reach it, both for a page the visitor handler would serve at
 * the same path:
 *
 * - `?_edit=1`: the edit shell, an editor-owned document holding the chrome
 *   and one same-origin iframe used purely as a viewport.
 * - `?_edit=frame`: the framed site itself, the host's own document rendered
 *   for the live working tree.
 *
 * Both re-read the session, the two-factor gate and the role on the server on
 * every request; nothing a client sends other than the session cookie is
 * trusted. Without a session the entrypoint answers `null` and the visitor
 * handler bounces to the plain page.
 */
import {
  needsTwoFactorEnrolment,
  sanitizeNextPath,
  TWO_FACTOR_ENROLMENT_PATH,
  type Auth,
} from '@plakboek/auth';
import type { PagesConfig, PagesDeps, PagesHooks } from '@plakboek/pages';
import type { PermissionResolver } from '@plakboek/permissions';
import { EDIT_PARAM, type RenderDocument } from '@plakboek/render';
import type {
  ComponentMap,
  EditEntrypoint,
  RenderHooks,
} from '@plakboek/render/server';
import type { EditorAssets } from './assets.js';
import { buildBlockMeta, renderFrameDocument } from './frame-document.js';
import { readEditorIdentity } from './identity.js';

export type EditEntrypointDeps = {
  /** Verifies the session cookie; only `api.getSession` is used. */
  readonly auth: Pick<Auth, 'api'>;
  readonly resolver: PermissionResolver;
  readonly db: PagesDeps['db'];
  readonly pages: {
    readonly config: PagesConfig;
    /** The page served at a locale's root, as for the visitor handler. */
    readonly homeSlug: string;
    readonly hooks?: PagesHooks;
  };
  /** The visitor handler's component map, so the frame renders the same
   * blocks. */
  readonly components: ComponentMap;
  /** The host's own document composer; the frame calls it with mode
   * `'edit'`. */
  readonly renderDocument: RenderDocument;
  readonly hooks?: RenderHooks;
  /** The host's not-found page, shown inside the frame with status 404. */
  readonly notFound?: (request: Request) => Response | Promise<Response>;
  readonly siteUrl?: string;
  readonly resolveAssetUrl?: (assetId: string) => string | null;
  /** The built editor client the shell loads. */
  readonly assets: EditorAssets;
  /** Whether the shell sends its Content-Security-Policy. */
  readonly csp: boolean;
};

/** Builds the edit entrypoint over its dependencies. */
export function createEditEntrypoint(deps: EditEntrypointDeps): EditEntrypoint {
  const blockMeta = buildBlockMeta(deps.pages.config);

  return async (request, context) => {
    const identity = await readEditorIdentity(
      deps.auth,
      deps.resolver,
      request,
    );
    if (identity === null) return null;

    const wantsFrame = context.url.searchParams.get(EDIT_PARAM) === 'frame';
    if (needsTwoFactorEnrolment(identity)) {
      if (wantsFrame) return null;
      const next = encodeURIComponent(
        sanitizeNextPath(context.visitorLocation),
      );
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${TWO_FACTOR_ENROLMENT_PATH}?next=${next}`,
          'Cache-Control': 'no-store',
        },
      });
    }

    if (wantsFrame) {
      return await renderFrameDocument(
        deps,
        blockMeta,
        identity,
        request,
        context,
      );
    }
    return null;
  };
}
