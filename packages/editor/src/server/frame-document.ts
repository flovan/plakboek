/**
 * The framed site (`<path>?_edit=frame`): the host's own document, rendered
 * for an editor.
 *
 * What the frame holds depends on what the signed-in user may do, decided
 * here on the server from the identity the entrypoint resolved:
 *
 * - `pages:edit`: the live working tree, unpublished changes and draft-only
 *   pages included, with the live proxy attributes on every block.
 * - `pages:read-drafts` without edit: the same working tree, rendered as
 *   plain markup identical to what a visitor receives, with no attribute.
 * - neither: the published page, exactly as a visitor sees it.
 *
 * The document is composed by the host's own `renderDocument` with mode
 * `'edit'`. Nothing is added to it: no element, script, style or attribute
 * beyond what the host and its blocks produce plus the live attributes. A
 * missing page is the host's own not-found document inside the frame, and a
 * failed render is a small editor-owned document carrying only the
 * `plakboek-frame-error` marker the shell reads, never an error's text.
 */
import {
  resolveEditablePage,
  resolveVisitorPage,
  type PagesConfig,
} from '@plakboek/pages';
import {
  normalizeVisitorPath,
  renderPageSnapshot,
  renderPageTree,
  type BlockMeta,
  type EditRequestContext,
  type RenderedPage,
  type RenderedTree,
} from '@plakboek/render/server';
import { FRAME_ERROR_MARKER } from '../chrome/island.js';
import type { EditEntrypointDeps } from './entrypoint.js';
import { buildCmsDocument, frameHeaders } from './html-document.js';
import type { EditorIdentity } from './identity.js';
import { editLocation, pathOf } from './locations.js';

export { FRAME_ERROR_MARKER };

/** Block type key to the label and kind the overlay shows. */
export function buildBlockMeta(
  config: Pick<PagesConfig, 'blocks'>,
): ReadonlyMap<string, BlockMeta> {
  return new Map(
    config.blocks.map((block) => [
      block.key,
      {
        label: block.editor.label,
        kind: block.kind === 'section' ? 'section' : 'block',
      } satisfies BlockMeta,
    ]),
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Reports a failed frame render by error name only: a message can quote
 * stored content or query parameters. */
function reportFrameError(
  deps: EditEntrypointDeps,
  publicPath: string,
  pageId: string | null,
  error: unknown,
): void {
  const hook = deps.hooks?.onRenderError;
  try {
    if (hook !== undefined) {
      hook({ publicPath, pageId, error });
      return;
    }
    // oxlint-disable-next-line no-console -- default fallback when the host supplies no render hook; carries the path, the page id and the error name only
    console.error('[@plakboek/editor] frame render failed', {
      publicPath,
      pageId,
      error: errorName(error),
    });
  } catch {
    // A broken hook never takes the response down with it.
  }
}

function frameResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: frameHeaders() });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

const FALLBACK_NOT_FOUND = buildCmsDocument({
  title: 'Not found',
  bodyHtml: '<h1>Not found</h1>',
});

/** The host's not-found document with the status forced to 404, or a
 * minimal one when the host set none or its hook failed. */
async function notFoundResponse(
  deps: EditEntrypointDeps,
  request: Request,
  publicPath: string,
): Promise<Response> {
  if (deps.notFound !== undefined) {
    try {
      const host: unknown = await deps.notFound(request);
      if (!(host instanceof Response)) {
        throw new TypeError('the notFound hook must return a Response');
      }
      return new Response(host.body, {
        status: 404,
        headers: frameHeaders(),
      });
    } catch (error) {
      reportFrameError(deps, publicPath, null, error);
    }
  }
  return frameResponse(FALLBACK_NOT_FOUND, 404);
}

const RENDER_FAILED = buildCmsDocument({
  title: 'Plakboek',
  headHtml: `<meta name="${FRAME_ERROR_MARKER}" content="render">`,
  bodyHtml: '',
});

/**
 * Renders the frame for one request. Never throws: a failure becomes the
 * marker document with status 500.
 */
export async function renderFrameDocument(
  deps: EditEntrypointDeps,
  blockMeta: ReadonlyMap<string, BlockMeta>,
  identity: EditorIdentity,
  request: Request,
  context: EditRequestContext,
): Promise<Response> {
  const { url, visitorLocation } = context;
  const failedPath = url.pathname.slice(0, 2048);
  let pageId: string | null = null;
  try {
    // A frame URL opened as a top-level document is not the editing
    // surface: send it to the shell for the same page.
    if (request.headers.get('sec-fetch-dest') === 'document') {
      return redirect(
        editLocation(pathOf(visitorLocation), visitorLocation, '1'),
      );
    }

    const normalized = normalizeVisitorPath(url.pathname);
    if (normalized.kind === 'not-found') {
      return await notFoundResponse(deps, request, failedPath);
    }
    if (normalized.kind === 'redirect') {
      return redirect(
        editLocation(normalized.location, visitorLocation, 'frame'),
      );
    }
    const key = normalized.path;
    const { config, homeSlug, hooks: pagesHooks } = deps.pages;
    const resolveInput = {
      publicPath: key,
      locales: config.content.locales,
      defaultLocale: config.content.defaultLocale,
      homeSlug,
    };
    const common = {
      components: deps.components,
      hooks: deps.hooks,
      siteUrl: deps.siteUrl,
      resolveAssetUrl: deps.resolveAssetUrl,
    };

    let rendered: RenderedTree | RenderedPage;
    let publicPath: string;
    if (identity.canEdit || identity.canReadDrafts) {
      const resolution = await resolveEditablePage(
        deps.db,
        resolveInput,
        pagesHooks,
      );
      if (resolution.kind === 'redirect') {
        return redirect(
          editLocation(resolution.location, visitorLocation, 'frame'),
        );
      }
      if (resolution.kind === 'invalid-pattern') {
        reportFrameError(deps, key, null, resolution.error);
        return await notFoundResponse(deps, request, key);
      }
      if (resolution.kind === 'not-found') {
        return await notFoundResponse(deps, request, key);
      }
      if (resolution.publicPath !== key) {
        return redirect(
          editLocation(resolution.publicPath, visitorLocation, 'frame'),
        );
      }
      publicPath = resolution.publicPath;
      pageId = resolution.page.id;
      rendered = renderPageTree({
        ...common,
        page: resolution.page,
        blocks: resolution.blocks,
        publicPath,
        blockMeta,
        mode: identity.canEdit ? 'live' : 'plain',
      });
    } else {
      const resolution = await resolveVisitorPage(deps.db, resolveInput);
      if (resolution.kind === 'redirect') {
        return redirect(
          editLocation(resolution.location, visitorLocation, 'frame'),
        );
      }
      if (resolution.kind === 'invalid-pattern') {
        reportFrameError(deps, key, null, resolution.error);
        return await notFoundResponse(deps, request, key);
      }
      if (resolution.kind === 'not-found') {
        return await notFoundResponse(deps, request, key);
      }
      if (resolution.publicPath !== key) {
        return redirect(
          editLocation(resolution.publicPath, visitorLocation, 'frame'),
        );
      }
      publicPath = resolution.publicPath;
      pageId = resolution.view.page.id;
      rendered = renderPageSnapshot({
        ...common,
        view: resolution.view,
        publicPath,
      });
    }

    const html = await deps.renderDocument({
      head: rendered.head,
      body: rendered.body,
      publicPath,
      mode: 'edit',
    });
    return frameResponse(html, 200);
  } catch (error) {
    reportFrameError(deps, failedPath, pageId, error);
    return frameResponse(RENDER_FAILED, 500);
  }
}
