/**
 * The host runtime: the visitor handler built from the host's configuration
 * and the process environment. Memoised per configuration OBJECT, so a
 * reloaded config builds a new handler while the pooled database handle is
 * reused.
 */
import {
  createVisitorHandler,
  type VisitorHandler,
} from '@plakboek/render/server';
import type { DocumentInput } from '@plakboek/render';
import { getDb } from './db.js';
import type { HostModule, SiteContext } from '../types.js';

export type RuntimeEnv = Readonly<Record<string, string | undefined>>;

export type Runtime = {
  readonly visitor: VisitorHandler;
};

/** A configuration problem in the environment. Never carries a value. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

function requireDatabaseUrl(env: RuntimeEnv): string {
  const value = env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new RuntimeConfigError(
      '[@plakboek/core] DATABASE_URL is not set: expected a postgres:// connection string',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new RuntimeConfigError(
      '[@plakboek/core] DATABASE_URL must be a postgres:// or postgresql:// connection string',
    );
  }
  return value;
}

export function createRuntime(host: HostModule, env: RuntimeEnv): Runtime {
  const { config, site } = host;
  const handle = getDb(requireDatabaseUrl(env));
  const siteUrl = env.PLAKBOEK_URL;

  const siteContext = (input: DocumentInput): SiteContext => ({
    siteName: config.siteName,
    locale: input.head.lang,
    defaultLocale: config.content.defaultLocale,
    publicPath: input.publicPath,
    getMenu: () => Promise.resolve([]),
  });

  const visitor = createVisitorHandler({
    db: handle.db,
    config: config.pages,
    homeSlug: config.homeSlug,
    ...(siteUrl === undefined || siteUrl.length === 0 ? {} : { siteUrl }),
    ...(site === undefined
      ? {}
      : {
          renderDocument: (input: DocumentInput) =>
            site.renderDocument(input, siteContext(input)),
        }),
  });

  return { visitor };
}

const runtimes = new WeakMap<object, Runtime>();

/** The runtime for a host module, built once per configuration object. */
export function runtimeFor(
  host: HostModule,
  env: RuntimeEnv = process.env,
): Runtime {
  let runtime = runtimes.get(host.config);
  if (runtime === undefined) {
    runtime = createRuntime(host, env);
    runtimes.set(host.config, runtime);
  }
  return runtime;
}
