import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The deploy files of the bundled starter, read from disk as they are shipped.
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');

const read = (path: string): Promise<string> =>
  readFile(join(TEMPLATE, path), 'utf8');

const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;

/**
 * Every `run:` script of a workflow, inline or block. A block script is the
 * run of lines indented deeper than the `run:` key itself.
 */
function runScripts(text: string): string[] {
  const lines = text.split('\n');
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[index] ?? '');
    if (match === null) continue;
    const keyIndent = (match[1] ?? '').length + (match[2] ?? '').length;
    const value = match[3] ?? '';
    if (/^[|>][+-]?\d*$/.test(value)) {
      const body: string[] = [];
      let next = index + 1;
      while (next < lines.length) {
        const line = lines[next] ?? '';
        if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
        body.push(line);
        next += 1;
      }
      scripts.push(body.join('\n'));
    } else {
      scripts.push(value);
    }
  }
  return scripts;
}

/** The lines of each job under `jobs:`, keyed by job id. */
function jobs(text: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      current = [];
      found.set(header[1], current);
    } else {
      current?.push(line);
    }
  }
  return new Map([...found].map(([id, body]) => [id, body.join('\n')]));
}

/** The steps of one job body, each as its own text block. */
function stepsOf(jobBody: string): string[] {
  const lines = jobBody.split('\n');
  const start = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const steps: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  return steps.map((step) => step.join('\n'));
}

/** The top-level key names of a workflow file. */
function topLevelKeys(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^([A-Za-z_-]+):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

/** The lines between a top-level key and the next one. */
function topLevelBlock(text: string, key: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  expect(start).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('run script extraction helper', () => {
  it('reads inline and block scripts and stops at the next key', () => {
    const text = [
      'steps:',
      '  - run: echo one',
      '  - name: two',
      '    run: |',
      '      echo two',
      '      echo three',
      '    env:',
      '      X: ${{ secrets.X }}',
    ].join('\n');
    expect(runScripts(text)).toEqual([
      'echo one',
      '      echo two\n      echo three',
    ]);
  });
});

describe('deploy workflow', () => {
  it('runs only on a push to main', async () => {
    const text = await read('.github/workflows/deploy.yml');
    expect(text).toMatch(/^on:\s*$/m);
    const on = topLevelBlock(text, 'on');
    const triggers = on
      .split('\n')
      .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
      .filter((trigger): trigger is string => trigger !== undefined);
    expect(triggers).toEqual(['push']);
    expect(on).toMatch(/branches:\s*\[\s*main\s*\]/);
    expect(text).not.toContain('pull_request_target');
  });

  it('grants no permission at the top level', async () => {
    const text = await read('.github/workflows/deploy.yml');
    expect(text).toMatch(/^permissions:\s*\{\}\s*$/m);
  });

  it('chains the host CI, the image build and the deploy', async () => {
    const text = await read('.github/workflows/deploy.yml');
    const all = jobs(text);
    expect([...all.keys()]).toEqual(['ci', 'image', 'deploy']);

    const ci = all.get('ci') ?? '';
    expect(ci).toMatch(/uses:\s*\.\/\.github\/workflows\/ci\.yml/);

    const image = all.get('image') ?? '';
    expect(image).toMatch(/needs:\s*\[?\s*ci\s*\]?\s*$/m);
    expect(image).toMatch(/packages:\s*write/);
    expect(image).toContain('docker/setup-buildx-action@');
    expect(image).toContain('docker/login-action@');
    expect(image).toContain('docker/metadata-action@');
    expect(image).toContain('docker/build-push-action@');
    expect(image).toContain('GIT_SHA');

    const deploy = all.get('deploy') ?? '';
    expect(deploy).toMatch(/needs:\s*\[?\s*image\s*\]?\s*$/m);
    expect(deploy).toMatch(/scripts\/deploy\.sh/);
  });

  it('puts the production environment and the key on the deploy job only', async () => {
    const text = await read('.github/workflows/deploy.yml');
    const all = jobs(text);
    const deploy = all.get('deploy') ?? '';
    expect(deploy).toMatch(/environment:\s*production\s*$/m);
    for (const id of ['ci', 'image']) {
      const body = all.get(id) ?? '';
      expect(body).not.toContain('environment:');
      expect(body).not.toContain('DEPLOY_SSH_KEY');
      expect(body).not.toContain('DEPLOY_KNOWN_HOSTS');
    }
    expect(text.match(/environment:/g)).toHaveLength(1);
    expect(text.match(/secrets\.DEPLOY_SSH_KEY/g)).toHaveLength(1);
  });

  it('queues whole runs in one non-cancelling group declared at the workflow level', async () => {
    const text = await read('.github/workflows/deploy.yml');
    expect(topLevelKeys(text)).toContain('concurrency');
    const block = topLevelBlock(text, 'concurrency');
    expect(block).toMatch(/^\s+group:\s*production-deploy\s*$/m);
    expect(block).toMatch(/^\s+cancel-in-progress:\s*false\s*$/m);
    // A job-level group with the same name would deadlock the run on itself.
    for (const body of jobs(text).values()) {
      expect(body).not.toMatch(/^\s+concurrency:/m);
    }
  });

  it('reads the tip of main first and gates every later deploy step on it', async () => {
    const deploy = jobs(await read('.github/workflows/deploy.yml')).get(
      'deploy',
    );
    const steps = stepsOf(deploy ?? '');
    expect(steps.length).toBeGreaterThanOrEqual(4);
    const [tip, ...later] = steps as [string, ...string[]];
    expect(tip).toMatch(/^\s+id:\s*tip\s*$/m);
    expect(tip).toMatch(/^\s+shell:\s*bash\s*$/m);
    expect(tip).toMatch(/^\s+GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}\s*$/m);
    expect(tip).not.toContain('secrets.');
    expect(tip).toContain('git/ref/heads/main');
    for (const step of later) {
      expect(step.match(/^\s+if:.*$/gm)).toEqual([
        expect.stringMatching(
          /^\s+if: steps\.tip\.outputs\.current == 'true'$/,
        ),
      ]);
    }
    expect(later.some((step) => step.includes('DEPLOY_SSH_KEY'))).toBe(true);
    expect(later.some((step) => step.includes('scripts/deploy.sh'))).toBe(true);
    expect(later.some((step) => step.includes('actions/checkout@'))).toBe(true);
  });

  it('never puts an expression inside a run script', async () => {
    for (const file of [
      '.github/workflows/deploy.yml',
      '.github/workflows/ci.yml',
    ]) {
      const scripts = runScripts(await read(file));
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(script).not.toContain('${{');
    }
  });

  it('logs in to the registry as the repository owner, never the actor', async () => {
    const text = await read('.github/workflows/deploy.yml');
    const all = jobs(text);
    const owner = '${{ github.repository_owner }}';
    expect(all.get('image') ?? '').toMatch(
      new RegExp(`^\\s+username: ${owner.replace(/[{}$]/g, '\\$&')}\\s*$`, 'm'),
    );
    expect(all.get('deploy') ?? '').toMatch(
      new RegExp(
        `^\\s+REGISTRY_USER: ${owner.replace(/[{}$]/g, '\\$&')}\\s*$`,
        'm',
      ),
    );
    expect(text).not.toContain('github.actor');
  });

  it('passes every deploy value through env', async () => {
    const text = await read('.github/workflows/deploy.yml');
    for (const name of [
      'DEPLOY_HOST',
      'DEPLOY_PORT',
      'DEPLOY_USER',
      'DEPLOY_PATH',
      'PLAKBOEK_IMAGE',
      'REGISTRY_HOST',
      'REGISTRY_USER',
      'REGISTRY_TOKEN',
      'SSH_KEY_FILE',
      'KNOWN_HOSTS_FILE',
    ]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}:`, 'm'));
    }
    expect(text).toMatch(/vars\.DEPLOY_HOST/);
  });
});

describe('deploy workflow tip guard script', () => {
  const SHA = 'a'.repeat(40);
  const NEWER = 'b'.repeat(40);
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tip-guard-'));
    await mkdir(join(root, 'bin'));
    await writeFile(
      join(root, 'bin', 'gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ -n "\${FAKE_GH_FAIL:-}" ]; then exit 1; fi
printf '%s\\n' "$FAKE_TIP"
`,
    );
    await chmod(join(root, 'bin', 'gh'), 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function runTip(extra: Record<string, string>) {
    const deploy = jobs(await read('.github/workflows/deploy.yml')).get(
      'deploy',
    );
    const tip = stepsOf(deploy ?? '')[0] ?? '';
    const script = runScripts(tip)[0] ?? '';
    expect(script).not.toBe('');
    const file = join(root, 'tip.sh');
    const output = join(root, 'output');
    await writeFile(file, script);
    await writeFile(output, '');
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', file],
      {
        env: {
          PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
          HOME: root,
          GITHUB_SHA: SHA,
          GITHUB_REPOSITORY: 'acme/site',
          GITHUB_OUTPUT: output,
          FAKE_GH_LOG: join(root, 'gh.log'),
          ...extra,
        },
        encoding: 'utf8',
      },
    );
    return {
      code: result.status,
      stdout: result.stdout,
      output: await readFile(output, 'utf8'),
      ghLog: await readFile(join(root, 'gh.log'), 'utf8').catch(() => ''),
    };
  }

  it('marks the run current when its commit is the tip', async () => {
    const result = await runTip({ FAKE_TIP: SHA });
    expect(result.code).toBe(0);
    expect(result.output).toContain('current=true');
    expect(result.ghLog.trim()).toBe(
      'api repos/acme/site/git/ref/heads/main --jq .object.sha',
    );
  });

  it('ends green with a notice naming both commits when a newer commit is the tip', async () => {
    const result = await runTip({ FAKE_TIP: NEWER });
    expect(result.code).toBe(0);
    expect(result.output).toContain('current=false');
    expect(result.output).not.toContain('current=true');
    const notice = result.stdout
      .split('\n')
      .find((line) => line.startsWith('::notice::'));
    expect(notice).toContain(SHA);
    expect(notice).toContain(NEWER);
  });

  it('fails without deploying when the lookup fails', async () => {
    const result = await runTip({ FAKE_TIP: SHA, FAKE_GH_FAIL: '1' });
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('current=true');
  });

  it('fails without deploying when the lookup is not a commit id', async () => {
    const result = await runTip({ FAKE_TIP: 'not-a-sha' });
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('current=true');
  });
});

describe('host CI workflow', () => {
  it('runs on pushes, pull requests and as a reusable workflow', async () => {
    const text = await read('.github/workflows/ci.yml');
    expect(topLevelKeys(text)).toContain('on');
    const on = topLevelBlock(text, 'on');
    for (const trigger of ['push', 'pull_request', 'workflow_call']) {
      expect(on).toMatch(new RegExp(`^ {2}${trigger}:`, 'm'));
    }
    expect(text).not.toContain('pull_request_target');
    expect(text).toMatch(/^permissions:\s*$/m);
    expect(topLevelBlock(text, 'permissions')).toMatch(/contents:\s*read/);
  });

  it('has one quality job that checks out without credentials', async () => {
    const all = jobs(await read('.github/workflows/ci.yml'));
    expect([...all.keys()]).toEqual(['quality']);
    const quality = all.get('quality') ?? '';
    expect(quality).toMatch(/persist-credentials:\s*false/);
    for (const step of [
      'pnpm install --frozen-lockfile',
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run format:check',
      'pnpm run build',
    ]) {
      expect(quality).toContain(step);
    }
  });
});

describe('deploy script', () => {
  it('fails fast and requires every input', async () => {
    const text = await read('scripts/deploy.sh');
    expect(text).toContain('set -euo pipefail');
    for (const name of [
      'DEPLOY_HOST',
      'DEPLOY_USER',
      'DEPLOY_PATH',
      'PLAKBOEK_IMAGE',
      'SSH_KEY_FILE',
      'KNOWN_HOSTS_FILE',
    ]) {
      expect(text).toContain(`\${${name}:?`);
    }
  });

  it('validates what it embeds in a remote command', async () => {
    const text = await read('scripts/deploy.sh');
    expect(text).toMatch(/\[\[ .* =~ /);
    for (const name of [
      'DEPLOY_HOST',
      'DEPLOY_PORT',
      'DEPLOY_USER',
      'DEPLOY_PATH',
      'PLAKBOEK_IMAGE',
    ]) {
      expect(text).toMatch(new RegExp(`validate\\s+${name}\\b`));
    }
  });

  it('pins the host key and never prompts', async () => {
    const text = await read('scripts/deploy.sh');
    expect(text).toContain('StrictHostKeyChecking=yes');
    expect(text).toContain('BatchMode=yes');
    expect(text).toContain('UserKnownHostsFile=');
    expect(text).not.toContain('StrictHostKeyChecking=no');
  });

  it('logs in to the registry only with a token, which goes in on stdin', async () => {
    const text = await read('scripts/deploy.sh');
    expect(text).toMatch(/REGISTRY_TOKEN:-/);
    expect(text).toContain('--password-stdin');
    // The token is never part of a command line.
    expect(text).not.toMatch(/-p\s+"?\$\{?REGISTRY_TOKEN/);
    expect(text).not.toMatch(/--password\s/);
  });

  it('keeps the strict registry patterns and checks them before the first remote call', async () => {
    const lines = (await read('scripts/deploy.sh')).split('\n');
    const user = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line.startsWith('validate REGISTRY_USER '));
    const host = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line.startsWith('validate REGISTRY_HOST '));
    expect(user.map(({ line }) => line)).toEqual([
      "validate REGISTRY_USER '^[A-Za-z0-9._-]+$'",
    ]);
    expect(host.map(({ line }) => line)).toEqual([
      "validate REGISTRY_HOST '^[A-Za-z0-9.:-]+$'",
    ]);
    const firstRemote = lines.findIndex((line) => line.startsWith('remote '));
    expect(firstRemote).toBeGreaterThan(0);
    expect(user[0]?.index).toBeLessThan(firstRemote);
    expect(host[0]?.index).toBeLessThan(firstRemote);
  });

  it('pulls, starts Postgres, migrates and only then recreates the app, chained', async () => {
    const lines = (await read('scripts/deploy.sh')).split('\n');
    const steps = [
      'docker compose -f compose.yaml pull app',
      'docker compose -f compose.yaml up -d --wait postgres',
      'docker compose -f compose.yaml run --rm migrate',
      'docker compose -f compose.yaml up -d --wait app caddy',
    ];
    const positions = steps.map((step) =>
      lines.findIndex((line) => line.includes(step)),
    );
    for (const position of positions) expect(position).toBeGreaterThan(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Each step is chained to the one before it, so a failure stops the rest.
    for (const position of positions) {
      expect(lines[position]?.trim().startsWith('&&')).toBe(true);
    }
  });

  it('records the image in .env only after the app and proxy are up, chained', async () => {
    const lines = (await read('scripts/deploy.sh')).split('\n');
    const steps = [
      'docker compose -f compose.yaml up -d --wait app caddy',
      'umask 077',
      'rm -f .env.next',
      'PLAKBOEK_IMAGE=',
      'printf',
      'mv -f .env.next .env',
    ];
    let previous = -1;
    for (const step of steps) {
      const position = lines.findIndex(
        (line, index) => index > previous && line.includes(step),
      );
      expect(`${step}: line ${position}`).not.toContain('line -1');
      expect(`${step}: ${lines[position]?.trim().startsWith('&&')}`).toBe(
        `${step}: true`,
      );
      previous = position;
    }
  });

  it('never runs a compose command without the production file', async () => {
    const text = await read('scripts/deploy.sh');
    for (const match of text.matchAll(/docker compose (\S+)/g)) {
      expect(match[1]).toBe('-f');
    }
  });
});

describe('compose stack', () => {
  it('defines the app, the database, the proxy and a one-off migrate service', async () => {
    const text = await read('compose.yaml');
    for (const service of ['postgres', 'migrate', 'app', 'caddy']) {
      expect(text).toMatch(new RegExp(`^ {2}${service}:\\s*$`, 'm'));
    }
    expect(text).toContain('image: postgres:17');
    expect(text).toContain('image: caddy:2');
    expect(text).toMatch(/profiles:\s*\[\s*'tools'\s*\]/);
    expect(text).toMatch(/restart:\s*'no'/);
    expect(text).toContain('./node_modules/.bin/plakboek');
    expect(text).toContain('/cms/health');
  });

  it('does not publish the database and bind-mounts nothing', async () => {
    const text = await read('compose.yaml');
    const postgres = /^ {2}postgres:\s*\n((?: {4}.*\n|\s*\n)+)/m.exec(text);
    expect(postgres?.[1]).toBeDefined();
    expect(postgres?.[1]).not.toMatch(/^ {4}ports:/m);
    expect(text).not.toMatch(/^\s+-\s+\.{1,2}\//m);
    expect(text).not.toMatch(/type:\s*bind/);
  });

  it('keeps the image reference optional and the secrets required', async () => {
    const text = await read('compose.yaml');
    expect(text).toContain('${PLAKBOEK_IMAGE:-plakboek-app:local}');
    expect(text).not.toMatch(/\$\{PLAKBOEK_IMAGE:\?/);
    expect(text).toMatch(/\$\{POSTGRES_PASSWORD:\?[^}]+\}/);
    expect(text).toMatch(/\$\{SITE_ADDRESS:\?[^}]+\}/);
    expect(text).toContain('NODE_ENV: production');
    expect(text).toMatch(/env_file:\s*\.env/);
  });

  it('proxies with encoding, an upstream retry window and the default ports', async () => {
    const text = await read('compose.yaml');
    expect(text).toMatch(/^\s+content:\s*\|/m);
    expect(text).toMatch(/^\s+encode\b/m);
    expect(text).toContain('reverse_proxy app:3000');
    expect(text.match(/lb_try_duration/g)).toHaveLength(1);
    expect(text).toContain('lb_try_duration 15s');
    expect(text).toContain('lb_try_interval 250ms');
    expect(text).toContain('${CADDY_HTTP_PORT:-80}:80');
    expect(text).toContain('${CADDY_HTTPS_PORT:-443}:443');
    expect(text).toContain('Strict-Transport-Security');
  });

  it('publishes Postgres on loopback only in the development override', async () => {
    const text = await read('compose.override.yaml');
    expect(text).toContain('127.0.0.1:5432:5432');
    expect(text).not.toMatch(/['"]?0\.0\.0\.0/);
    expect(text).not.toMatch(/^\s+-\s+['"]?5432:5432/m);
  });
});

describe('Dockerfile', () => {
  it('builds in stages on the Node 22 slim image with a frozen lockfile', async () => {
    const text = await read('Dockerfile');
    expect(text).toMatch(/^FROM node:22-slim AS /m);
    expect(text).toContain('corepack enable');
    expect(text.match(/^COPY \. \./gm)).toHaveLength(2);
    expect(text.match(/pnpm install --frozen-lockfile/g)).toHaveLength(2);
    expect(text).toContain('--mount=type=cache');
    expect(text).toMatch(/NODE_ENV=production[^\n]*pnpm run build/);
  });

  it('runs the server as the node user with the build id and what bootstrap needs', async () => {
    const text = await read('Dockerfile');
    expect(text.match(/^USER node$/gm)).toHaveLength(1);
    expect(text).toContain('CMD ["node", "server.ts"]');
    expect(text).toContain('ARG GIT_SHA');
    expect(text).toContain('PLAKBOEK_BUILD_ID=$GIT_SHA');
    expect(text).toContain('ENV NODE_ENV=production');
    for (const path of [
      'node_modules',
      'build',
      'package.json',
      'server.ts',
      'plakboek.config.ts',
      'seed.ts',
      'tsconfig.json',
      'blocks',
    ]) {
      expect(text).toMatch(
        new RegExp(`^COPY --from=\\S+ .*\\b${path}\\b`, 'm'),
      );
    }
  });

  it('contains no secret', async () => {
    const text = await read('Dockerfile');
    expect(text).not.toMatch(/PASSWORD|SECRET|TOKEN|DATABASE_URL/i);
    expect(text).not.toMatch(/^ARG (?!GIT_SHA)/m);
  });
});

describe('.dockerignore', () => {
  it('keeps dependencies, build output, history and every .env out of the build context', async () => {
    const lines = (await read('.dockerignore'))
      .split('\n')
      .map((line) => line.trim());
    for (const entry of [
      'node_modules',
      'build',
      '.react-router',
      '.git',
      '.env',
      '.env.*',
      '!.env.example',
    ]) {
      expect(lines).toContain(entry);
    }
    // The negation comes after the pattern it excepts.
    expect(lines.indexOf('!.env.example')).toBeGreaterThan(
      lines.indexOf('.env.*'),
    );
  });
});

describe('deploy guide', () => {
  it('covers the box, the secrets, the first deploy and the caveats', async () => {
    const text = await read('DEPLOY.md');
    for (const part of [
      'DEPLOY_SSH_KEY',
      'DEPLOY_KNOWN_HOSTS',
      'DEPLOY_HOST',
      'DEPLOY_USER',
      'DEPLOY_PATH',
      'DEPLOY_PORT',
      'ssh-keyscan -t ed25519',
      'production',
      'POSTGRES_PASSWORD',
      'PLAKBOEK_SECRET',
      'SITE_ADDRESS',
      'plakboek bootstrap',
      '--password-stdin',
      'DATABASE_MIGRATION_URL',
      'read:packages',
      'no backup',
      'tip of',
      'production-deploy',
    ]) {
      expect(text.toLowerCase()).toContain(part.toLowerCase());
    }
  });

  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + heading.length + 4);
    const next = rest.search(/^## /m);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it('describes the first-run window as it is and gives confirmation and recovery', async () => {
    const first = section(await read('DEPLOY.md'), 'The first deploy');
    expect(first).toMatch(/until the first account exists/i);
    expect(first).toMatch(/\/cms\/setup[^.]*open to anyone/i);
    for (const line of [
      'cd /srv/site',
      "printf '%s' 'the password' | docker compose -f compose.yaml run --rm -T app \\",
      '--password-stdin',
    ]) {
      expect(first).toContain(line);
    }
    expect(first).toContain('Created superadmin');
    expect(first).toMatch(/404/);
    expect(first).toContain('already has users');
    expect(first).toContain('docker compose -f compose.yaml down --volumes');
    expect(first).not.toMatch(
      /before (anyone|anybody|someone) (else )?can (reach|open)/i,
    );
    expect(first).not.toContain('!');
  });

  it('keeps one fenced command block that holds the bootstrap', async () => {
    const text = await read('DEPLOY.md');
    const blocks = [...text.matchAll(/^\s*```sh\n([\s\S]*?)^\s*```$/gm)].filter(
      (match) => (match[1] ?? '').includes('plakboek bootstrap'),
    );
    expect(blocks).toHaveLength(1);
  });

  it('lists recording the image among the deploy steps and says the script owns that line', async () => {
    const text = await read('DEPLOY.md');
    const steps = section(text, 'What a deploy does');
    expect(steps).toMatch(/^6\. .*PLAKBOEK_IMAGE.*\.env/m);
    const prepare = section(text, 'Prepare the server');
    expect(prepare).toMatch(/deploy script[^.]*PLAKBOEK_IMAGE/i);
  });
});
