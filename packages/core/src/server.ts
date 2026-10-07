/**
 * The production server: a Hono app serving the build's static assets, then
 * handing every other request to the React Router request handler.
 *
 * It validates the runtime environment before loading the build, so a bad
 * `.env` fails the container at start instead of the first request. On
 * SIGTERM or SIGINT (what `docker compose up -d` sends the old container) it
 * stops accepting connections, lets in-flight requests finish for a bounded
 * time, closes every database pool and exits 0.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createRequestHandler, type ServerBuild } from 'react-router';
import { closeAllDbs } from './runtime/db.js';
import { readRuntimeEnv } from './runtime/env.js';
import {
  SETUP_BODY_LIMIT_BYTES,
  isSetupPath,
  payloadTooLarge,
} from './setup/body-limit.js';

/** How long in-flight requests may take once a shutdown starts. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const STATIC_CACHE = 'public, max-age=3600';

export type CreateServerOptions = {
  /** The server build entry; defaults to `build/server/index.js`. */
  readonly buildPath?: string;
  /** The client build directory; defaults to `build/client`. */
  readonly clientDir?: string;
  /** Defaults to `PORT`, then 3000. `0` picks a free port. */
  readonly port?: number;
  /** Defaults to `HOST`, then `0.0.0.0`. */
  readonly host?: string;
  /** Milliseconds in-flight requests get to finish on close; defaults to 10000. */
  readonly shutdownTimeoutMs?: number;
};

export type RunningServer = {
  readonly port: number;
  readonly host: string;
  /**
   * Stops accepting connections, waits for in-flight requests (up to the
   * shutdown bound, then forces them closed) and closes every database pool.
   * Does not exit the process.
   */
  close(): Promise<void>;
};

export type PlakboekServer = {
  readonly app: Hono;
  start(): Promise<RunningServer>;
};

/** Every server this process started and has not closed yet. */
const running = new Set<RunningServer>();
let signalsInstalled = false;

async function shutdownFromSignal(): Promise<void> {
  try {
    await Promise.all([...running].map((server) => server.close()));
    await closeAllDbs();
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `[@plakboek/core] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

function onSignal(): void {
  void shutdownFromSignal();
}

/** One pair of handlers per process, however many servers are started. */
function syncSignalHandlers(): void {
  if (running.size > 0 && !signalsInstalled) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    signalsInstalled = true;
  } else if (running.size === 0 && signalsInstalled) {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    signalsInstalled = false;
  }
}

export function createServer(
  options: CreateServerOptions = {},
): PlakboekServer {
  const buildPath = resolve(options.buildPath ?? 'build/server/index.js');
  const clientDir = resolve(options.clientDir ?? 'build/client');
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const app = new Hono();

  // First middleware, so nothing touches a setup body ahead of it. A declared
  // Content-Length is trusted: Node's HTTP parser never delivers more body
  // bytes than declared. A chunked body is counted as it streams. The setup
  // handlers carry their own cap for runtimes that skip this server. The path
  // is checked by predicate, not pattern: Hono matches case-sensitively but
  // React Router does not.
  const setupBodyLimit = bodyLimit({
    maxSize: SETUP_BODY_LIMIT_BYTES,
    onError: () => payloadTooLarge(),
  });
  app.use('*', async (context, next) => {
    if (isSetupPath(context.req.path)) {
      return await setupBodyLimit(context, next);
    }
    return await next();
  });

  // Only files actually served from the build get a static policy: hashed
  // filenames never change, everything else is short-lived. A miss falls
  // through to the request handler below, whose responses keep their own
  // cache policy.
  app.use(
    '*',
    serveStatic({
      root: clientDir,
      onFound: (_path, context) => {
        context.header(
          'Cache-Control',
          context.req.path.startsWith('/assets/')
            ? IMMUTABLE_CACHE
            : STATIC_CACHE,
        );
      },
    }),
  );

  return {
    app,
    async start(): Promise<RunningServer> {
      // Before anything else: a bad environment must not leave a listening
      // server behind.
      readRuntimeEnv(process.env);

      // A variable import keeps TypeScript and bundlers from resolving it.
      const build = (await import(
        pathToFileURL(buildPath).href
      )) as ServerBuild;
      const handle = createRequestHandler(build, 'production');
      app.all('*', (context) => handle(context.req.raw));

      const port = options.port ?? Number(process.env.PORT ?? 3000);
      const host = options.host ?? process.env.HOST ?? '0.0.0.0';
      return await new Promise<RunningServer>((resolvePromise, reject) => {
        const server = serve(
          { fetch: app.fetch, port, hostname: host },
          (info) => {
            let closing: Promise<void> | undefined;
            const handle: RunningServer = {
              port: info.port,
              host: info.address,
              close: () => {
                closing ??= (async () => {
                  await stopListening(server, shutdownTimeoutMs);
                  running.delete(handle);
                  syncSignalHandlers();
                  await closeAllDbs();
                })();
                return closing;
              },
            };
            running.add(handle);
            syncSignalHandlers();
            resolvePromise(handle);
          },
        );
        server.once('error', reject);
      });
    },
  };
}

type Listener = ReturnType<typeof serve>;

/** Stops accepting, waits for requests up to the bound, then forces them. */
async function stopListening(
  server: Listener,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((done, fail) => {
    const force = setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
    }, timeoutMs);
    server.close((error) => {
      clearTimeout(force);
      if (error) fail(error);
      else done();
    });
    if ('closeIdleConnections' in server) server.closeIdleConnections();
  });
}
