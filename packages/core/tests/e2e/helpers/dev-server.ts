/**
 * Starts the real `react-router dev` on the e2e host, against the database
 * the global setup seeded, for the specs that exercise development behaviour.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { E2E_HOST_DIR } from './host.ts';

const REACT_ROUTER_BIN = join(
  E2E_HOST_DIR,
  '..',
  '..',
  'node_modules',
  '.bin',
  'react-router',
);
const STARTUP_TIMEOUT_MS = 60_000;

export type DevServer = {
  /** The dev server's own origin, which is also its `PLAKBOEK_URL`. */
  readonly baseURL: string;
  /** Kills the dev server and everything it spawned. */
  readonly stop: () => Promise<void>;
};

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set: the e2e global setup did not run`);
  }
  return value;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // The child leads its own process group, so a negative pid reaches Vite's
  // workers as well.
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function stopTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveStop) => {
    const force = setTimeout(() => signalTree(child, 'SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(force);
      resolveStop();
    });
    signalTree(child, 'SIGTERM');
  });
}

/**
 * Spawns the dev server on a free port with the database and secret the
 * global setup created, and waits until `/cms/health` answers. `env` adds
 * variables to the server's environment.
 */
export async function startDevServer(
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): Promise<DevServer> {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(
    REACT_ROUTER_BIN,
    ['dev', '--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: E2E_HOST_DIR,
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CI: '1',
        DATABASE_URL: requireEnv('DATABASE_URL'),
        PLAKBOEK_URL: baseURL,
        PLAKBOEK_SECRET: requireEnv('PLAKBOEK_SECRET'),
        ...options.env,
      },
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`The dev server exited early:\n${output}`);
    }
    try {
      if ((await fetch(`${baseURL}/cms/health`)).status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stopTree(child);
      throw new Error(`The dev server did not become ready:\n${output}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return { baseURL, stop: () => stopTree(child) };
}
