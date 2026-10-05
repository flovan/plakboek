import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const BIN = join(PACKAGE_ROOT, 'dist', 'index.js');
const TEMPLATE = join(PACKAGE_ROOT, 'tests', 'fixtures', 'template');
const VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

let work: string;

beforeAll(() => {
  if (!existsSync(BIN)) {
    execFileSync('pnpm', ['run', 'build'], {
      cwd: PACKAGE_ROOT,
      stdio: 'ignore',
    });
  }
});

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'create-plakboek-cli-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function bin(args: string[]) {
  return run(process.execPath, [BIN, ...args], {
    cwd: work,
    env: {
      ...process.env,
      CREATE_PLAKBOEK_TEMPLATE_DIR: TEMPLATE,
      NO_COLOR: '1',
    },
  });
}

describe('the built bin', () => {
  it('prints its version', async () => {
    const { stdout } = await bin(['--version']);
    expect(stdout).toBe(`${VERSION}\n`);
  });

  it('scaffolds non-interactively with --yes --skip-install', async () => {
    const target = join(work, 'site');
    const { stdout } = await bin(['--yes', '--skip-install', '--dir', target]);
    expect(stdout).toContain(
      `Created ${target} from the Plakboek starter (4 files)`,
    );
    expect(stdout).toContain('Done. Site is ready.');
    expect(stdout.indexOf('pnpm --silent secret >> .env')).toBeGreaterThan(-1);
    expect(stdout.indexOf('pnpm --silent secret >> .env')).toBeLessThan(
      stdout.indexOf('pnpm plakboek migrate'),
    );
    const manifest = JSON.parse(
      await readFile(join(target, 'package.json'), 'utf8'),
    );
    expect(manifest.dependencies['@plakboek/core']).toBe(VERSION);
    expect(existsSync(join(target, '.gitignore'))).toBe(true);
  });

  it('exits 2 without a directory when stdin is not a terminal', async () => {
    await expect(bin([])).rejects.toMatchObject({
      code: 2,
      stderr: 'Error: --dir is required when input is not interactive.\n',
    });
  });
});
