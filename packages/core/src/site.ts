/**
 * Adapts the host's site module to the visitor handler's hooks. Every
 * template call receives a site context: the site name, the page locale, the
 * public path and an async `getMenu(name)`. The helper is async so a later
 * database-backed menu source sits behind the same signature without any
 * template changing (D-15).
 *
 * Templates build their HTML as strings (for example with
 * `renderToStaticMarkup`), so menu labels reach the page through React's
 * escaping; the labels and hrefs were validated when the configuration was
 * evaluated.
 */
import type { RenderDocument } from '@plakboek/render';
import { resolveMenu } from './menus.js';
import type { PlakboekConfig, SiteContext, SiteModule } from './types.js';

/** The slice of the configuration the site adapter reads. */
export type SiteHooksConfig = Pick<PlakboekConfig, 'siteName' | 'menus'> & {
  readonly content: Pick<
    PlakboekConfig['content'],
    'locales' | 'defaultLocale'
  >;
};

export type SiteHooks = {
  readonly renderDocument: RenderDocument;
  /** Absent when the site module has no `renderNotFound`. */
  readonly notFound?: (request: Request) => Promise<Response>;
  /** Absent when the site module has no `renderError`. */
  readonly renderError?: (request: Request) => Promise<Response>;
};

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

function siteContext(
  config: SiteHooksConfig,
  locale: string,
  publicPath: string | null,
): SiteContext {
  const { defaultLocale } = config.content;
  return {
    siteName: config.siteName,
    locale,
    defaultLocale,
    publicPath,
    getMenu: (name) =>
      Promise.resolve(
        resolveMenu(config.menus, name, { locale, defaultLocale, publicPath }),
      ),
  };
}

/**
 * The locale an error page is rendered in: the first path segment when it is
 * a configured non-default locale, the default locale otherwise.
 */
function localeOfPath(config: SiteHooksConfig, request: Request): string {
  const { locales, defaultLocale } = config.content;
  const first = new URL(request.url).pathname.split('/')[1]?.toLowerCase();
  if (first === undefined || first === '') return defaultLocale;
  const match = locales.find(
    (locale) => locale !== defaultLocale && locale.toLowerCase() === first,
  );
  return match ?? defaultLocale;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'Content-Type': HTML_CONTENT_TYPE },
  });
}

/**
 * Hooks shaped for `createVisitorHandler`. The handler forces the status and
 * `Cache-Control` of the error pages, so a host page can never become a
 * cacheable soft-404; a hook that throws is reported and replaced by the
 * handler's default.
 */
export function createSiteHooks(options: {
  readonly config: SiteHooksConfig;
  readonly site: SiteModule;
}): SiteHooks {
  const { config, site } = options;
  const { renderNotFound, renderError } = site;

  return {
    renderDocument: (input) =>
      site.renderDocument(
        input,
        siteContext(config, input.head.lang, input.publicPath),
      ),
    ...(renderNotFound === undefined
      ? {}
      : {
          notFound: async (request: Request) =>
            htmlResponse(
              await renderNotFound(
                request,
                siteContext(config, localeOfPath(config, request), null),
              ),
            ),
        }),
    ...(renderError === undefined
      ? {}
      : {
          renderError: async (request: Request) =>
            htmlResponse(
              await renderError(
                request,
                siteContext(config, localeOfPath(config, request), null),
              ),
            ),
        }),
  };
}

const DEFAULT_NOT_FOUND_BODY =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1></body></html>';

/**
 * The same sealed 404 the visitor handler serves, for routes the handler does
 * not own (the setup page, for one): the host's page when there is one and it
 * behaves, the default body otherwise; status 404 and `no-store` always.
 */
export async function sealedNotFoundResponse(
  hooks: Pick<SiteHooks, 'notFound'> | undefined,
  request: Request,
): Promise<Response> {
  const headers = {
    'Content-Type': HTML_CONTENT_TYPE,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  try {
    if (hooks?.notFound !== undefined) {
      const host = await hooks.notFound(request);
      return new Response(host.body, { status: 404, headers });
    }
  } catch {
    // A host page that throws never reaches the visitor: fall through.
  }
  return new Response(DEFAULT_NOT_FOUND_BODY, { status: 404, headers });
}
