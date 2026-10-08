import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type DocumentKind = 'abbreviated' | 'full';

type Reply = { status: number; body: string };

// Decides one response from the decoded package name, the document kind and
// how many times that pair has been requested so far (1 for the first).
type Handler = (request: {
  name: string;
  kind: DocumentKind;
  count: number;
}) => Reply;

type Recorded = { url: string; accept: string; headers: IncomingHttpHeaders };

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const SCRIPT = fileURLToPath(
  new URL('../wait-for-registry.ts', import.meta.url),
);

// create-plakboek and @plakboek/db share a version; @plakboek/core differs, so
// a registry that only knows the shared version can never satisfy core.
const PACKAGES = [
  { dir: 'create-plakboek', name: 'create-plakboek', version: '0.5.1' },
  { dir: 'core', name: '@plakboek/core', version: '0.5.2' },
  { dir: 'db', name: '@plakboek/db', version: '0.5.1' },
] as const;
const VERSION_OF = new Map<string, string>(
  PACKAGES.map(({ name, version }) => [name, version]),
);
const PRIVATE_NAME = '@plakboek/internal-tools';

const ok = (versions: readonly string[]): Reply => ({
  status: 200,
  body: JSON.stringify({
    versions: Object.fromEntries(versions.map((v) => [v, {}])),
  }),
});

// Lists exactly the package's own version.
const listed = (name: string): Reply => ok([VERSION_OF.get(name) ?? '']);

function kindOf(accept: string): DocumentKind {
  return accept.includes('application/vnd.npm.install-v1+json')
    ? 'abbreviated'
    : 'full';
}

describe('wait-for-registry.ts', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let requests: Recorded[];
  let counts: Map<string, number>;
  let handler: Handler;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'plakboek-wait-test-'));
    for (const { dir, name, version } of PACKAGES) {
      mkdirSync(join(root, 'packages', dir), { recursive: true });
      writeFileSync(
        join(root, 'packages', dir, 'package.json'),
        JSON.stringify({ name, version }),
      );
    }
    mkdirSync(join(root, 'packages', 'internal-tools'));
    writeFileSync(
      join(root, 'packages', 'internal-tools', 'package.json'),
      JSON.stringify({ name: PRIVATE_NAME, version: '9.9.9', private: true }),
    );

    requests = [];
    counts = new Map();
    handler = ({ name }) => listed(name);
    server = createServer((req, res) => {
      const url = req.url ?? '';
      const accept = String(req.headers.accept ?? '');
      requests.push({ url, accept, headers: req.headers });
      const name = decodeURIComponent(
        url.replace(/^\//, '').split('?')[0] ?? '',
      );
      const kind = kindOf(accept);
      const key = `${name}|${kind}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const reply = handler({ name, kind, count });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(root, { recursive: true, force: true });
  });

  // Asynchronous on purpose: a synchronous spawn would block the event loop
  // that answers the in-process registry.
  function run(extraArgs: readonly string[] = []): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          SCRIPT,
          '--registry',
          baseUrl,
          '--interval-ms',
          '10',
          '--timeout-ms',
          '1500',
          ...extraArgs,
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  const countOf = (name: string, kind: DocumentKind): number =>
    counts.get(`${name}|${kind}`) ?? 0;

  it('succeeds after three green rounds, probing every publishable package twice per round at the installer URLs', async () => {
    const result = await run();

    expect(result.status).toBe(0);
    for (const { name } of PACKAGES) {
      expect(countOf(name, 'abbreviated')).toBe(3);
      expect(countOf(name, 'full')).toBe(3);
    }
    expect(requests).toHaveLength(PACKAGES.length * 2 * 3);

    const urls = new Set(requests.map(({ url }) => url));
    expect(urls).toEqual(
      new Set(['/create-plakboek', '/@plakboek%2fcore', '/@plakboek%2fdb']),
    );
    expect([...urls].some((url) => url.includes('?'))).toBe(false);
    for (const { headers } of requests) {
      expect(headers['cache-control']).toBeUndefined();
      expect(headers.pragma).toBeUndefined();
    }
    const accepts = new Set(requests.map(({ accept }) => accept));
    expect(accepts).toEqual(
      new Set([
        'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
        'application/json',
      ]),
    );
    expect(countOf(PRIVATE_NAME, 'abbreviated')).toBe(0);
    expect(countOf(PRIVATE_NAME, 'full')).toBe(0);
  });

  it('never goes green while a package lists only another package version', async () => {
    // Everything, @plakboek/core included, lists only 0.5.1, but core is at
    // 0.5.2 in the checkout.
    handler = () => ok(['0.5.1']);

    const result = await run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gave up');
    expect(result.stderr).toContain('@plakboek/core@0.5.2');
    expect(result.stderr).not.toContain('@plakboek/db@0.5.1');
    expect(result.stderr).not.toContain('create-plakboek@0.5.1');
  });

  it('resets the consecutive count when an edge flaps', async () => {
    handler = ({ name, kind, count }) =>
      name === '@plakboek/core' && kind === 'abbreviated' && count === 2
        ? ok([])
        : listed(name);

    const result = await run();

    expect(result.status).toBe(0);
    // Green on round 1, red on round 2, then three green rounds: 3, 4, 5.
    expect(countOf('@plakboek/core', 'abbreviated')).toBe(5);
    expect(countOf('create-plakboek', 'full')).toBe(5);
  });

  it.each<DocumentKind>(['abbreviated', 'full'])(
    'never goes green while only the %s document lists the version',
    async (visibleKind) => {
      handler = ({ name, kind }) =>
        kind === visibleKind ? listed(name) : ok([]);

      const result = await run();

      expect(result.status).toBe(1);
      const missingKind = visibleKind === 'full' ? 'abbreviated' : 'full';
      expect(result.stderr).toContain(`(${missingKind}:`);
      expect(result.stderr).not.toContain(`(${visibleKind}:`);
    },
  );

  it('exits non-zero near the deadline naming each missing version and document kind', async () => {
    handler = () => ({ status: 404, body: '{"error":"Not found"}' });

    const startedAt = Date.now();
    const result = await run();

    expect(result.status).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.stderr).toMatch(/gave up after \d+s/);
    for (const { name, version } of PACKAGES) {
      expect(result.stderr).toContain(
        `${name}@${version} (abbreviated: HTTP 404)`,
      );
      expect(result.stderr).toContain(`${name}@${version} (full: HTTP 404)`);
    }
    expect(result.stderr).not.toContain(PRIVATE_NAME);
  });

  it('treats a 404, a 503 and a non-JSON body as not yet, and still succeeds', async () => {
    handler = ({ name, kind, count }) => {
      if (name === '@plakboek/core' && kind === 'abbreviated') {
        if (count === 1) return { status: 404, body: '{"error":"Not found"}' };
        if (count === 2) return { status: 503, body: 'Service Unavailable' };
        if (count === 3) return { status: 200, body: '<html>not json</html>' };
      }
      return listed(name);
    };

    const result = await run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('HTTP 404');
    expect(result.stdout).toContain('HTTP 503');
    expect(result.stdout).toContain('invalid JSON');
    // Three failed rounds, then three consecutive green ones.
    expect(countOf('@plakboek/core', 'abbreviated')).toBe(6);
  });

  it('rejects an invalid option with usage and exit code 2', async () => {
    const result = await run(['--rounds', '0']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
    expect(requests).toHaveLength(0);
  });
});
