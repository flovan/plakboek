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
import { renderDefaultDocument } from './document.js';
import type { RenderDocument } from './head.js';
import { reportRenderEvent, type RenderHooks } from './hooks.js';
import { normalizeVisitorPath } from './path.js';
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
};

export type VisitorHandlerConfigIssue = {
  readonly code:
    | 'INVALID_SITE_URL'
    | 'INVALID_HOME_SLUG'
    | 'invalid-block-component';
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

/** A redirect is bounded so a changed default locale is not pinned forever. */
const REDIRECT_CACHE_CONTROL = 'public, max-age=3600';
const PAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const NO_STORE = 'no-store';

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
 * location bare so each request appends its own query string.
 */
type Outcome =
  | { readonly kind: 'redirect'; readonly location: string }
  | {
      readonly kind: 'html';
      readonly status: number;
      readonly headers: readonly (readonly [string, string])[];
      readonly body: Uint8Array | string;
    };

function htmlOutcome(
  status: number,
  body: string,
  cacheControl: string,
): Outcome {
  return {
    kind: 'html',
    status,
    headers: [
      ['Content-Type', 'text/html; charset=utf-8'],
      ['X-Content-Type-Options', 'nosniff'],
      ['Cache-Control', cacheControl],
    ],
    body,
  };
}

function pageOutcome(
  entry: Pick<CacheEntry, 'body' | 'etag' | 'contentLanguage'>,
  degraded: boolean,
): Outcome {
  return {
    kind: 'html',
    status: 200,
    headers: [
      ['Content-Type', 'text/html; charset=utf-8'],
      ['Content-Language', entry.contentLanguage],
      ['X-Content-Type-Options', 'nosniff'],
      ['ETag', entry.etag],
      ['Cache-Control', degraded ? NO_STORE : PAGE_CACHE_CONTROL],
    ],
    body: entry.body,
  };
}

/** Turns a shared outcome into one request's own response. */
function toResponse(outcome: Outcome, search: string): Response {
  if (outcome.kind === 'redirect') {
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${outcome.location}${search}`,
        'Cache-Control': REDIRECT_CACHE_CONTROL,
      },
    });
  }
  return new Response(outcome.body, {
    status: outcome.status,
    headers: new Headers(outcome.headers.map(([name, value]) => [name, value])),
  });
}

/** Builds a visitor request handler over frozen dependencies. */
export function createVisitorHandler(deps: VisitorHandlerDeps): VisitorHandler {
  validate(deps);
  const { db, config, cache, hooks, siteUrl, resolveAssetUrl } = deps;
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
        return htmlOutcome(404, NOT_FOUND_BODY, NO_STORE);
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
      const html = renderDocument({ head: rendered.head, body: rendered.body });
      const body = encoder.encode(html);
      const entry = {
        body,
        etag: etagOf(body),
        contentLanguage: view.page.locale,
        manifestHash: view.publication.manifestHash,
        buildId: null,
      } satisfies CacheEntry;

      // The ticket this request took before reading anything is what makes a
      // fill that raced a purge refuse itself.
      if (cache !== undefined && ticket !== undefined && !rendered.degraded) {
        await guarded('set', key, () =>
          cache.set(key, entry, { tags: rendered.tags, ticket }),
        );
      }
      return pageOutcome(entry, rendered.degraded);
    } catch (error) {
      // Reported once per flight, not once per waiter.
      reportRenderEvent('onRenderError', hooks?.onRenderError, {
        publicPath: key,
        pageId: seen.pageId,
        error,
      });
      return htmlOutcome(500, SERVER_ERROR_BODY, NO_STORE);
    }
  }

  return async (request) => {
    const url = new URL(request.url);

    // Canonicalise before the cache and before any database statement.
    const normalized = normalizeVisitorPath(url.pathname);
    if (normalized.kind === 'not-found') {
      return toResponse(htmlOutcome(404, NOT_FOUND_BODY, NO_STORE), '');
    }
    if (normalized.kind === 'redirect') {
      return toResponse(
        { kind: 'redirect', location: normalized.location },
        url.search,
      );
    }
    const key = normalized.path;

    // The ticket and the cache read come BEFORE any database read: a purge
    // that lands after the ticket makes the fill refuse itself.
    let ticket: number | undefined;
    if (cache !== undefined) {
      ticket = await guarded('ticket', key, () => cache.ticket());
      if (ticket !== undefined) {
        const hit = await guarded('get', key, () => cache.get(key));
        if (hit !== undefined) return toResponse(pageOutcome(hit, false), '');
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
    return toResponse(outcome, url.search);
  };
}
