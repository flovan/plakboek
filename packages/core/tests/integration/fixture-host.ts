/**
 * Builds the fixture host with the real `react-router build`. The fixture has
 * its own package.json (for its `isbot` dependency) and resolves everything
 * else through the package's own node_modules, plus one `@plakboek/core`
 * symlink to the package under test (its built `dist`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..');

export const FIXTURE_DIR = join(PACKAGE_DIR, 'tests', 'fixture-host');
export const FIXTURE_BUILD_DIR = join(FIXTURE_DIR, 'build');
export const FIXTURE_SERVER_ENTRY = join(
  FIXTURE_BUILD_DIR,
  'server',
  'index.js',
);
export const FIXTURE_CLIENT_DIR = join(FIXTURE_BUILD_DIR, 'client');

/** The variant whose host route table has its own index route. */
export const FIXTURE_HOST_INDEX_BUILD_DIR = join(
  FIXTURE_DIR,
  'build-host-index',
);

/**
 * Links `@plakboek/core` inside a host directory (a fixture or the e2e host)
 * to the package directory.
 */
export function linkCoreInto(hostDir: string): void {
  if (!existsSync(join(PACKAGE_DIR, 'dist', 'routes.js'))) {
    throw new Error(
      'packages/core/dist is missing: run `pnpm --filter @plakboek/core run build` before the integration or e2e suite',
    );
  }
  const scope = join(hostDir, 'node_modules', '@plakboek');
  mkdirSync(scope, { recursive: true });
  const link = join(scope, 'core');
  rmSync(link, { force: true, recursive: true });
  symlinkSync(PACKAGE_DIR, link, 'dir');
}

/** Links `@plakboek/core` inside the fixture to the package directory. */
export function linkCoreIntoFixture(): void {
  linkCoreInto(FIXTURE_DIR);
}

/**
 * Runs `react-router build` in a host directory; throws with its output on
 * failure. `variant` is the environment the host's own config files read:
 * for the fixture, `FIXTURE_BUILD_DIR` (a directory name under the fixture)
 * and `FIXTURE_HOST_INDEX` (`1` adds a host index route).
 */
export function buildHost(
  hostDir: string,
  variant: Readonly<Record<string, string>> = {},
): void {
  const result = spawnSync(
    join(PACKAGE_DIR, 'node_modules', '.bin', 'react-router'),
    ['build'],
    {
      cwd: hostDir,
      encoding: 'utf8',
      // Vite derives `import.meta.env.DEV` from NODE_ENV, and vitest sets it to
      // "test": a production build needs it to be "production".
      env: { ...process.env, CI: '1', NODE_ENV: 'production', ...variant },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `host build failed in ${hostDir} (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/** Runs `react-router build` in the fixture host (see `buildHost`). */
export function buildFixtureHost(
  variant: Readonly<Record<string, string>> = {},
): void {
  buildHost(FIXTURE_DIR, variant);
}
