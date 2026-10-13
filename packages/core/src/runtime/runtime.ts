/**
 * The host runtime: everything the package builds from the host's
 * configuration and the validated process environment -- the database handle,
 * the better-auth instance, lazily constructed mail, the audit recorder, the
 * page deps and the visitor handler. Memoised per configuration OBJECT, so a
 * reloaded config builds a new runtime while the pooled database handle is
 * reused.
 *
 * Caching: production runs one in-process LRU per app container, used by the
 * visitor handler and passed as the pages invalidator. Purges therefore run
 * in-process right after the writing transaction commits, so no purge retry
 * or outbox is needed until a shared cache backend exists. Every other
 * NODE_ENV runs uncached (D-22).
 */
import {
  createAuditRecorder,
  createAuth,
  type Auth,
  type AuditRecorder,
} from '@plakboek/auth';
import {
  createMemoryCache as createProductionCache,
  type CacheBackend,
} from '@plakboek/cache';
import type { Db } from '@plakboek/db';
import type * as EditorServer from '@plakboek/editor/server';
import * as pagesPackage from '@plakboek/pages';
import type { PagesDeps } from '@plakboek/pages';
import {
  createPermissionResolver,
  type PermissionResolver,
} from '@plakboek/permissions';
import {
  createComponentMap,
  createVisitorHandler,
  renderDefaultDocument,
  type EditEntrypoint,
  type VisitorHandler,
} from '@plakboek/render/server';
import {
  createSiteHooks,
  sealedNotFoundResponse,
  type SiteHooks,
} from '../site.js';
import type { HostModule, PlakboekConfig } from '../types.js';
import { getDb } from './db.js';
import { readRuntimeEnv, type RuntimeEnv } from './env.js';
import { createLazyMailSender, type LazyMailSender } from './mail.js';

/** The editor's `/cms` pages handler. */
export type CmsPages = EditorServer.CmsPages;

export type Runtime = {
  readonly env: RuntimeEnv;
  readonly config: PlakboekConfig;
  readonly db: Db;
  readonly auth: Auth;
  readonly mail: LazyMailSender;
  readonly resolver: PermissionResolver;
  readonly recorder: AuditRecorder;
  /** The production LRU; `undefined` outside production. */
  readonly cache: CacheBackend | undefined;
  readonly pages: PagesDeps;
  readonly visitor: VisitorHandler;
  /**
   * The editor's `/cms` pages (login document and link landings), composed on
   * first use. Rejects with `EditorAssetsMissingError` for a host built
   * without the editor's client assets.
   */
  cmsPages(): Promise<CmsPages>;
  /**
   * The visitor handler's sealed 404 (host page or default, status 404,
   * `no-store`) for routes outside the handler, such as the setup page.
   */
  notFoundResponse(request: Request): Promise<Response>;
};

/** Thrown on the first `_edit` request of a host whose build did not hand the
 * runtime the editor's client assets. */
export class EditorAssetsMissingError extends Error {
  override readonly name = 'EditorAssetsMissingError';

  constructor() {
    super(
      'The editor client assets are missing: build the host with the plakboek() Vite plugin, or pass an edit option to it',
    );
  }
}

/** What the editor's server entry exports, loaded at most once. */
type EditorLoader = () => Promise<typeof EditorServer>;

/**
 * The editor's server code is loaded with a dynamic import, so a process that
 * never receives an `_edit` or `/cms` request never loads it. One memoised
 * import serves every consumer; a failed load is tried again on the next
 * request.
 */
function createEditorLoader(): EditorLoader {
  let loaded: Promise<typeof EditorServer> | undefined;
  return () => {
    loaded ??= import('@plakboek/editor/server').catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
}

/** Builds a value on the first call and keeps it; a failed build is retried. */
function lazily<T>(build: () => Promise<T>): () => Promise<T> {
  let composed: Promise<T> | undefined;
  return () => {
    composed ??= build().catch((error: unknown) => {
      composed = undefined;
      throw error;
    });
    return composed;
  };
}

type EditorParts = {
  readonly env: RuntimeEnv;
  readonly db: Db;
  readonly auth: Auth;
  readonly resolver: PermissionResolver;
  readonly siteHooks: SiteHooks | undefined;
};

/**
 * The CMS editor, built on the first `_edit` request and kept after that,
 * from dependencies the runtime already owns.
 */
function composeEditor(
  host: HostModule,
  parts: EditorParts,
  loadEditor: EditorLoader,
): EditEntrypoint {
  const { config } = host;
  const { env, db, auth, resolver, siteHooks } = parts;

  const composed = lazily(async (): Promise<EditEntrypoint> => {
    const { editorAssets } = host;
    if (editorAssets === undefined) throw new EditorAssetsMissingError();
    const { createEditEntrypoint } = await loadEditor();
    return createEditEntrypoint({
      auth,
      resolver,
      db: db.db,
      pages: { config: config.pages, homeSlug: config.homeSlug },
      components: createComponentMap(config.pages.blocks),
      renderDocument: siteHooks?.renderDocument ?? renderDefaultDocument,
      ...(siteHooks?.notFound === undefined
        ? {}
        : { notFound: siteHooks.notFound }),
      siteUrl: env.siteUrl,
      assets: editorAssets,
      csp: env.production,
    });
  });

  return async (request, context) => await (await composed())(request, context);
}

/** The `/cms` pages handler, built on first use from the same dependencies. */
function composeCmsPages(
  host: HostModule,
  parts: Pick<EditorParts, 'env' | 'auth' | 'resolver'>,
  loadEditor: EditorLoader,
): () => Promise<CmsPages> {
  const { env, auth, resolver } = parts;
  return lazily(async (): Promise<CmsPages> => {
    const { editorAssets } = host;
    if (editorAssets === undefined) throw new EditorAssetsMissingError();
    const { createCmsPages } = await loadEditor();
    return createCmsPages({
      auth,
      resolver,
      assets: editorAssets,
      csp: env.production,
    });
  });
}

export function createRuntime(host: HostModule, env: RuntimeEnv): Runtime {
  const { config, site } = host;
  const db = getDb(env.databaseUrl);

  const resolver = createPermissionResolver(config.roles);
  const recorder = createAuditRecorder({ db: db.db, resolver });
  const mail = createLazyMailSender({ env });
  const auth = createAuth({
    db: db.db,
    baseURL: env.siteUrl,
    secret: env.secret,
    mail,
    roles: config.roles,
    appName: config.siteName,
    ...(env.trustedProxies === undefined
      ? {}
      : { trustedProxies: env.trustedProxies }),
    ...(env.clientIpHeaders === undefined
      ? {}
      : { ipAddressHeaders: env.clientIpHeaders }),
  });

  const cache = env.production ? createProductionCache() : undefined;

  const pages: PagesDeps = {
    db: db.db,
    recorder,
    resolver,
    config: config.pages,
    ...(cache === undefined ? {} : { invalidator: cache }),
  };

  const siteHooks =
    site === undefined ? undefined : createSiteHooks({ config, site });

  const loadEditor = createEditorLoader();
  const visitor = createVisitorHandler({
    db: db.db,
    config: config.pages,
    homeSlug: config.homeSlug,
    siteUrl: env.siteUrl,
    ...(cache === undefined ? {} : { cache }),
    ...(env.buildId === undefined ? {} : { buildId: env.buildId }),
    ...siteHooks,
    ...(host.devMode === true ? { devBlockMarkers: true } : {}),
    edit:
      host.edit ??
      composeEditor(host, { env, db, auth, resolver, siteHooks }, loadEditor),
  });

  return {
    env,
    config,
    db,
    auth,
    mail,
    resolver,
    recorder,
    cache,
    pages,
    visitor,
    cmsPages: composeCmsPages(host, { env, auth, resolver }, loadEditor),
    notFoundResponse: (request) => sealedNotFoundResponse(siteHooks, request),
  };
}

const runtimes = new WeakMap<object, Runtime>();

/**
 * Starts, without waiting for it, the boot-time report of pages that already
 * sit at an address the CMS reserves (`/cms`, `/api`): they are kept and
 * flagged through the pages hook, never changed (D-23). A failure costs one
 * line naming only the error type and never reaches a request.
 */
function reportReservedPagePaths(runtime: Runtime): void {
  void pagesPackage
    .checkReservedPagePaths(runtime.db.db)
    .then((rows) => {
      pagesPackage.reportReservedPagePaths(runtime.pages, rows);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `[@plakboek/core] The check for pages at reserved addresses failed: ${error instanceof Error ? error.name : typeof error}\n`,
      );
    });
}

/**
 * The runtime for a host module, built once per configuration object. The
 * environment is read and validated when the runtime is first built, so a
 * missing secret fails the first request (and the CLI) with the full list of
 * problems.
 */
export function runtimeFor(
  host: HostModule,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Runtime {
  let runtime = runtimes.get(host.config);
  if (runtime === undefined) {
    runtime = createRuntime(host, readRuntimeEnv(source));
    runtimes.set(host.config, runtime);
    reportReservedPagePaths(runtime);
  }
  return runtime;
}
