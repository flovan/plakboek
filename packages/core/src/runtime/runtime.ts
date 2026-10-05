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
import type { DocumentInput } from '@plakboek/render';
import {
  createVisitorHandler,
  type VisitorHandler,
} from '@plakboek/render/server';
import type { HostModule, PlakboekConfig, SiteContext } from '../types.js';
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
};

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

  const siteContext = (input: DocumentInput): SiteContext => ({
    siteName: config.siteName,
    locale: input.head.lang,
    defaultLocale: config.content.defaultLocale,
    publicPath: input.publicPath,
    getMenu: () => Promise.resolve([]),
  });

  const visitor = createVisitorHandler({
    db: db.db,
    config: config.pages,
    homeSlug: config.homeSlug,
    siteUrl: env.siteUrl,
    ...(cache === undefined ? {} : { cache }),
    ...(env.buildId === undefined ? {} : { buildId: env.buildId }),
    ...(site === undefined
      ? {}
      : {
          renderDocument: (input: DocumentInput) =>
            site.renderDocument(input, siteContext(input)),
        }),
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
