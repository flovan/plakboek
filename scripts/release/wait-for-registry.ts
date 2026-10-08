// Waits until every package a release publishes is visible on the registry
// at its own version, in both documents an installer may read.
//
// npm's CDN caches each package document per URL and per variant (the
// abbreviated install metadata and the full document are separate objects) for
// up to five minutes, and edges lag behind one another. One package being
// visible proves nothing about another, and one document being visible proves
// nothing about its sibling. The post-release smoke test therefore waits for
// every package in both documents, over several consecutive rounds, before it
// scaffolds a host and installs from the registry.
//
// Run from the repository root. Exits 0 once the required number of
// consecutive rounds are all green, 1 when the deadline passes first, and 2
// for a usage error.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
};

type DocumentKind = 'abbreviated' | 'full';

type Probe = {
  name: string;
  version: string;
  kind: DocumentKind;
  // Null when the document lists the version, else why it does not count.
  problem: string | null;
};

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const REQUEST_TIMEOUT_MS = 10_000;
const USAGE =
  'usage: node scripts/release/wait-for-registry.ts [--registry <url>] [--rounds <n>] [--interval-ms <n>] [--timeout-ms <n>]';

// The Accept header installers send for install metadata, and the one that
// selects the full document.
const ACCEPT: Record<DocumentKind, string> = {
  abbreviated:
    'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
  full: 'application/json',
};
const KINDS: readonly DocumentKind[] = ['abbreviated', 'full'];

function log(message: string): void {
  console.log(`registry: ${message}`);
}

function usageError(message: string): never {
  console.error(`registry: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function positiveInteger(
  flag: string,
  raw: string | undefined,
  fallback: number,
) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    usageError(`${flag} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/**
 * Every package this repository publishes: all of them under `packages/` that
 * are not marked private. This is the same rule as `findPublishablePackages`
 * in publish-unpublished.ts and must stay in step with it.
 */
function findPublishablePackages(root: string): PackageManifest[] {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  const manifests: PackageManifest[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as PackageManifest;
    if (manifest.private === true) continue;
    manifests.push(manifest);
  }
  return manifests.sort((a, b) => a.name.localeCompare(b.name));
}

async function probe(
  registry: string,
  { name, version }: PackageManifest,
  kind: DocumentKind,
): Promise<Probe> {
  // The exact URL an installer fetches: no query string, and no header that
  // would make the CDN bypass the object an installer receives.
  const url = `${registry}/${name.replace('/', '%2f')}`;
  const result = (problem: string | null): Probe => ({
    name,
    version,
    kind,
    problem,
  });
  try {
    const response = await fetch(url, {
      headers: { accept: ACCEPT[kind] },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return result(`HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      return result('invalid JSON');
    }
    const versions =
      typeof body === 'object' && body !== null && 'versions' in body
        ? (body as { versions: unknown }).versions
        : null;
    if (
      typeof versions === 'object' &&
      versions !== null &&
      Object.hasOwn(versions, version)
    ) {
      return result(null);
    }
    return result(`HTTP 200 without ${version}`);
  } catch {
    return result('fetch failed');
  }
}

function describeMissing(missing: readonly Probe[]): string {
  return missing
    .map(
      ({ name, version, kind, problem }) =>
        `${name}@${version} (${kind}: ${problem})`,
    )
    .join(', ');
}

async function main(): Promise<void> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        registry: { type: 'string' },
        rounds: { type: 'string' },
        'interval-ms': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const registry = (values.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const rounds = positiveInteger('--rounds', values.rounds, 3);
  const intervalMs = positiveInteger(
    '--interval-ms',
    values['interval-ms'],
    20_000,
  );
  const timeoutMs = positiveInteger(
    '--timeout-ms',
    values['timeout-ms'],
    900_000,
  );

  const packages = findPublishablePackages(process.cwd());
  if (packages.length === 0) {
    console.error('registry: no publishable package found under packages/');
    process.exit(1);
  }

  log(
    `waiting for ${packages.map(({ name, version }) => `${name}@${version}`).join(', ')}`,
  );

  const startedAt = Date.now();
  let consecutive = 0;
  for (;;) {
    const probes = await Promise.all(
      packages.flatMap((manifest) =>
        KINDS.map((kind) => probe(registry, manifest, kind)),
      ),
    );
    const missing = probes.filter(({ problem }) => problem !== null);

    if (missing.length === 0) {
      consecutive += 1;
      log(
        `all ${packages.length} packages visible (${consecutive} of ${rounds} consecutive rounds)`,
      );
      if (consecutive >= rounds) {
        log('every published package is visible in both documents');
        process.exit(0);
      }
    } else {
      consecutive = 0;
      log(`waiting for ${describeMissing(missing)}`);
    }

    if (Date.now() + intervalMs - startedAt > timeoutMs) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.error(
        `registry: gave up after ${elapsed}s; still missing ${
          missing.length === 0
            ? `a ${rounds}-round streak of green rounds`
            : describeMissing(missing)
        }`,
      );
      process.exit(1);
    }
    await sleep(intervalMs);
  }
}

await main();
