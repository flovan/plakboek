/**
 * Builds the fixture host with the real `react-router build`. The fixture has
 * no package.json of its own: it resolves everything through the package's
 * own node_modules, plus one symlink so `@plakboek/core` resolves to the
 * package under test (its built `dist`).
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

/** Links `@plakboek/core` inside the fixture to the package directory. */
export function linkCoreIntoFixture(): void {
  if (!existsSync(join(PACKAGE_DIR, 'dist', 'routes.js'))) {
    throw new Error(
      'packages/core/dist is missing: run `pnpm --filter @plakboek/core run build` before the integration suite',
    );
  }
  const scope = join(FIXTURE_DIR, 'node_modules', '@plakboek');
  mkdirSync(scope, { recursive: true });
  const link = join(scope, 'core');
  rmSync(link, { force: true, recursive: true });
  symlinkSync(PACKAGE_DIR, link, 'dir');
}

/** Runs `react-router build` in the fixture; throws with its output on failure. */
export function buildFixtureHost(): void {
  const result = spawnSync(
    join(PACKAGE_DIR, 'node_modules', '.bin', 'react-router'),
    ['build'],
    { cwd: FIXTURE_DIR, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  );
  if (result.status !== 0) {
    throw new Error(
      `fixture host build failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}
