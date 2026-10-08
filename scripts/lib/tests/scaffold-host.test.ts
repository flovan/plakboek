import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Sandbox = {
  root: string;
  bin: string;
  work: string;
  site: string;
  npxLog: string;
  pnpmLog: string;
  sleepLog: string;
  counter: string;
};

type NpxMode = 'ok' | 'no-matching' | 'other';
type InstallOutcome = 'ok' | 'no-matching' | 'other';

type RunOptions = {
  npx: NpxMode;
  // Outcome of each `pnpm install` the library runs itself, in order.
  installs?: readonly InstallOutcome[];
  // Shell options the sourcing script has set, as verify-scaffold.sh does.
  shellOptions?: string;
};

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const LIB = fileURLToPath(new URL('../scaffold-host.sh', import.meta.url));

// Stands in for `npx --yes create-plakboek@<version> site ...`: creates the
// project directory, then ends the way the real CLI would.
const FAKE_NPX = `#!/bin/sh
echo "$*" >> "$FAKE_NPX_LOG"
mkdir -p site
echo '{}' > site/package.json
echo "CLI-OUTPUT creating site"
case "$FAKE_NPX_MODE" in
  ok) exit 0 ;;
  no-matching)
    echo "ERR_PNPM_NO_MATCHING_VERSION No matching version found for @plakboek/core@0.5.1" >&2
    echo "Installing dependencies failed. The project was created in site; run pnpm install there to retry." >&2
    exit 1
    ;;
  other)
    echo "ERR_PNPM_FETCH_500 GET https://registry.npmjs.org/@plakboek%2fcore: Internal Server Error" >&2
    exit 1
    ;;
esac
exit 99
`;

// Logs the directory and arguments of every call. \`install\` takes its
// outcome from the comma-separated FAKE_PNPM_INSTALLS list, one per call.
const FAKE_PNPM = `#!/bin/sh
echo "$PWD $*" >> "$FAKE_PNPM_LOG"
case "$1" in
  install)
    n=$(cat "$FAKE_PNPM_COUNTER" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$FAKE_PNPM_COUNTER"
    outcome=$(echo "$FAKE_PNPM_INSTALLS" | cut -d, -f"$n")
    case "$outcome" in
      ok) exit 0 ;;
      no-matching)
        echo "ERR_PNPM_NO_MATCHING_VERSION No matching version found for @plakboek/db@0.5.1" >&2
        exit 1
        ;;
      other)
        echo "ERR_PNPM_FETCH_500 Internal Server Error" >&2
        exit 1
        ;;
    esac
    echo "unexpected pnpm install call $n" >&2
    exit 99
    ;;
esac
exit 0
`;

const FAKE_SLEEP = `#!/bin/sh
echo "$1" >> "$FAKE_SLEEP_LOG"
`;

function createSandbox(): Sandbox {
  // The real path, so a directory the fakes log through $PWD matches.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plakboek-scaffold-')));
  const sandbox: Sandbox = {
    root,
    bin: join(root, 'bin'),
    work: join(root, 'work'),
    site: join(root, 'work', 'site'),
    npxLog: join(root, 'npx.log'),
    pnpmLog: join(root, 'pnpm.log'),
    sleepLog: join(root, 'sleep.log'),
    counter: join(root, 'pnpm.counter'),
  };
  mkdirSync(sandbox.bin);
  mkdirSync(sandbox.work);
  for (const [name, script] of [
    ['npx', FAKE_NPX],
    ['pnpm', FAKE_PNPM],
    ['sleep', FAKE_SLEEP],
  ] as const) {
    writeFileSync(join(sandbox.bin, name), script);
    chmodSync(join(sandbox.bin, name), 0o755);
  }
  return sandbox;
}

function run(sandbox: Sandbox, options: RunOptions): RunResult {
  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        '$SHELL_OPTIONS',
        'source "$LIB"',
        'scaffold_host "$WORK" --registry 0.5.1',
        'rc=$?',
        'echo "SITE=$SCAFFOLD_SITE_DIR"',
        'exit "$rc"',
      ].join('\n'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${sandbox.bin}:${process.env.PATH ?? ''}`,
        LIB,
        WORK: sandbox.work,
        SHELL_OPTIONS: options.shellOptions ?? '',
        FAKE_NPX_LOG: sandbox.npxLog,
        FAKE_NPX_MODE: options.npx,
        FAKE_PNPM_LOG: sandbox.pnpmLog,
        FAKE_PNPM_COUNTER: sandbox.counter,
        FAKE_PNPM_INSTALLS: (options.installs ?? []).join(','),
        FAKE_SLEEP_LOG: sandbox.sleepLog,
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

describe('scaffold_host --registry', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('returns after the CLI succeeds, without sleeping or calling pnpm itself', () => {
    const result = run(sandbox, { npx: 'ok' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`SITE=${sandbox.site}`);
    expect(result.stdout).toContain('CLI-OUTPUT creating site');
    expect(logLines(sandbox.npxLog)).toEqual([
      '--yes create-plakboek@0.5.1 site --yes --site-name Scaffold Proof --locale en --locales nl',
    ]);
    expect(logLines(sandbox.sleepLog)).toEqual([]);
    expect(logLines(sandbox.pnpmLog)).toEqual([]);
  });

  it('retries a missing version after 2 then 3 minutes, then formats like the CLI', () => {
    const result = run(sandbox, {
      npx: 'no-matching',
      installs: ['no-matching', 'ok'],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`SITE=${sandbox.site}`);
    expect(logLines(sandbox.sleepLog)).toEqual(['120', '180']);
    expect(logLines(sandbox.pnpmLog)).toEqual([
      `${sandbox.site} cache delete @plakboek/*`,
      `${sandbox.site} install --no-frozen-lockfile`,
      `${sandbox.site} cache delete @plakboek/*`,
      `${sandbox.site} install --no-frozen-lockfile`,
      `${sandbox.site} run format`,
    ]);
    // Neither a cache-only nor an offline install: a retry must reach the
    // registry to see a version that has just propagated.
    for (const line of logLines(sandbox.pnpmLog)) {
      expect(line).not.toContain('offline');
    }
    // The install log stays out of the site, where lint and format run later.
    expect(existsSync(join(sandbox.site, 'create-plakboek.log'))).toBe(false);
  });

  it('fails at once on any other CLI error', () => {
    const result = run(sandbox, { npx: 'other' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FATAL:');
    expect(logLines(sandbox.sleepLog)).toEqual([]);
    expect(logLines(sandbox.pnpmLog)).toEqual([]);
  });

  it('stops after a retried install fails with a different error', () => {
    const result = run(sandbox, { npx: 'no-matching', installs: ['other'] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FATAL:');
    expect(logLines(sandbox.sleepLog)).toEqual(['120']);
    expect(logLines(sandbox.pnpmLog)).toEqual([
      `${sandbox.site} cache delete @plakboek/*`,
      `${sandbox.site} install --no-frozen-lockfile`,
    ]);
  });

  it('gives up after four retries over fourteen minutes when the version never appears', () => {
    const result = run(sandbox, {
      npx: 'no-matching',
      installs: ['no-matching', 'no-matching', 'no-matching', 'no-matching'],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FATAL:');
    expect(result.stderr).toContain('after 4 retries over 14 minutes');
    expect(logLines(sandbox.sleepLog)).toEqual(['120', '180', '240', '300']);
    const calls = logLines(sandbox.pnpmLog);
    expect(calls.filter((line) => line.includes(' install '))).toHaveLength(4);
    expect(calls.some((line) => line.endsWith(' run format'))).toBe(false);
  });

  describe.each([
    ['no options', ''],
    ['errexit', 'set -eu'],
    ['errexit and pipefail', 'set -euo pipefail'],
  ])('with a caller using %s', (_label, shellOptions) => {
    it('still sees a failing CLI as a failure', () => {
      const result = run(sandbox, { npx: 'other', shellOptions });

      expect(result.status).not.toBe(0);
      expect(logLines(sandbox.sleepLog)).toEqual([]);
    });

    it('still reaches the retry path instead of aborting on the CLI failure', () => {
      const result = run(sandbox, {
        npx: 'no-matching',
        installs: ['ok'],
        shellOptions,
      });

      expect(result.status).toBe(0);
      expect(logLines(sandbox.sleepLog)).toEqual(['120']);
      expect(logLines(sandbox.pnpmLog)).toEqual([
        `${sandbox.site} cache delete @plakboek/*`,
        `${sandbox.site} install --no-frozen-lockfile`,
        `${sandbox.site} run format`,
      ]);
    });
  });
});
