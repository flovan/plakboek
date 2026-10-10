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

/**
 * The CMS editor, built on the first `_edit` request and kept after that.
 * The editor's server code is loaded with a dynamic import, so a process that
 * never receives an `_edit` request never loads it, and every dependency it
 * gets is one the runtime already owns.
 */
function composeEditor(
  host: HostModule,
  parts: {
    readonly env: RuntimeEnv;
    readonly db: Db;
    readonly auth: Auth;
    readonly resolver: PermissionResolver;
    readonly siteHooks: SiteHooks | undefined;
  },
): EditEntrypoint {
  const { config } = host;
  const { env, db, auth, resolver, siteHooks } = parts;
  let composed: Promise<EditEntrypoint> | undefined;

  async function compose(): Promise<EditEntrypoint> {
    const { editorAssets } = host;
    if (editorAssets === undefined) throw new EditorAssetsMissingError();
    const { createEditEntrypoint } = await import('@plakboek/editor/server');
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
  }

  return async (request, context) => {
    composed ??= compose().catch((error: unknown) => {
      // A failed load is tried again on the next request.
      composed = undefined;
      throw error;
    });
    return await (
      await composed
    )(request, context);
  };
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

  const visitor = createVisitorHandler({
    db: db.db,
    config: config.pages,
    homeSlug: config.homeSlug,
    siteUrl: env.siteUrl,
    ...(cache === undefined ? {} : { cache }),
    ...(env.buildId === undefined ? {} : { buildId: env.buildId }),
    ...siteHooks,
    edit:
      host.edit ?? composeEditor(host, { env, db, auth, resolver, siteHooks }),
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
    notFoundResponse: (request) => sealedNotFoundResponse(siteHooks, request),
  };
}

const runtimes = new WeakMap<object, Runtime>();

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
  }
  return runtime;
}
