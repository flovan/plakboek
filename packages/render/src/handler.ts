/**
 * The visitor request handler (D-01): a factory returning a Fetch-standard
 * `(request) => Promise<Response>`. It needs no framework and no HTTP server,
 * holds no module-level state, and never writes to the database, so two
 * handlers over two configs in one process work independently (D-04).
 *
 * Per request: the URL path is canonicalised first (a non-canonical spelling
 * is a redirect, junk is a 404, neither touches the cache or the database),
 * the canonical path is the cache key (the query string is never part of it),
 * a cache ticket is taken and the cache read BEFORE any database access, and
 * only a miss resolves the page, renders its snapshot and fills the cache.
 * Without a cache nothing is stored (D-17).
 */
import { createHash } from 'node:crypto';
import type { CacheBackend, CacheEntry } from '@plakboek/cache';
import {
  DEFAULT_HOME_SLUG,
  resolveVisitorPage,
  type PagesConfig,
  type PagesDeps,
} from '@plakboek/pages';
import {
  createComponentMap,
  listInvalidBlockComponents,
} from './components.js';
import { EDIT_PARAM } from './constants.js';
import { matchesIfNoneMatch } from './conditional.js';
import { renderDefaultDocument } from './document.js';
import {
  editBounceLocation,
  renderToolbarBootstrap,
  type EditEntrypoint,
} from './edit-seam.js';
import type { RenderDocument } from './head.js';
import { reportRenderEvent, type RenderHooks } from './hooks.js';
import { MAX_VISITOR_PATH_LENGTH, normalizeVisitorPath } from './path.js';
import { renderPageSnapshot } from './render-snapshot.js';
import { createSingleFlight } from './single-flight.js';

export type VisitorHandler = (request: Request) => Promise<Response>;

export type VisitorHandlerDeps = {
  readonly db: PagesDeps['db'];
  readonly config: PagesConfig;
  /** Without a cache nothing is stored and every request renders. */
  readonly cache?: CacheBackend;
  /** Defaults to `renderDefaultDocument`. */
  readonly renderDocument?: RenderDocument;
  readonly hooks?: RenderHooks;
  /** The page served at a locale's root; defaults to `home`. */
  readonly homeSlug?: string;
  /** The installation's absolute origin, used for canonical URLs. */
  readonly siteUrl?: string;
  readonly resolveAssetUrl?: (assetId: string) => string | null;
  /**
   * The not-found page. Its body and headers are served, but the status is
   * forced to 404 and `Cache-Control` to `no-store`, so a host page can never
   * become a cacheable soft-404. A hook that throws is reported through
   * `onRenderError` and replaced by the default.
   */
  readonly notFound?: (request: Request) => Response | Promise<Response>;
  /**
   * The error page for a failed render, treated exactly like `notFound` with
   * the status forced to 500.
   */
  readonly renderError?: (request: Request) => Response | Promise<Response>;
  /**
   * Replaces `public, max-age=0, must-revalidate` on healthy 200 page
   * responses, for a downstream layer the host can purge (compose it into the
   * pages invalidator through `composeInvalidators`). Degraded pages, 404s,
   * 405s, 500s and redirects keep their fixed policies. 1 to 256 printable
   * ASCII characters.
   */
  readonly cacheControl?: string;
  /**
   * Identifies the deployed render code, for example a commit hash. Entries
   * are stored with it, and an entry written by a different build is treated
   * as a miss, re-rendered and overwritten, so HTML from an older build never
   * survives a deploy on a shared or long-lived cache. Letters, digits `.`,
   * `_` and `-`, 1 to 128 characters.
   */
  readonly buildId?: string;
  /**
   * The editor's entrypoint, composed in by the host from a separate module
   * (the editor package provides it). A request carrying `_edit` goes here
   * instead of the visitor path: it verifies the session on the server and
   * resolves `null` for anyone who may not edit, who is then bounced to the
   * same URL without `_edit`. Its response is served as `private, no-store`.
   * This module never imports editor code. Without it every `_edit` request
   * is bounced.
   */
  readonly edit?: EditEntrypoint;
};

export type VisitorHandlerConfigIssue = {
  readonly code:
    | 'INVALID_SITE_URL'
    | 'INVALID_HOME_SLUG'
    | 'invalid-block-component'
    | 'invalid-cache-control'
    | 'invalid-build-id';
  readonly message: string;
};

/** Thrown by `createVisitorHandler` with every invalid dependency, collected. */
export class VisitorHandlerConfigError extends Error {
  readonly issues: readonly VisitorHandlerConfigIssue[];

  constructor(issues: readonly VisitorHandlerConfigIssue[]) {
    super(
      [
        '[@plakboek/render] invalid visitor handler config:',
        ...issues.map((issue) => `${issue.code}: ${issue.message}`),
      ].join('\n'),
    );
    this.name = 'VisitorHandlerConfigError';
    this.issues = issues;
  }
}

const HOME_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Printable ASCII only: this rejects CR, LF and every other control byte. */
const CACHE_CONTROL_PATTERN = /^[\x20-\x7E]{1,256}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** A redirect is bounded so a changed default locale is not pinned forever. */
const REDIRECT_CACHE_CONTROL = 'public, max-age=3600';
const PAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const NO_STORE = 'no-store';
/** What an editor response is forced to: no shared cache may ever keep it. */
const EDIT_CACHE_CONTROL = 'private, no-store';

/**
 * Every header through which a shared cache or CDN may be told to keep, or to
 * revalidate, a response: the CDN-targeted freshness headers that some proxies
 * prefer over `Cache-Control`, plus the validators and age a stored copy would
 * be served with. A host or editor response is stripped of all of them.
 */
const PROXY_CACHE_HEADERS = [
  'Surrogate-Control',
  'CDN-Cache-Control',
  'Cloudflare-CDN-Cache-Control',
  'Expires',
  'ETag',
  'Last-Modified',
  'Age',
] as const;

/** Copies `source` and forces it uncacheable by any layer. A copy is required:
 * a foreign response's headers can be immutable. */
function uncacheableHeaders(source: Headers, cacheControl: string): Headers {
  const headers = new Headers(source);
  for (const name of PROXY_CACHE_HEADERS) headers.delete(name);
  headers.set('Cache-Control', cacheControl);
  return headers;
}

const NOT_FOUND_BODY =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1></body></html>';
const SERVER_ERROR_BODY =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Error</title></head><body><h1>Something went wrong</h1></body></html>';

function validate(deps: VisitorHandlerDeps): void {
  const issues: VisitorHandlerConfigIssue[] = [];
  if (deps.siteUrl !== undefined) {
    let absolute = false;
    try {
      const { protocol } = new URL(deps.siteUrl);
      absolute = protocol === 'http:' || protocol === 'https:';
    } catch {
      absolute = false;
    }
    if (!absolute) {
      issues.push({
        code: 'INVALID_SITE_URL',
        message: 'siteUrl must be an absolute http: or https: URL',
      });
    }
  }
  if (deps.homeSlug !== undefined && !HOME_SLUG_PATTERN.test(deps.homeSlug)) {
    issues.push({
      code: 'INVALID_HOME_SLUG',
      message: `homeSlug must match ${HOME_SLUG_PATTERN.source}`,
    });
  }
  if (
    deps.cacheControl !== undefined &&
    !CACHE_CONTROL_PATTERN.test(deps.cacheControl)
  ) {
    issues.push({
      code: 'invalid-cache-control',
      message:
        'cacheControl must be 1 to 256 printable ASCII characters (no line breaks)',
    });
  }
  if (deps.buildId !== undefined && !BUILD_ID_PATTERN.test(deps.buildId)) {
    issues.push({
      code: 'invalid-build-id',
      message: `buildId must match ${BUILD_ID_PATTERN.source}`,
    });
  }
  for (const key of listInvalidBlockComponents(deps.config.blocks)) {
    issues.push({
      code: 'invalid-block-component',
      message: `block "${key}" declares a component that is not a plain function component (memo, forwardRef and class components are not supported: wrap them in a function)`,
    });
  }
  if (issues.length > 0) throw new VisitorHandlerConfigError(issues);
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('base64url')}"`;
}

/**
 * What a flight produces: plain data, never a `Response`, because a response
 * body can be read once and every waiter needs its own. A redirect keeps its
 * location bare so each request appends its own query string, and a
 * not-found or an error carries nothing at all: each request builds its own
 * response from the host hook (or the default).
 */
type PageOutcome = {
  readonly kind: 'page';
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly etag: string;
  /** A degraded page is transient, so it is never answered with a 304. */
  readonly degraded: boolean;
};
type RedirectOutcome = { readonly kind: 'redirect'; readonly location: string };
type Outcome =
  | RedirectOutcome
  | PageOutcome
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error' };

function pageOutcome(
  entry: Pick<CacheEntry, 'body' | 'etag' | 'contentLanguage'>,
  cacheControl: string,
  degraded: boolean,
): PageOutcome {
  return {
    kind: 'page',
    etag: entry.etag,
    degraded,
    headers: [
      ['Content-Type', 'text/html; charset=utf-8'],
      ['Content-Language', entry.contentLanguage],
      ['X-Content-Type-Options', 'nosniff'],
      ['ETag', entry.etag],
      ['Cache-Control', cacheControl],
    ],
    body: entry.body,
  };
}

function defaultErrorResponse(status: 404 | 500): Response {
  return new Response(status === 404 ? NOT_FOUND_BODY : SERVER_ERROR_BODY, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': NO_STORE,
    },
  });
}

/**
 * Re-wraps a host response as a 404 or 500 that no cache may keep. A copy is
 * required: a host response's headers can be immutable, and its status and
 * `Cache-Control` are exactly what must not survive.
 */
function sealedHostResponse(host: Response, status: 404 | 500): Response {
  const headers = uncacheableHeaders(host.headers, NO_STORE);
  return new Response(host.body, { status, headers });
}

/**
 * Turns a shared page or redirect outcome into one request's own response. A
 * healthy page whose ETag the request's `If-None-Match` names is a 304 that
 * keeps the 200's `ETag` and `Cache-Control` and drops everything else.
 */
function toResponse(
  outcome: RedirectOutcome | PageOutcome,
  search: string,
  ifNoneMatch: string | null,
): Response {
  if (outcome.kind === 'redirect') {
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${outcome.location}${search}`,
        'Cache-Control': REDIRECT_CACHE_CONTROL,
      },
    });
  }
  const headers = new Headers(
    outcome.headers.map(([name, value]) => [name, value]),
  );
  if (!outcome.degraded && matchesIfNoneMatch(ifNoneMatch, outcome.etag)) {
    const notModified = new Headers({ ETag: outcome.etag });
    const cacheControl = headers.get('Cache-Control');
    if (cacheControl !== null) notModified.set('Cache-Control', cacheControl);
    return new Response(null, { status: 304, headers: notModified });
  }
  return new Response(outcome.body, { status: 200, headers });
}

/** Builds a visitor request handler over frozen dependencies. */
export function createVisitorHandler(deps: VisitorHandlerDeps): VisitorHandler {
  validate(deps);
  const { db, config, cache, hooks, siteUrl, resolveAssetUrl } = deps;
  const { notFound, renderError, edit } = deps;
  const buildId = deps.buildId ?? null;
  const healthyPageCacheControl = deps.cacheControl ?? PAGE_CACHE_CONTROL;
  const renderDocument = deps.renderDocument ?? renderDefaultDocument;
  const homeSlug = deps.homeSlug ?? DEFAULT_HOME_SLUG;
  const components = createComponentMap(config.blocks, hooks);
  const encoder = new TextEncoder();
  const flights = createSingleFlight<Outcome>();

  /** A cache failure is reported and the request continues uncached. */
  async function guarded<T>(
    operation: 'ticket' | 'get' | 'set',
    key: string,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      reportRenderEvent('onCacheError', hooks?.onCacheError, {
        operation,
        key,
        error,
      });
      return undefined;
    }
  }

  /** Resolves, renders and (with a cache) stores one canonical path. */
  async function produce(
    key: string,
    ticket: number | undefined,
  ): Promise<Outcome> {
    const seen: { pageId: string | null } = { pageId: null };
    try {
      const resolution = await resolveVisitorPage(db, {
        publicPath: key,
        locales: config.content.locales,
        defaultLocale: config.content.defaultLocale,
        homeSlug,
      });

      if (resolution.kind === 'redirect') {
        return { kind: 'redirect', location: resolution.location };
      }
      if (resolution.kind === 'not-found') {
        return { kind: 'not-found' };
      }
      // Defensive: HTML is only ever stored under the canonical key (D-16),
      // so a page that resolved under another spelling is redirected instead.
      if (resolution.publicPath !== key) {
        return { kind: 'redirect', location: resolution.publicPath };
      }

      const { view } = resolution;
      seen.pageId = view.page.id;
      const rendered = renderPageSnapshot({
        view,
        publicPath: key,
        components,
        hooks,
        siteUrl,
        resolveAssetUrl,
      });
      // The one script a visitor page carries is part of the cached bytes.
      const html = renderDocument({
        head: rendered.head,
        body: `${rendered.body}${renderToolbarBootstrap()}`,
      });
      const body = encoder.encode(html);
      const entry = {
        body,
        etag: etagOf(body),
        contentLanguage: view.page.locale,
        manifestHash: view.publication.manifestHash,
        buildId,
      } satisfies CacheEntry;

      // The ticket this request took before reading anything is what makes a
      // fill that raced a purge refuse itself.
      if (cache !== undefined && ticket !== undefined && !rendered.degraded) {
        await guarded('set', key, () =>
          cache.set(key, entry, { tags: rendered.tags, ticket }),
        );
      }
      return pageOutcome(
        entry,
        rendered.degraded ? NO_STORE : healthyPageCacheControl,
        rendered.degraded,
      );
    } catch (error) {
      // Reported once per flight, not once per waiter.
      reportRenderEvent('onRenderError', hooks?.onRenderError, {
        publicPath: key,
        pageId: seen.pageId,
        error,
      });
      return { kind: 'error' };
    }
  }

  /**
   * The response for a not-found or an error: the host's page when it set one
   * and it behaved, otherwise the default. Called once per request, never once
   * per flight, because every request needs its own body.
   */
  async function errorResponse(
    request: Request,
    status: 404 | 500,
    publicPath: string,
  ): Promise<Response> {
    const hook = status === 404 ? notFound : renderError;
    if (hook === undefined) return defaultErrorResponse(status);
    try {
      const host: unknown = await hook(request);
      if (!(host instanceof Response)) {
        throw new TypeError('the hook must return a Response');
      }
      return sealedHostResponse(host, status);
    } catch (error) {
      reportRenderEvent('onRenderError', hooks?.onRenderError, {
        publicPath,
        pageId: null,
        error,
      });
      return defaultErrorResponse(status);
    }
  }

  /**
   * The `_edit` branch. It only routes: nothing here reads or writes the
   * visitor cache, renders a page or touches the database, and the answer is
   * never stored. A bounce is a 302, not a 308, so a user who later gains the
   * editor role is not locked out by a remembered redirect.
   */
  async function editResponse(request: Request, url: URL): Promise<Response> {
    const visitorLocation = editBounceLocation(url);
    const bounce = (): Response =>
      new Response(null, {
        status: 302,
        headers: { Location: visitorLocation, 'Cache-Control': NO_STORE },
      });
    if (edit === undefined) return bounce();
    try {
      const editor = await edit(request, { url, visitorLocation });
      if (editor === null) return bounce();
      // The entrypoint's own `Cache-Control` and every proxy-targeted
      // freshness or validator header is exactly what must not survive.
      const headers = uncacheableHeaders(editor.headers, EDIT_CACHE_CONTROL);
      return new Response(editor.body, {
        status: editor.status,
        statusText: editor.statusText,
        headers,
      });
    } catch (error) {
      const publicPath = url.pathname.slice(0, MAX_VISITOR_PATH_LENGTH);
      reportRenderEvent('onRenderError', hooks?.onRenderError, {
        publicPath,
        pageId: null,
        error,
      });
      return await errorResponse(request, 500, publicPath);
    }
  }

  async function respond(request: Request): Promise<Response> {
    // Only a read is answered: anything else never reaches the cache or the
    // database, and a 405 is never stored by anything downstream.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'Cache-Control': NO_STORE },
      });
    }
    const url = new URL(request.url);

    // An editing request is detected here, on the server, before the visitor
    // path, the cache or the database are involved in any way.
    if (url.searchParams.has(EDIT_PARAM))
      return await editResponse(request, url);

    // Canonicalise before the cache and before any database statement.
    const normalized = normalizeVisitorPath(url.pathname);
    if (normalized.kind === 'not-found') {
      return await errorResponse(
        request,
        404,
        url.pathname.slice(0, MAX_VISITOR_PATH_LENGTH),
      );
    }
    if (normalized.kind === 'redirect') {
      return toResponse(
        { kind: 'redirect', location: normalized.location },
        url.search,
        null,
      );
    }
    const key = normalized.path;
    const ifNoneMatch = request.headers.get('if-none-match');

    // The ticket and the cache read come BEFORE any database read: a purge
    // that lands after the ticket makes the fill refuse itself.
    let ticket: number | undefined;
    if (cache !== undefined) {
      ticket = await guarded('ticket', key, () => cache.ticket());
      if (ticket !== undefined) {
        const hit = await guarded('get', key, () => cache.get(key));
        // An entry another build wrote is a miss: it is re-rendered and the
        // fill overwrites it, so older HTML never outlives its build.
        if (hit !== undefined && hit.buildId === buildId) {
          return toResponse(
            pageOutcome(hit, healthyPageCacheControl, false),
            '',
            ifNoneMatch,
          );
        }
      }
    }

    // Concurrent misses share one render, but only within one purge epoch:
    // the ticket in the flight key stops a request taken after a purge from
    // joining a render that started before it. Without a cache there is no
    // purge epoch to key by, and every request renders.
    const outcome =
      ticket === undefined
        ? await produce(key, ticket)
        : await flights.run(`${String(ticket)}\u0000${key}`, () =>
            produce(key, ticket),
          );
    if (outcome.kind === 'not-found') {
      return await errorResponse(request, 404, key);
    }
    if (outcome.kind === 'error') {
      return await errorResponse(request, 500, key);
    }
    return toResponse(outcome, url.search, ifNoneMatch);
  }

  return async (request) => {
    const response = await respond(request);
    // HEAD runs the same pipeline as GET (so a cold HEAD fills the cache) and
    // keeps the status and headers, but never carries a body.
    if (request.method !== 'HEAD') return response;
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  };
}
