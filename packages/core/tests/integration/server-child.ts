/**
 * Runs the production server in its own process so a test can send it a real
 * SIGTERM. Plain TypeScript with erasable syntax only. Arguments: port, the
 * server build entry, the client build directory. The connection string and
 * the rest of the runtime environment come from the process environment.
 *
 * Output: `ready pools=<n>` once listening, `exit pools=<n>` from the exit
 * handler, where n counts the database pools still open.
 */
import { getDb } from '../../src/runtime/db.js';
import { createServer } from '../../src/server.js';

const [port, buildPath, clientDir] = process.argv.slice(2);
if (port === undefined || buildPath === undefined || clientDir === undefined) {
  throw new Error('usage: server-child <port> <server entry> <client dir>');
}

function openPools(): number {
  const registry = Reflect.get(globalThis, Symbol.for('plakboek.db')) as
    | Map<string, unknown>
    | undefined;
  return registry?.size ?? 0;
}

process.on('exit', () => {
  process.stdout.write(`exit pools=${String(openPools())}\n`);
});

const server = await createServer({
  buildPath,
  clientDir,
  port: Number(port),
}).start();

// Make sure there is a pool for the shutdown handler to close.
getDb(process.env.DATABASE_URL ?? '');
process.stdout.write(
  `ready pools=${String(openPools())} port=${String(server.port)}\n`,
);
