/**
 * The editor's JSON API under `/cms/api`: a request handler like the edit
 * entrypoint, not a router. Core hands it every request that reaches that
 * prefix; it answers `null` for a path outside it and a JSON 404 for an
 * unknown path inside it.
 *
 * Every request goes through the same gate, in order: the route must exist
 * for the method, a state-changing request must come from this site, the
 * session is read from the cookie on every request (never cached), the role
 * must be able to edit pages and, when its role demands one, have a second
 * factor. Only then is a body read (JSON, capped, parsed with zod) and the
 * route run. Whatever is thrown on the way becomes a coded JSON answer.
 */
import { needsTwoFactorEnrolment, type Auth } from '@plakboek/auth';
import { PageLockedError, type PagesDeps } from '@plakboek/pages';
import type { PermissionResolver } from '@plakboek/permissions';
import type { ComponentMap, RenderHooks } from '@plakboek/render/server';
import { EDITOR_API_BASE, type LockView } from '../../api-types.js';
import { buildCatalogue } from '../catalogue.js';
import { buildBlockMeta } from '../frame-document.js';
import { readEditorIdentity } from '../identity.js';
import { editPage } from './edit.js';
import { previewPage } from './preview.js';
import {
  apiErrorFor,
  ApiHttpError,
  checkOrigin,
  jsonResponse,
  readJsonBody,
} from './http.js';
import {
  editBody,
  emptyBody,
  openBody,
  pageIdParam,
  parseWith,
  previewBody,
} from './schemas.js';
import {
  acquireLock,
  lockViewOf,
  openPage,
  readLock,
  readTree,
  releaseLock,
  renewLock,
  takeOverLock,
  type ApiContext,
} from './session.js';

export type EditorApiDeps = {
  /** Verifies the session cookie; only `api.getSession` is used. */
  readonly auth: Pick<Auth, 'api'>;
  readonly resolver: PermissionResolver;
  readonly pages: PagesDeps;
  /** The page served at a locale's root, as for the visitor handler. */
  readonly homeSlug: string;
  /** The visitor handler's component map, so rendered fragments match the
   * site. */
  readonly components: ComponentMap;
  readonly hooks?: RenderHooks;
  /** This site's origin; a state-changing request must come from it or from
   * the request's own origin. */
  readonly siteOrigin: string;
};

export type EditorApi = {
  /** The answer for a request, or `null` for a path outside `/cms/api/`. */
  handle(request: Request): Promise<Response | null>;
};

type Route = {
  readonly method: 'GET' | 'POST';
  readonly run: (context: ApiContext, body: unknown) => Promise<unknown>;
};

/** `/pages/<id>/{tree,edit,preview}` and `/pages/<id>/lock[/<action>]`. */
const PAGE_ROUTE =
  /^\/pages\/([^/]+)\/(tree|edit|preview|lock|lock\/acquire|lock\/renew|lock\/release|lock\/take-over)$/;

function pageRoute(rawId: string, action: string): Route | null {
  const pageId = (): string => parseWith(pageIdParam, rawId);
  const post = (
    run: (context: ApiContext, id: string) => Promise<unknown>,
  ): Route => ({
    method: 'POST',
    run: async (context, body) => {
      parseWith(emptyBody, body);
      return await run(context, pageId());
    },
  });
  const get = (
    run: (context: ApiContext, id: string) => Promise<unknown>,
  ): Route => ({
    method: 'GET',
    run: async (context) => await run(context, pageId()),
  });
  switch (action) {
    case 'edit':
      return {
        method: 'POST',
        run: async (context, body) =>
          await editPage(context, pageId(), parseWith(editBody, body)),
      };
    case 'preview':
      return {
        method: 'POST',
        run: async (context, body) =>
          await previewPage(context, pageId(), parseWith(previewBody, body)),
      };
    case 'tree':
      return get(readTree);
    case 'lock':
      return get(readLock);
    case 'lock/acquire':
      return post(acquireLock);
    case 'lock/renew':
      return post(renewLock);
    case 'lock/release':
      return post(releaseLock);
    case 'lock/take-over':
      return post(takeOverLock);
    default:
      return null;
  }
}

function routeFor(rest: string): Route | null {
  if (rest === '/open') {
    return {
      method: 'POST',
      run: async (context, body) =>
        await openPage(context, parseWith(openBody, body).path),
    };
  }
  const match = PAGE_ROUTE.exec(rest);
  if (match === null) return null;
  return pageRoute(match[1] ?? '', match[2] ?? '');
}

/** The path below `/cms/api`, lowercased with no trailing slash, or `null`
 * for a request outside the prefix. Matching is case-insensitive like the
 * router's. */
function apiPath(url: string): string | null {
  let pathname = new URL(url).pathname.toLowerCase();
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === EDITOR_API_BASE) return '';
  if (pathname.startsWith(`${EDITOR_API_BASE}/`)) {
    return pathname.slice(EDITOR_API_BASE.length);
  }
  return null;
}

/** Builds the editor API over its dependencies. */
export function createEditorApi(deps: EditorApiDeps): EditorApi {
  // Computed once: the declared blocks do not change while the server runs.
  const catalogue = buildCatalogue(deps.pages.config);
  const blockMeta = buildBlockMeta(deps.pages.config);

  return {
    async handle(request) {
      const rest = apiPath(request.url);
      if (rest === null) return null;

      let context: ApiContext | undefined;
      try {
        const route = routeFor(rest);
        if (route === null) throw new ApiHttpError(404, 'not-found');
        if (request.method !== route.method) {
          const refused = jsonResponse(405, {
            ok: false,
            error: { code: 'invalid-request' },
          });
          refused.headers.set('Allow', route.method);
          return refused;
        }
        if (!checkOrigin(request, deps.siteOrigin)) {
          throw new ApiHttpError(403, 'forbidden');
        }

        const identity = await readEditorIdentity(
          deps.auth,
          deps.resolver,
          request,
        );
        if (identity === null) throw new ApiHttpError(401, 'unauthenticated');
        if (needsTwoFactorEnrolment(identity) || !identity.canEdit) {
          throw new ApiHttpError(403, 'forbidden');
        }
        context = {
          deps,
          catalogue,
          blockMeta,
          identity,
          actor: { userId: identity.userId, roleKey: identity.roleKey },
        };

        const body =
          route.method === 'POST' ? await readJsonBody(request) : undefined;
        return jsonResponse(200, await route.run(context, body));
      } catch (error) {
        let lock: LockView | undefined;
        if (error instanceof PageLockedError && context !== undefined) {
          try {
            lock = await lockViewOf(context, error.pageId);
          } catch {
            // The refusal stands without the view.
          }
        }
        const failed = apiErrorFor(error, lock);
        return jsonResponse(failed.status, failed.body);
      }
    },
  };
}
