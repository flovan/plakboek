// Idempotent, bootstrap-guarded pack-and-publish loop over the fixed
// Changesets group (.changeset/config.json). Publishes only versions
// missing from npm, from pnpm-packed tarballs with --provenance, and
// reports a package that has never been published as bootstrap-required
// without publishing it (see RELEASING.md). Run with --dry-run to perform
// every check and print the publish command instead of running it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DependencyMap = Record<string, string>;

type PackageManifest = {
  name: string;
  version: string;
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
  const destination = tmpdir();
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
  const manifestsByName = new Map<string, PackageManifest>();
  const versions = new Set<string>();

  for (const name of group) {
    const dir = directories.get(name);
    if (!dir) {
      console.error(
        `release: fixed-group package '${name}' has no directory under packages/`,
      );
      process.exit(1);
    }
    const manifest = readJson<PackageManifest>(join(dir, 'package.json'));
    manifestsByName.set(name, manifest);
    versions.add(manifest.version);
  }

  if (versions.size > 1) {
    console.error(
      `release: fixed group versions differ: ${[...versions].join(', ')}`,
    );
    process.exit(1);
  }

  const published: string[] = [];
  const skipped: string[] = [];
  const bootstrapRequired: string[] = [];

  for (const name of group) {
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
    const publishArgs = [tarballPath, '--access', 'public', '--provenance'];

    if (DRY_RUN) {
      console.log(`release: would run: npm publish ${publishArgs.join(' ')}`);
    } else {
      execFileSync('npm', ['publish', ...publishArgs], { stdio: 'inherit' });
    }
    published.push(name);
  }

  console.log(
    `release: published=${published.join(',')} skipped=${skipped.join(',')} bootstrap-required=${bootstrapRequired.join(',')}`,
  );
}

main();
