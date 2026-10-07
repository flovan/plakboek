/**
 * The production server against the built fixture host: env refusal before
 * listening, static cache headers, fall-through to React Router and a clean
 * SIGTERM shutdown (D-03, D-06).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getDb } from '../../src/runtime/db.js';
import { PlakboekEnvError } from '../../src/runtime/env.js';
import { createServer } from '../../src/server.js';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
import {
  createEmptyInstallation,
  type EmptyInstallation,
} from './installation.js';

const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=3600';

describe('createServer().start()', () => {
  let installation: EmptyInstallation;

  beforeAll(async () => {
    installation = await createEmptyInstallation();
  });

  afterAll(async () => {
    await installation.dispose();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects with PlakboekEnvError before loading the build when the secret is missing', async () => {
    vi.stubEnv('PLAKBOEK_SECRET', '');
    const server = createServer({
      buildPath: join(PACKAGE_DIR, 'does-not-exist.js'),
      port: 0,
    });
    await expect(server.start()).rejects.toBeInstanceOf(PlakboekEnvError);
  });

  it('serves a hashed asset as immutable, a public file for an hour and falls through on a miss', async () => {
    const server = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    });
    const assetName = readdirSync(join(FIXTURE_CLIENT_DIR, 'assets')).find(
      (name) => name.endsWith('.js'),
    );
    expect(assetName).toBeDefined();

    const asset = await fetch(server.url(`/assets/${assetName ?? ''}`));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Cache-Control')).toBe(IMMUTABLE);
    await asset.text();

    const robots = await fetch(server.url('/robots.txt'));
    expect(robots.status).toBe(200);
    expect(robots.headers.get('Cache-Control')).toBe(SHORT);
    expect(await robots.text()).toContain('User-agent');

    const missing = await fetch(server.url('/assets/missing.js'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).not.toBe(IMMUTABLE);
    await missing.text();

    // A dynamic response keeps the handler's own policy.
    const health = await fetch(server.url('/cms/health'));
    expect(health.headers.get('Cache-Control')).not.toBe(IMMUTABLE);
    expect(health.headers.get('Cache-Control')).not.toBe(SHORT);
    await health.text();
  });

  it('honours PORT and HOST, and lets the explicit port win', async () => {
    vi.stubEnv('PORT', '0');
    vi.stubEnv('HOST', '127.0.0.1');
    const fromEnv = await createServer({
      buildPath: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    }).start();
    try {
      expect(fromEnv.host).toBe('127.0.0.1');
      expect(fromEnv.port).toBeGreaterThan(0);
      const response = await fetch(
        `http://127.0.0.1:${fromEnv.port}/cms/health`,
      );
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      await fromEnv.close();
    }

    vi.stubEnv('PORT', '54999');
    const explicit = await createServer({
      buildPath: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
      port: 0,
    }).start();
    try {
      expect(explicit.port).not.toBe(54999);
    } finally {
      await explicit.close();
    }
  });

  it('closes the database pools when the handle is closed', async () => {
    const running = await createServer({
      buildPath: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
      port: 0,
    }).start();
    const url = process.env.DATABASE_URL ?? '';
    const before = getDb(url);
    await running.close();
    expect(getDb(url)).not.toBe(before);
  });

  it('forces a hung request closed once the shutdown bound passes', async () => {
    const server = createServer({
      buildPath: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
      port: 0,
      shutdownTimeoutMs: 300,
    });
    server.app.get('/hang', () => new Promise<Response>(() => undefined));
    const running = await server.start();

    const socket = connect(running.port, '127.0.0.1');
    await new Promise<void>((resolveConnect) =>
      socket.once('connect', () => resolveConnect()),
    );
    socket.on('error', () => undefined);
    socket.write('GET /hang HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));

    const started = Date.now();
    await running.close();
    expect(Date.now() - started).toBeLessThan(5000);
    socket.destroy();
  });
});

describe('the server process', () => {
  let installation: EmptyInstallation;

  beforeAll(async () => {
    installation = await createEmptyInstallation();
  });

  afterAll(async () => {
    await installation.dispose();
  });

  it('exits 0 within 10 seconds of SIGTERM with its pools closed', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(import.meta.dirname, 'server-child.ts'),
        '0',
        FIXTURE_SERVER_ENTRY,
        FIXTURE_CLIENT_DIR,
      ],
      { cwd: PACKAGE_DIR, env: { ...process.env, NODE_ENV: 'production' } },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    const exited = new Promise<number | null>((resolveExit) =>
      child.once('exit', (code) => resolveExit(code)),
    );

    const deadline = Date.now() + 30_000;
    let port: number | undefined;
    while (port === undefined && Date.now() < deadline) {
      const match = /ready pools=\d+ port=(\d+)/.exec(output);
      if (match) port = Number(match[1]);
      else await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (port === undefined) {
      child.kill('SIGKILL');
      throw new Error(`server child did not become ready:\n${output}`);
    }

    const health = await fetch(`http://127.0.0.1:${port}/cms/health`);
    expect(health.status).toBe(200);
    await health.text();
    expect(output).toContain('ready pools=');
    expect(output).not.toContain('ready pools=0');

    const signalled = Date.now();
    child.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolveTimeout) =>
        setTimeout(() => resolveTimeout('timeout'), 10_000),
      ),
    ]);
    if (code === 'timeout') child.kill('SIGKILL');

    expect(code).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(10_000);
    expect(output).toContain('exit pools=0');
  });
});
