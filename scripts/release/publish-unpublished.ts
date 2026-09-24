// Idempotent, bootstrap-guarded pack-and-publish loop over the fixed
// Changesets group (.changeset/config.json). Publishes only versions
// missing from npm, from pnpm-packed tarballs with --provenance, and
// reports a package that has never been published as bootstrap-required
// without publishing it (see RELEASING.md). Run with --dry-run to perform
// every check and print the publish command instead of running it.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type DependencyMap = Record<string, string>;

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  repository?: { url?: string };
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
};

type ChangesetConfig = {
  fixed: readonly (readonly string[])[];
};

const REPO_ROOT = process.cwd();
const EXPECTED_REPOSITORY_URL = 'git+https://github.com/flovan/plakboek.git';
const DRY_RUN = process.argv.includes('--dry-run');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function findPackageDirectories(): Map<string, string> {
  const packagesDir = join(REPO_ROOT, 'packages');
  const directories = new Map<string, string>();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson<PackageManifest>(manifestPath);
    directories.set(manifest.name, dir);
  }
  return directories;
}

/**
 * Every package this repository intends to publish: all of them under
 * `packages/` that are not marked private.
 *
 * This is deliberately NOT the Changesets `fixed` group. That group means
 * "these packages share a version number", not "these packages get
 * published", and reading it as the publish list silently dropped every
 * package outside it. `@plakboek/auth` was versioned to 0.2.0 and never
 * reached npm for nine days because of exactly that, and the summary line
 * did not even list it as skipped, because it was never a candidate.
 *
 * Deriving the list from the workspace makes that omission unrepresentable:
 * a new package is publishable the moment it exists and is not private.
 */
function findPublishablePackages(
  directories: ReadonlyMap<string, string>,
): string[] {
  const names: string[] = [];
  for (const [name, dir] of directories) {
    const manifest = readJson<PackageManifest>(join(dir, 'package.json'));
    if (manifest.private === true) continue;
    names.push(name);
  }
  return names.sort();
}

function tryRun(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function npmPublishedVersion(name: string, version: string): string | null {
  const stdout = tryRun('npm', ['view', `${name}@${version}`, 'version']);
  return stdout === null ? null : stdout.trim();
}

function npmPackageExists(name: string): boolean {
  return tryRun('npm', ['view', name, 'name']) !== null;
}

function hasCatalogOrWorkspaceSpecifier(manifest: PackageManifest): boolean {
  const maps: (DependencyMap | undefined)[] = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
  ];
  for (const map of maps) {
    if (!map) continue;
    for (const specifier of Object.values(map)) {
      if (
        specifier.startsWith('catalog:') ||
        specifier.startsWith('workspace:')
      ) {
        return true;
      }
    }
  }
  return false;
}

function packAndValidate(name: string, dir: string): string {
  // A fresh directory per package: packing every package into the shared
  // OS tmpdir() left prior packages' tarballs sitting alongside the new
  // one, and `.sort().pop()` (last alphabetically) could then pick a
  // leftover tarball from an earlier iteration instead of the one just
  // packed here.
  // Cleaned up by the caller (via dirname(tarballPath)) once the tarball it
  // packs has been published or skipped; cleaned up here directly if
  // packing/validation itself fails before a tarball path is ever returned.
  const destination = mkdtempSync(join(tmpdir(), 'plakboek-release-'));
  try {
    execFileSync(
      'pnpm',
      ['--dir', dir, 'pack', '--pack-destination', destination],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    const tarballName = readdirSync(destination)
      .filter((fileName) => fileName.endsWith('.tgz'))
      .sort()
      .pop();
    if (!tarballName) {
      throw new Error(
        `pnpm pack produced no tarball for ${name} in ${destination}`,
      );
    }
    const tarballPath = join(destination, tarballName);
    const packedManifestRaw = execFileSync(
      'tar',
      ['-xOzf', tarballPath, 'package/package.json'],
      { encoding: 'utf8' },
    );
    const packedManifest = readJsonString<PackageManifest>(packedManifestRaw);

    if (hasCatalogOrWorkspaceSpecifier(packedManifest)) {
      throw new Error(
        `${name}: packed manifest in ${tarballName} still contains a catalog: or workspace: specifier`,
      );
    }
    if (packedManifest.repository?.url !== EXPECTED_REPOSITORY_URL) {
      throw new Error(
        `${name}: packed manifest repository.url is '${packedManifest.repository?.url}', expected '${EXPECTED_REPOSITORY_URL}'`,
      );
    }
    return tarballPath;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function readJsonString<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function main(): void {
  const changesetConfig = readJson<ChangesetConfig>(
    join(REPO_ROOT, '.changeset', 'config.json'),
  );
  const group = changesetConfig.fixed[0];
  if (!group || group.length === 0) {
    console.error(
      'release: .changeset/config.json has no fixed group to publish',
    );
    process.exit(1);
  }

  const directories = findPackageDirectories();
  const candidates = findPublishablePackages(directories);
  if (candidates.length === 0) {
    console.error('release: no publishable package found under packages/');
    process.exit(1);
  }

  // The fixed group is still checked, but only for what it actually means:
  // its members must exist and must agree on a version. It no longer decides
  // WHICH packages are published.
  const missingFromWorkspace = group.filter((name) => !directories.has(name));
  if (missingFromWorkspace.length > 0) {
    console.error(
      `release: fixed-group package(s) with no directory under packages/: ${missingFromWorkspace.join(', ')}`,
    );
    process.exit(1);
  }

  const manifestsByName = new Map<string, PackageManifest>();
  for (const name of candidates) {
    const dir = directories.get(name);
    if (!dir) continue;
    manifestsByName.set(
      name,
      readJson<PackageManifest>(join(dir, 'package.json')),
    );
  }

  const groupVersions = new Set(
    group.map((name) => manifestsByName.get(name)?.version).filter(Boolean),
  );
  if (groupVersions.size > 1) {
    console.error(
      `release: fixed group versions differ: ${[...groupVersions].join(', ')}`,
    );
    process.exit(1);
  }

  console.log(`release: publish candidates=${candidates.join(',')}`);

  const published: string[] = [];
  const skipped: string[] = [];
  const bootstrapRequired: string[] = [];

  for (const name of candidates) {
    const dir = directories.get(name);
    const manifest = manifestsByName.get(name);
    if (!dir || !manifest) continue;

    const alreadyPublished = npmPublishedVersion(name, manifest.version);
    if (alreadyPublished === manifest.version) {
      skipped.push(name);
      continue;
    }

    if (!npmPackageExists(name)) {
      console.log(
        `::warning::${name} has never been published to npm -- see RELEASING.md for the bootstrap procedure`,
      );
      bootstrapRequired.push(name);
      continue;
    }

    const tarballPath = packAndValidate(name, dir);
    try {
      const publishArgs = [tarballPath, '--access', 'public', '--provenance'];

      if (DRY_RUN) {
        console.log(`release: would run: npm publish ${publishArgs.join(' ')}`);
      } else {
        execFileSync('npm', ['publish', ...publishArgs], { stdio: 'inherit' });
      }
      published.push(name);
    } finally {
      rmSync(dirname(tarballPath), { recursive: true, force: true });
    }
  }

  console.log(
    `release: published=${published.join(',')} skipped=${skipped.join(',')} bootstrap-required=${bootstrapRequired.join(',')}`,
  );
}

main();
