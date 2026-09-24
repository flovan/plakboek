import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  repository: { url: string };
  dependencies?: Record<string, string>;
};

type PackageSpec = {
  dir: string;
  name: string;
  overrides?: Partial<Manifest>;
};

type Sandbox = {
  root: string;
  bin: string;
  repo: string;
  tmp: string;
  npmLog: string;
  pnpmLog: string;
};

type RunOptions = {
  args?: readonly string[];
  existing?: readonly string[];
  published?: readonly string[];
};

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const SCRIPT = fileURLToPath(
  new URL('../publish-unpublished.ts', import.meta.url),
);
const REPOSITORY_URL = 'git+https://github.com/flovan/plakboek.git';

// The Changesets fixed group: these share a version number. It is NOT the
// publish list -- the script derives that from the workspace. Every test that
// cares about the difference leans on `@plakboek/content` below, which sits
// outside this group and must still be published.
const FIXED_GROUP = ['@plakboek/permissions', '@plakboek/db'] as const;

// Sorted the way the script sorts candidates, so tests can assert on order.
const DEFAULT_PACKAGES: readonly PackageSpec[] = [
  { dir: 'content', name: '@plakboek/content' },
  { dir: 'db', name: '@plakboek/db' },
  { dir: 'permissions', name: '@plakboek/permissions' },
];
const DEFAULT_NAMES = DEFAULT_PACKAGES.map(({ name }) => name);

// Answers `npm view <name>@<version> version` from FAKE_NPM_PUBLISHED and
// `npm view <name> name` from FAKE_NPM_EXISTING; `npm publish` records the
// name inside the tarball it was handed.
const FAKE_NPM = `#!/bin/sh
echo "$*" >> "$FAKE_NPM_LOG"
case "$1" in
  view)
    if [ "$3" = "version" ]; then
      case ",$FAKE_NPM_PUBLISHED," in *",$2,"*) echo "\${2##*@}"; exit 0 ;; esac
      exit 1
    fi
    case ",$FAKE_NPM_EXISTING," in *",$2,"*) echo "$2"; exit 0 ;; esac
    exit 1
    ;;
  publish)
    packed=$(tar -xOzf "$2" package/package.json | sed -n 's/^{"name":"\\([^"]*\\)".*/\\1/p')
    echo "packed $2 $packed" >> "$FAKE_NPM_LOG"
    exit 0
    ;;
esac
exit 1
`;

// Handles `pnpm --dir <dir> pack --pack-destination <dest>` by tarring the
// package manifest the way a real pack would lay it out.
const FAKE_PNPM = `#!/bin/sh
echo "$*" >> "$FAKE_PNPM_LOG"
dir="$2"
dest="$5"
version=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$dir/package.json")
stage=$(mktemp -d)
mkdir "$stage/package"
cp "$dir/package.json" "$stage/package/package.json"
tar -czf "$dest/plakboek-$(basename "$dir")-$version.tgz" -C "$stage" package
rm -rf "$stage"
`;

function manifest(name: string, overrides: Partial<Manifest> = {}): Manifest {
  return {
    name,
    version: '0.1.1',
    repository: { url: REPOSITORY_URL },
    ...overrides,
  };
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'plakboek-release-test-'));
  const sandbox = {
    root,
    bin: join(root, 'bin'),
    repo: join(root, 'repo'),
    tmp: join(root, 'tmp'),
    npmLog: join(root, 'npm.log'),
    pnpmLog: join(root, 'pnpm.log'),
  };
  for (const dir of [sandbox.bin, sandbox.repo, sandbox.tmp]) {
    mkdirSync(dir);
  }
  writeFileSync(join(sandbox.bin, 'npm'), FAKE_NPM);
  writeFileSync(join(sandbox.bin, 'pnpm'), FAKE_PNPM);
  chmodSync(join(sandbox.bin, 'npm'), 0o755);
  chmodSync(join(sandbox.bin, 'pnpm'), 0o755);
  mkdirSync(join(sandbox.repo, '.changeset'));
  writeFileSync(
    join(sandbox.repo, '.changeset', 'config.json'),
    JSON.stringify({ fixed: [FIXED_GROUP] }),
  );
  return sandbox;
}

function writePackage(sandbox: Sandbox, spec: PackageSpec): void {
  const dir = join(sandbox.repo, 'packages', spec.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(manifest(spec.name, spec.overrides)),
  );
}

/**
 * Writes the default workspace, optionally overriding individual packages by
 * directory name. Anything not overridden keeps its default manifest.
 */
function writeWorkspace(
  sandbox: Sandbox,
  overridesByDir: Readonly<Record<string, Partial<Manifest>>> = {},
  extra: readonly PackageSpec[] = [],
): void {
  for (const spec of DEFAULT_PACKAGES) {
    writePackage(sandbox, {
      ...spec,
      overrides: { ...spec.overrides, ...overridesByDir[spec.dir] },
    });
  }
  for (const spec of extra) {
    writePackage(sandbox, spec);
  }
}

function run(sandbox: Sandbox, options: RunOptions = {}): RunResult {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...(options.args ?? [])],
    {
      cwd: sandbox.repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${sandbox.bin}:${process.env.PATH ?? ''}`,
        TMPDIR: sandbox.tmp,
        FAKE_NPM_LOG: sandbox.npmLog,
        FAKE_PNPM_LOG: sandbox.pnpmLog,
        FAKE_NPM_EXISTING: (options.existing ?? DEFAULT_NAMES).join(','),
        FAKE_NPM_PUBLISHED: (options.published ?? []).join(','),
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function logLines(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
    : [];
}

function packedPublishes(
  sandbox: Sandbox,
): { tarball: string; name: string }[] {
  return logLines(sandbox.npmLog)
    .filter((line) => line.startsWith('packed '))
    .map((line) => {
      const [, tarball = '', name = ''] = line.split(' ');
      return { tarball, name };
    });
}

function publishedNames(sandbox: Sandbox): string[] {
  return packedPublishes(sandbox).map(({ name }) => name);
}

function publishCalls(sandbox: Sandbox): string[] {
  return logLines(sandbox.npmLog).filter((line) => line.startsWith('publish '));
}

function leftoverReleaseDirs(sandbox: Sandbox): string[] {
  return readdirSync(sandbox.tmp).filter((name) =>
    name.startsWith('plakboek-release-'),
  );
}

describe('publish-unpublished.ts', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  describe('the publish list', () => {
    // Regression for the nine-day outage: the publish list used to BE the
    // Changesets fixed group, so `@plakboek/auth` -- versioned, non-private,
    // and simply not a member of that group -- was never even a candidate and
    // never reached npm. The list is now derived from the workspace.
    it('publishes a package that is outside the fixed group', () => {
      writeWorkspace(sandbox);

      const result = run(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'release: publish candidates=@plakboek/content,@plakboek/db,@plakboek/permissions',
      );
      expect(publishedNames(sandbox)).toEqual([
        '@plakboek/content',
        '@plakboek/db',
        '@plakboek/permissions',
      ]);
    });

    it('excludes a private package from the candidates', () => {
      writeWorkspace(sandbox, {}, [
        {
          dir: 'internal-tools',
          name: '@plakboek/internal-tools',
          overrides: { private: true },
        },
      ]);

      const result = run(sandbox, {
        existing: [...DEFAULT_NAMES, '@plakboek/internal-tools'],
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'release: publish candidates=@plakboek/content,@plakboek/db,@plakboek/permissions',
      );
      expect(result.stdout).not.toContain('@plakboek/internal-tools');
      expect(publishedNames(sandbox)).not.toContain('@plakboek/internal-tools');
    });
  });

  describe('fixed-group preflight', () => {
    it('exits non-zero naming both versions when the fixed group versions differ, without packing', () => {
      writeWorkspace(sandbox, { permissions: { version: '0.2.0' } });

      const result = run(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fixed group versions differ');
      expect(result.stderr).toContain('0.2.0');
      expect(result.stderr).toContain('0.1.1');
      expect(logLines(sandbox.pnpmLog)).toEqual([]);
      expect(publishCalls(sandbox)).toEqual([]);
    });

    it('exits non-zero when a fixed-group package has no directory under packages/', () => {
      writePackage(sandbox, {
        dir: 'permissions',
        name: '@plakboek/permissions',
      });
      writePackage(sandbox, { dir: 'content', name: '@plakboek/content' });

      const result = run(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'release: fixed-group package(s) with no directory under packages/: @plakboek/db',
      );
      expect(publishCalls(sandbox)).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('skips versions already on npm without packing or publishing', () => {
      writeWorkspace(sandbox);

      const result = run(sandbox, {
        published: DEFAULT_NAMES.map((name) => `${name}@0.1.1`),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'release: published= skipped=@plakboek/content,@plakboek/db,@plakboek/permissions bootstrap-required=',
      );
      expect(logLines(sandbox.pnpmLog)).toEqual([]);
      expect(publishCalls(sandbox)).toEqual([]);
    });

    it('reports a never-published package as bootstrap-required and publishes only the rest', () => {
      writeWorkspace(sandbox);

      const result = run(sandbox, {
        existing: ['@plakboek/content', '@plakboek/permissions'],
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        '::warning::@plakboek/db has never been published to npm',
      );
      expect(result.stdout).toContain(
        'release: published=@plakboek/content,@plakboek/permissions skipped= bootstrap-required=@plakboek/db',
      );
      expect(publishedNames(sandbox)).toEqual([
        '@plakboek/content',
        '@plakboek/permissions',
      ]);
    });
  });

  describe('tarball handling', () => {
    it('publishes each package from its own freshly packed tarball, ignoring stale tarballs, and leaves no temp directory behind', () => {
      writeWorkspace(sandbox);
      // A stale tarball that sorts after every freshly packed one; picking
      // tarballs from the shared temp dir would publish this in their place.
      const stage = join(sandbox.root, 'stale');
      mkdirSync(join(stage, 'package'), { recursive: true });
      writeFileSync(
        join(stage, 'package', 'package.json'),
        JSON.stringify(manifest('@plakboek/stale')),
      );
      execFileSync('tar', [
        '-czf',
        join(sandbox.tmp, 'zz-stale-9.9.9.tgz'),
        '-C',
        stage,
        'package',
      ]);

      const result = run(sandbox);

      expect(result.status).toBe(0);
      const publishes = packedPublishes(sandbox);
      expect(publishes.map(({ name }) => name)).toEqual([
        '@plakboek/content',
        '@plakboek/db',
        '@plakboek/permissions',
      ]);
      // One temp directory per package, and every one of them removed after.
      expect(
        new Set(publishes.map(({ tarball }) => dirname(tarball))).size,
      ).toBe(3);
      expect(leftoverReleaseDirs(sandbox)).toEqual([]);
      for (const call of publishCalls(sandbox)) {
        expect(call).toMatch(/ --access public --provenance$/);
      }
    });
  });

  describe('packed-manifest validation', () => {
    // Validation happens per package, inside the publish loop, so a rejection
    // aborts the run but leaves earlier packages published. These tests pin
    // that the offending package itself never reaches npm and that its temp
    // directory is still cleaned up. `@plakboek/permissions` sorts last, so
    // the packages before it are expected to have gone out already.
    it.each(['catalog:', 'workspace:*'])(
      "rejects a packed manifest with a '%s' specifier and does not publish it",
      (specifier) => {
        writeWorkspace(sandbox, {
          permissions: { dependencies: { '@plakboek/db': specifier } },
        });

        const result = run(sandbox);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          '@plakboek/permissions: packed manifest in',
        );
        expect(result.stderr).toContain(
          'still contains a catalog: or workspace: specifier',
        );
        expect(publishedNames(sandbox)).not.toContain('@plakboek/permissions');
        expect(leftoverReleaseDirs(sandbox)).toEqual([]);
      },
    );

    it('rejects a packed manifest with an unexpected repository.url and does not publish it', () => {
      writeWorkspace(sandbox, {
        permissions: {
          repository: { url: 'git+https://github.com/someone/else.git' },
        },
      });

      const result = run(sandbox);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "@plakboek/permissions: packed manifest repository.url is 'git+https://github.com/someone/else.git'",
      );
      expect(publishedNames(sandbox)).not.toContain('@plakboek/permissions');
      expect(leftoverReleaseDirs(sandbox)).toEqual([]);
    });
  });
});
