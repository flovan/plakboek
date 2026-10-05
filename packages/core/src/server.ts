/**
 * The production server: a Hono app serving the build's static assets, then
 * handing every other request to the React Router request handler.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createRequestHandler, type ServerBuild } from 'react-router';

export type CreateServerOptions = {
  /** The server build entry; defaults to `build/server/index.js`. */
  readonly buildPath?: string;
  /** The client build directory; defaults to `build/client`. */
  readonly clientDir?: string;
  /** Defaults to `PORT`, then 3000. `0` picks a free port. */
  readonly port?: number;
};

export type RunningServer = {
  readonly port: number;
  close(): Promise<void>;
};

export type PlakboekServer = {
  readonly app: Hono;
  start(): Promise<RunningServer>;
};

export function createServer(
  options: CreateServerOptions = {},
): PlakboekServer {
  const buildPath = resolve(options.buildPath ?? 'build/server/index.js');
  const clientDir = resolve(options.clientDir ?? 'build/client');
  const app = new Hono();

  // Hashed filenames never change, so they may be cached forever.
  app.use('/assets/*', async (context, next) => {
    await next();
    if (context.res.status === 200) {
      context.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
  });
  // A static miss falls through to the request handler below.
  app.use('*', serveStatic({ root: clientDir }));

  return {
    app,
    async start(): Promise<RunningServer> {
      // A variable import keeps TypeScript and bundlers from resolving it.
      const build = (await import(
        pathToFileURL(buildPath).href
      )) as ServerBuild;
      const handle = createRequestHandler(build, 'production');
      app.all('*', (context) => handle(context.req.raw));

      const port = options.port ?? Number(process.env.PORT ?? 3000);
      return await new Promise<RunningServer>((resolvePromise, reject) => {
        const server = serve({ fetch: app.fetch, port }, (info) => {
          resolvePromise({
            port: info.port,
            close: () =>
              new Promise<void>((done, fail) => {
                server.close((error) => (error ? fail(error) : done()));
              }),
          });
        });
        server.once('error', reject);
      });
    },
  };
}
