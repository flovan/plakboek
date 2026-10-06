import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the release pipeline's package list.
 *
 * `scripts/release/publish-unpublished.ts` used to take its publish list
 * from the Changesets `fixed` group. That group means "these packages share
 * a version number", not "these packages get published", so every package
 * outside it was versioned and silently never published. `@plakboek/auth`
 * sat at 0.2.0 unpublished for nine days because of it, and the run summary
 * did not even list it as skipped, because it was never a candidate.
 *
 * The script now derives its list from the workspace. This test pins that
 * relationship so a future change cannot quietly narrow it again.
 *
 * It lives here rather than beside the script because `scripts/` has no test
 * harness of its own, and `@plakboek/db` is already release-adjacent.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function workspacePackages(): { name: string; private: boolean }[] {
  const packagesDir = join(REPO_ROOT, 'packages');
  const found: { name: string; private: boolean }[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      private?: boolean;
    };
    found.push({ name: manifest.name, private: manifest.private === true });
  }
  return found;
}

describe('release publish candidates', () => {
  it('the publish script derives its list from the workspace, not the fixed group', () => {
    const script = readFileSync(
      join(REPO_ROOT, 'scripts', 'release', 'publish-unpublished.ts'),
      'utf8',
    );
    // The regression this test exists for: the publish loop walking the
    // Changesets fixed group.
    expect(script).toContain('findPublishablePackages');
    expect(script).toMatch(/for \(const name of candidates\)/);
    expect(script).not.toMatch(/for \(const name of group\)/);
  });

  it('every non-private workspace package is publishable', () => {
    const packages = workspacePackages();
    expect(packages.length).toBeGreaterThan(0);

    const publishable = packages
      .filter((entry) => !entry.private)
      .map((entry) => entry.name)
      .sort();

    // Pinned explicitly so adding a package is a deliberate act that updates
    // this list, rather than something the release pipeline can miss.
    expect(publishable).toEqual([
      '@plakboek/auth',
      '@plakboek/cache',
      '@plakboek/content',
      '@plakboek/core',
      '@plakboek/db',
      '@plakboek/pages',
      '@plakboek/permissions',
      '@plakboek/render',
      'create-plakboek',
    ]);
  });

  it('the Changesets fixed group is exactly the publishable set', () => {
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] };
    const publishable = workspacePackages()
      .filter((entry) => !entry.private)
      .map((entry) => entry.name)
      .sort();

    // Every publishable package versions together as one group, so the
    // starter's `@plakboek/core` / `@plakboek/render` pins can equal the CLI's
    // own version (01 D-17, D-18). A package missing from the group would
    // drift to its own version line and break that pin; a name in the group
    // that is not publishable would make Changesets fail on an unknown
    // package. The first test above is what still stops the publish loop
    // from walking this group instead of the workspace.
    expect(config.fixed).toHaveLength(1);
    expect([...(config.fixed[0] ?? [])].sort()).toEqual(publishable);
  });
});
