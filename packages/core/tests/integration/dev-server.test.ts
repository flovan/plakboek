/**
 * The development loop against the real `react-router dev` on the fixture
 * host: the Vite client reaches the browser (live reload) and the dev server
 * refuses to boot without a generated secret (D-22, D-28).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET_GENERATION_COMMAND } from '../../src/runtime/env.js';
import { FIXTURE_DIR } from './fixture-host.js';
import { createInstallation, type Installation } from './installation.js';

const REACT_ROUTER_BIN = join(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  'react-router',
);
const STARTUP_TIMEOUT_MS = 45_000;
const SECRET = 'dev-server-test-secret-0123456789-abcdefghijklm';

const RUNTIME_KEYS = ['DATABASE_URL', 'PLAKBOEK_URL', 'PLAKBOEK_SECRET'];

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

type DevProcess = {
  readonly child: ChildProcess;
  readonly output: () => string;
};

function startDev(port: number, env: Record<string, string>): DevProcess {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of RUNTIME_KEYS) Reflect.deleteProperty(base, key);
  Reflect.deleteProperty(base, 'NODE_ENV');
  let collected = '';
  const child = spawn(
    REACT_ROUTER_BIN,
    ['dev', '--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    { cwd: FIXTURE_DIR, env: { ...base, CI: '1', ...env } },
  );
  child.stdout?.on('data', (chunk: Buffer) => (collected += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (collected += chunk.toString()));
  return { child, output: () => collected };
}

async function waitFor(
  probe: () => Promise<boolean>,
  failure: () => string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`dev server did not become ready: ${failure()}`);
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveStop) => {
    child.once('exit', () => resolveStop());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  });
}

describe('react-router dev on the fixture host', () => {
  let installation: Installation;
  let dev: DevProcess;
  let port: number;

  beforeAll(async () => {
    installation = await createInstallation();
    port = await freePort();
    dev = startDev(port, {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      PLAKBOEK_URL: `http://127.0.0.1:${port}`,
      PLAKBOEK_SECRET: SECRET,
    });
    await waitFor(
      async () =>
        (await fetch(`http://127.0.0.1:${port}/@vite/client`)).status === 200,
      dev.output,
    );
  });

  afterAll(async () => {
    if (dev) await stop(dev.child);
    await installation?.dispose();
  });

  it('serves the Vite client script as JavaScript', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/@vite/client`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('javascript');
    await response.text();
  });

  it('injects the Vite client into the visitor page', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('/@vite/client');
    expect(body).toContain('</head>');
  });
});

describe('react-router dev without a secret', () => {
  it('exits non-zero and prints the generation command', async () => {
    const port = await freePort();
    const dev = startDev(port, {
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/none',
      PLAKBOEK_URL: `http://127.0.0.1:${port}`,
    });
    const code = await new Promise<number | null>((resolveExit) => {
      dev.child.once('exit', (exitCode) => resolveExit(exitCode));
      setTimeout(() => dev.child.kill('SIGKILL'), STARTUP_TIMEOUT_MS).unref();
    });
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(dev.output()).toContain(SECRET_GENERATION_COMMAND);
  });
});
