import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the bin that npm linked from the packed tarball, directly, so the
// shebang and the executable bit are exercised too.
const failures: string[] = [];

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

const consumerDir = import.meta.dirname;
const bin = join(consumerDir, 'node_modules', '.bin', 'create-plakboek');
const packed = JSON.parse(
  readFileSync(
    join(consumerDir, 'node_modules', 'create-plakboek', 'package.json'),
    'utf8',
  ),
) as { version: string; dependencies?: Record<string, string> };

expectEqual('no runtime dependencies', packed.dependencies === undefined, true);

const version = execFileSync(bin, ['--version'], { encoding: 'utf8' });
expectEqual(
  '--version prints the packed version',
  version,
  `${packed.version}\n`,
);

const help = spawnSync(bin, ['--help'], { encoding: 'utf8' });
expectEqual('--help exits 0', help.status, 0);
expectEqual(
  '--help prints the usage line',
  help.stdout.includes('Usage: create-plakboek [dir] [options]'),
  true,
);

const unknown = spawnSync(bin, ['--definitely-not-a-flag'], {
  encoding: 'utf8',
});
expectEqual('an unknown flag exits 2', unknown.status, 2);

// Scaffold into a scratch directory: the bundled template must ship in the
// tarball, pin the CMS packages to this exact version and leave no
// placeholder behind.
const scratch = mkdtempSync(join(tmpdir(), 'create-plakboek-probe-'));
try {
  const target = join(scratch, 'site');
  const scaffold = spawnSync(
    bin,
    ['--yes', '--skip-install', '--dir', target],
    { encoding: 'utf8' },
  );
  expectEqual('scaffolding exits 0', scaffold.status, 0);

  const generated = JSON.parse(
    readFileSync(join(target, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  expectEqual(
    '@plakboek/core is pinned to the packed version',
    generated.dependencies?.['@plakboek/core'],
    packed.version,
  );
  expectEqual(
    '@plakboek/render is pinned to the packed version',
    generated.dependencies?.['@plakboek/render'],
    packed.version,
  );
  expectEqual(
    'the packed starter stores .gitignore',
    existsSync(join(target, '.gitignore')),
    true,
  );
  expectEqual(
    'the starter ships no _gitignore',
    existsSync(join(target, '_gitignore')),
    false,
  );
  for (const file of ['plakboek.config.ts', 'package.json']) {
    const left = readFileSync(join(target, file), 'utf8').match(/__[A-Z_]+__/g);
    expectEqual(`${file} has no placeholder left`, left, null);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `create-plakboek.ts: the packed bin runs and scaffolds (${packed.version}, --help, --version and the starter)`,
);
