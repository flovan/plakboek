import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../src/run.js';
import type { Spawner, SpawnResult } from '../../src/spawn.js';

const TEMPLATE = join(import.meta.dirname, '..', 'fixtures', 'template');

type Capture = { stream: Writable & { isTTY?: boolean }; text: () => string };

function capture(isTTY = false): Capture {
  const chunks: string[] = [];
  const stream: Writable & { isTTY?: boolean } = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  stream.isTTY = isTTY;
  return { stream, text: () => chunks.join('') };
}

type SpawnCall = {
  command: string;
  args: string[];
  cwd: string | undefined;
  stdio: string;
};

function fakeSpawner(
  behave: (
    command: string,
    args: string[],
  ) => Partial<SpawnResult> = () => ({}),
): { spawn: Spawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: Spawner = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
    return Promise.resolve({
      status: 0,
      notFound: false,
      ...behave(command, args),
    });
  };
  return { spawn, calls };
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'create-plakboek-run-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

type Harness = {
  options: RunOptions;
  out: Capture;
  err: Capture;
  calls: SpawnCall[];
  stdin: PassThrough & { isTTY?: boolean };
};

function harness(
  argv: string[],
  overrides: {
    tty?: boolean;
    stdoutTTY?: boolean;
    env?: Record<string, string | undefined>;
    nodeVersion?: string;
    behave?: Parameters<typeof fakeSpawner>[0];
  } = {},
): Harness {
  const out = capture(overrides.stdoutTTY ?? false);
  const err = capture();
  const stdin: PassThrough & { isTTY?: boolean } = new PassThrough();
  stdin.isTTY = overrides.tty ?? false;
  const { spawn, calls } = fakeSpawner(overrides.behave);
  return {
    out,
    err,
    calls,
    stdin,
    options: {
      argv,
      stdin,
      stdout: out.stream,
      stderr: err.stream,
      env: overrides.env ?? {},
      cwd,
      nodeVersion: overrides.nodeVersion ?? '24.15.0',
      spawn,
      templateDir: TEMPLATE,
      version: '1.2.3',
    },
  };
}

describe('help, version and usage', () => {
  it('prints the version and exits 0', async () => {
    const h = harness(['--version']);
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).toBe('1.2.3\n');
  });

  it('prints usage for --help and exits 0', async () => {
    const h = harness(['--help']);
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).toContain('Usage: create-plakboek [dir] [options]');
    expect(h.out.text()).toContain('--skip-install');
  });

  it('exits 2 with a usage line for an unknown flag', async () => {
    const h = harness(['--nope']);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toContain('Error: ');
    expect(h.err.text()).toContain('Usage: create-plakboek [dir] [options]');
  });
});

describe('Node version', () => {
  it('refuses Node older than 22.22', async () => {
    const h = harness(['--yes'], { nodeVersion: '22.21.0' });
    expect(await run(h.options)).toBe(1);
    expect(h.err.text()).toBe(
      'Error: Plakboek requires Node.js 22.22 or later (found 22.21.0).\n',
    );
    expect(await readdir(cwd)).toEqual([]);
  });

  it('accepts 22.22.0 and a later major', async () => {
    for (const nodeVersion of ['22.22.0', 'v24.1.0']) {
      const h = harness(['--version'], { nodeVersion });
      expect(await run(h.options)).toBe(0);
    }
  });
});

describe('non-interactive input', () => {
  it('requires --dir when nothing is interactive, writing nothing', async () => {
    const h = harness([]);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toBe(
      'Error: --dir is required when input is not interactive.\n',
    );
    expect(await readdir(cwd)).toEqual([]);
  });

  it('requires every other missing value too', async () => {
    const h = harness(['--dir', 'site']);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toBe(
      'Error: --site-name is required when input is not interactive.\n',
    );
  });

  it('exits 2 with the locale copy for an invalid --locale', async () => {
    const h = harness(['--yes', '--dir', 'site', '--locale', 'English']);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toBe(
      'Error: "English" is not a valid locale. Use a language tag such as en or nl.\n',
    );
    expect(existsSync(join(cwd, 'site'))).toBe(false);
  });

  it('names the first bad value of --locales', async () => {
    const h = harness(['--yes', '--dir', 'site', '--locales', 'nl,x1']);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toContain('"x1" is not a valid locale');
  });

  it('refuses an invalid --timezone', async () => {
    const h = harness(['--yes', '--timezone', 'Mars/Olympus']);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toContain('"Mars/Olympus" is not a valid time zone');
  });

  it('refuses a directory that is not empty and never overwrites', async () => {
    await mkdir(join(cwd, 'site'));
    await writeFile(join(cwd, 'site', 'package.json'), 'mine');
    const h = harness(['--yes', '--dir', 'site']);
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toBe(
      'Error: "site" is not empty. Choose another directory or empty this one.\n',
    );
    expect(await readFile(join(cwd, 'site', 'package.json'), 'utf8')).toBe(
      'mine',
    );
  });
});

describe('--yes', () => {
  it('scaffolds the defaults into my-plakboek-site', async () => {
    const h = harness([
      '--yes',
      '--skip-install',
      '--timezone',
      'Europe/Brussels',
    ]);
    expect(await run(h.options)).toBe(0);
    const target = join(cwd, 'my-plakboek-site');
    const config = await readFile(join(target, 'plakboek.config.ts'), 'utf8');
    expect(config).toContain('name: "My Plakboek Site",');
    expect(config).toContain('defaultLocale: "en",');
    expect(config).toContain('locales: ["en","nl"],');
    expect(config).toContain('timezone: "Europe/Brussels",');
    const manifest = JSON.parse(
      await readFile(join(target, 'package.json'), 'utf8'),
    );
    expect(manifest.name).toBe('my-plakboek-site');
    expect(manifest.dependencies['@plakboek/core']).toBe('1.2.3');
    expect(existsSync(join(target, '.gitignore'))).toBe(true);
  });

  it('takes the positional directory and flags as given', async () => {
    const h = harness([
      'acme',
      '--yes',
      '--skip-install',
      '--site-name',
      'Acme "Q"',
      '--locale',
      'nl',
      '--locales',
      '',
    ]);
    expect(await run(h.options)).toBe(0);
    const config = await readFile(
      join(cwd, 'acme', 'plakboek.config.ts'),
      'utf8',
    );
    expect(config).toContain('name: "Acme \\"Q\\"",');
    expect(config).toContain('locales: ["nl"],');
  });
});

describe('interactive prompts', () => {
  it('re-prompts after an invalid site name and takes blank answers as defaults', async () => {
    const h = harness(['--dir', 'proj', '--skip-install'], { tty: true });
    h.stdin.write(`${'x'.repeat(201)}\nAcme\n\n\n`);
    expect(await run(h.options)).toBe(0);
    expect(h.err.text()).toContain('Enter a site name of 1 to 200 characters.');
    expect(h.out.text()).toContain('Site name (Proj): ');
    expect(h.out.text()).toContain('Default locale (en): ');
    expect(h.out.text()).toContain(
      'Additional locales (comma-separated, blank for none): ',
    );
    const config = await readFile(
      join(cwd, 'proj', 'plakboek.config.ts'),
      'utf8',
    );
    expect(config).toContain('name: "Acme",');
    // A blank additional-locales answer means none.
    expect(config).toContain('locales: ["en"],');
  });

  it('prompts for everything and re-prompts for a directory that is not empty', async () => {
    await mkdir(join(cwd, 'taken'));
    await writeFile(join(cwd, 'taken', 'a.txt'), 'x');
    const h = harness(['--skip-install'], { tty: true });
    h.stdin.write('taken\nfresh\nFresh Co\nnl\nde, en\n');
    expect(await run(h.options)).toBe(0);
    expect(h.err.text()).toContain(
      '"taken" is not empty. Choose another directory or empty this one.',
    );
    const config = await readFile(
      join(cwd, 'fresh', 'plakboek.config.ts'),
      'utf8',
    );
    expect(config).toContain('defaultLocale: "nl",');
    expect(config).toContain('locales: ["nl","de","en"],');
  });

  it('prompts only for what the flags leave open', async () => {
    const h = harness(
      ['--dir', 'proj', '--site-name', 'Flagged', '--skip-install'],
      {
        tty: true,
      },
    );
    h.stdin.write('fr\n\n');
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).not.toContain('Site name (');
    expect(h.out.text()).toContain('Default locale (en): ');
    const config = await readFile(
      join(cwd, 'proj', 'plakboek.config.ts'),
      'utf8',
    );
    expect(config).toContain('defaultLocale: "fr",');
  });

  it('exits 2 when the input ends before every answer', async () => {
    const h = harness(['--dir', 'proj'], { tty: true });
    h.stdin.end();
    expect(await run(h.options)).toBe(2);
    expect(h.err.text()).toContain(
      'Input ended before every question was answered.',
    );
    expect(existsSync(join(cwd, 'proj'))).toBe(false);
  });
});

describe('side effects', () => {
  it('stops before writing anything when pnpm is missing', async () => {
    const h = harness(['--yes', '--dir', 'site'], {
      behave: (command) =>
        command === 'pnpm' ? { status: null, notFound: true } : {},
    });
    expect(await run(h.options)).toBe(1);
    expect(h.err.text()).toBe(
      'Error: pnpm was not found. Install it from https://pnpm.io/installation and run this command again.\n',
    );
    expect(existsSync(join(cwd, 'site'))).toBe(false);
  });

  it('keeps the directory when the install fails', async () => {
    const h = harness(['--yes', '--dir', 'site'], {
      behave: (command, args) =>
        command === 'pnpm' && args[0] === 'install' ? { status: 1 } : {},
    });
    expect(await run(h.options)).toBe(1);
    expect(h.err.text()).toBe(
      'Error: Installing dependencies failed. The project was created in site; run pnpm install there to retry.\n',
    );
    expect(existsSync(join(cwd, 'site', 'package.json'))).toBe(true);
    expect(h.out.text()).not.toContain('Done.');
  });

  it('skips git init with a note when git is missing and carries on', async () => {
    const h = harness(['--yes', '--dir', 'site'], {
      behave: (command) =>
        command === 'git' ? { status: null, notFound: true } : {},
    });
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).toContain('Skipped git init (git was not found)\n');
    expect(h.out.text()).not.toContain('Initialised a git repository');
    expect(h.out.text()).toContain('Done. ');
  });

  it('runs git init, install and format in the project with argument arrays', async () => {
    const h = harness(['--yes', '--dir', 'my dir; rm -rf x']);
    expect(await run(h.options)).toBe(0);
    const target = join(cwd, 'my dir; rm -rf x');
    expect(h.calls).toEqual([
      { command: 'pnpm', args: ['--version'], cwd: undefined, stdio: 'ignore' },
      {
        command: 'git',
        args: ['init', '--quiet'],
        cwd: target,
        stdio: 'ignore',
      },
      { command: 'pnpm', args: ['install'], cwd: target, stdio: 'inherit' },
      {
        command: 'pnpm',
        args: ['run', 'format'],
        cwd: target,
        stdio: 'ignore',
      },
    ]);
  });

  it('only warns when the format step fails', async () => {
    const h = harness(['--yes', '--dir', 'site'], {
      behave: (_command, args) => (args[0] === 'run' ? { status: 1 } : {}),
    });
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).toContain('Warning: pnpm run format did not finish');
    expect(h.out.text()).toContain('Done. ');
  });

  it('does not touch pnpm at all with --skip-install', async () => {
    const h = harness(['--yes', '--dir', 'site', '--skip-install']);
    expect(await run(h.options)).toBe(0);
    expect(h.calls.map((call) => call.command)).toEqual(['git']);
  });
});

describe('success output', () => {
  it('prints the S3 sequence in order', async () => {
    const h = harness(['--yes', '--dir', 'site', '--site-name', 'Acme']);
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).toBe(
      [
        'Created site from the Plakboek starter (4 files)',
        'Initialised a git repository',
        'Installing dependencies with pnpm',
        'Done. Acme is ready.',
        '',
        'Next steps:',
        '  cd site',
        '  cp .env.example .env',
        '  pnpm --silent secret >> .env',
        '  docker compose up -d postgres',
        '  pnpm plakboek migrate',
        '  pnpm dev',
        '',
        'Then open the URL that pnpm dev prints, followed by /cms/setup, to create the',
        'first superadmin. To do it from the terminal instead:',
        '  pnpm plakboek bootstrap --name "Your Name" --email you@example.com',
        '',
      ].join('\n'),
    );
  });

  it('omits the install line and adds pnpm install with --skip-install', async () => {
    const h = harness(['--yes', '--dir', 'site', '--skip-install']);
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).not.toContain('Installing dependencies');
    expect(h.out.text()).toContain(
      '  cd site\n  pnpm install\n  cp .env.example .env\n',
    );
  });

  it('quotes a directory with spaces in the cd line', async () => {
    const h = harness(['--yes', '--dir', 'my site', '--skip-install']);
    expect(await run(h.options)).toBe(0);
    expect(h.out.text()).toContain('  cd "my site"\n');
  });

  it('uses colour only on a TTY without NO_COLOR', async () => {
    const colored = harness(['--yes', '--dir', 'a', '--skip-install'], {
      stdoutTTY: true,
    });
    await run(colored.options);
    expect(colored.out.text()).toContain('\u001b[');

    const plainTTY = harness(['--yes', '--dir', 'b', '--skip-install'], {
      stdoutTTY: true,
      env: { NO_COLOR: '1' },
    });
    await run(plainTTY.options);
    expect(plainTTY.out.text()).not.toContain('\u001b[');

    const piped = harness(['--yes', '--dir', 'c', '--skip-install']);
    await run(piped.options);
    expect(piped.out.text()).not.toContain('\u001b[');
  });
});
