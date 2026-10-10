/**
 * The pages the editor serves under `/cms`: the login document and the
 * landings of emailed links. This is a request handler like the edit
 * entrypoint, not a router: core's `/cms` route modules hand it every
 * request that reaches them and answer the host's own 404 when it returns
 * `null`.
 *
 * Every page here is decided on the server. The only inputs a client
 * controls are the session cookie, which `readEditorIdentity` verifies
 * against the stored session, and query values, which are validated before
 * use: `next` is accepted only as a same-origin relative path (anything else
 * is `/`), and a link token is only checked for presence and length because
 * the client, not this server, reads and spends it.
 */
import {
  needsTwoFactorEnrolment,
  PASSWORD_LINK_PATHS,
  sanitizeNextPath,
  TWO_FACTOR_ENROLMENT_PATH,
  type Auth,
} from '@plakboek/auth';
import type { PermissionResolver } from '@plakboek/permissions';
import { CMS_LOGIN_PATH, NEXT_PARAM } from '@plakboek/render';
import type { LinkKind, LoginIsland, LoginStep } from '../chrome/island.js';
import type { EditorAssets } from './assets.js';
import { readEditorIdentity } from './identity.js';
import { renderLoginDocument } from './login-document.js';
import { editLocation, pathOf } from './locations.js';

export type CmsPagesDeps = {
  /** Verifies the session cookie; only `api.getSession` is used. */
  readonly auth: Pick<Auth, 'api'>;
  readonly resolver: PermissionResolver;
  /** The built editor client every page loads. */
  readonly assets: EditorAssets;
  /** Whether the documents send a Content-Security-Policy. */
  readonly csp: boolean;
  /** The role keys that must set up two-step sign-in, told to the client. */
  readonly twoFactorRequiredRoleKeys: readonly string[];
};

export type CmsPages = {
  /** The page for a request, or `null` for a path this handler does not own. */
  handle(request: Request): Promise<Response | null>;
};

const NO_STORE = 'no-store';

/** The query parameter an emailed link carries its token in. */
const TOKEN_PARAM = 'token';

/** The longest token accepted as present. Real tokens are far shorter; the
 * bound only keeps an absurd value out of the page logic. */
const MAX_TOKEN_LENGTH = 512;

/** The query parameter better-auth adds to a failed sign-in link's callback. */
const ERROR_PARAM = 'error';

/** Where the sign-in link's callback lands; the sign-in link itself is built
 * by the auth package and verified by its own endpoint. */
const MAGIC_LINK_PATH = '/cms/magic-link';

/** `/cms/` and `/cms` are the same page; so are `/CMS` and `/cms`, because
 * the router matches case-insensitively. */
function normalisedPath(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': NO_STORE },
  });
}

/** Builds the pages handler over its dependencies. */
export function createCmsPages(deps: CmsPagesDeps): CmsPages {
  function loginResponse(island: LoginIsland): Response {
    const document = renderLoginDocument({
      island,
      assets: deps.assets,
      csp: deps.csp,
    });
    return new Response(document.html, {
      status: 200,
      headers: { ...document.headers, 'Cache-Control': `private, ${NO_STORE}` },
    });
  }

  function island(
    step: LoginStep,
    next: string,
    extra: { readonly linkKind?: LinkKind; readonly email?: string } = {},
  ): LoginIsland {
    return {
      kind: 'login',
      step,
      next,
      ...extra,
      twoFactorRequiredRoles: deps.twoFactorRequiredRoleKeys,
    };
  }

  /**
   * A password-link landing: the step when a token is present, the invalid
   * link step when it is not. The token is only checked for presence and
   * length. It is not copied into the markup or the island, because the
   * client reads it from the address bar and spends it, and nothing here
   * could say whether it is still good without spending it.
   */
  function passwordLink(
    url: URL,
    next: string,
    step: 'set-password' | 'reset-password',
  ): Response {
    const token = url.searchParams.get(TOKEN_PARAM);
    const present =
      token !== null && token.length >= 1 && token.length <= MAX_TOKEN_LENGTH;
    if (present) return loginResponse(island(step, next));
    return loginResponse(
      island('invalid-link', next, {
        linkKind: step === 'set-password' ? 'invite' : 'reset',
      }),
    );
  }

  /** The sign-in link landing: signing in when a session exists and the link
   * did not fail, the invalid link step otherwise. */
  async function magicLink(
    request: Request,
    url: URL,
    next: string,
  ): Promise<Response> {
    const failed = url.searchParams.has(ERROR_PARAM);
    const identity = failed
      ? null
      : await readEditorIdentity(deps.auth, deps.resolver, request);
    if (identity === null) {
      return loginResponse(
        island('invalid-link', next, { linkKind: 'sign-in' }),
      );
    }
    return loginResponse(island('magic-landing', next));
  }

  /** `/cms/two-factor/enrol`: the set-up step for a role that needs one. */
  async function enrol(request: Request, next: string): Promise<Response> {
    const identity = await readEditorIdentity(
      deps.auth,
      deps.resolver,
      request,
    );
    if (identity === null) {
      return redirect(
        `${CMS_LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`,
      );
    }
    if (!needsTwoFactorEnrolment(identity)) {
      return redirect(editLocation(pathOf(next), next, '1'));
    }
    return loginResponse(island('enrol', next, { email: identity.email }));
  }

  /** `/cms`: sign in, or straight on to edit mode with a valid session. */
  async function entry(request: Request, next: string): Promise<Response> {
    const identity = await readEditorIdentity(
      deps.auth,
      deps.resolver,
      request,
    );
    if (identity === null) return loginResponse(island('sign-in', next));
    if (needsTwoFactorEnrolment(identity)) {
      return redirect(
        `${TWO_FACTOR_ENROLMENT_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`,
      );
    }
    return redirect(editLocation(pathOf(next), next, '1'));
  }

  return {
    async handle(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return null;
      const url = new URL(request.url);
      const next = sanitizeNextPath(url.searchParams.get(NEXT_PARAM));
      switch (normalisedPath(url.pathname)) {
        case CMS_LOGIN_PATH:
          return await entry(request, next);
        case PASSWORD_LINK_PATHS['set-password']:
          return passwordLink(url, next, 'set-password');
        case PASSWORD_LINK_PATHS['reset-password']:
          return passwordLink(url, next, 'reset-password');
        case MAGIC_LINK_PATH:
          return await magicLink(request, url, next);
        case TWO_FACTOR_ENROLMENT_PATH:
          return await enrol(request, next);
        default:
          return null;
      }
    },
  };
}
