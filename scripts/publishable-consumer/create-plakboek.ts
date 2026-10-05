import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `create-plakboek.ts: the packed bin runs (${packed.version}, --help and --version)`,
);
