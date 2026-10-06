import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs the shipped deploy script against a fake `ssh` and `docker`, so each
// remote command really executes, locally, in a throwaway deploy directory.
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');
const SCRIPT = join(TEMPLATE, 'scripts', 'deploy.sh');
const DEPLOY_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

const FAKE_SSH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
exec bash -c "\${@: -1}"
`;

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = login ]; then cat > "$FAKE_LOGIN_STDIN"; fi
if [ -n "\${FAKE_DOCKER_FAIL_ON:-}" ] && [[ " $* " == *"$FAKE_DOCKER_FAIL_ON"* ]]; then
  exit 1
fi
`;

type Harness = {
  root: string;
  deployDir: string;
  sshLog: string;
  dockerLog: string;
  loginStdin: string;
  env: Record<string, string>;
};

let harness: Harness;

// A server's .env as the deploy sees it: compose's `env_file: .env` makes the
// file mandatory, and a previous deploy left an image line in the middle.
const SERVER_ENV = [
  'POSTGRES_USER=plakboek',
  'POSTGRES_PASSWORD=s3cr3t with spaces',
  'PLAKBOEK_IMAGE=ghcr.io/acme/site:old',
  'DATABASE_URL=postgres://plakboek:s3cr3t@postgres:5432/plakboek',
  'SITE_ADDRESS=example.com',
  '',
].join('\n');
const NEW_IMAGE = 'ghcr.io/acme/site:abc123';

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deploy-script-')));
  const bin = join(root, 'bin');
  const deployDir = join(root, 'site');
  await mkdir(bin);
  await mkdir(deployDir);
  await writeFile(join(bin, 'ssh'), FAKE_SSH);
  await writeFile(join(bin, 'docker'), FAKE_DOCKER);
  await chmod(join(bin, 'ssh'), 0o755);
  await chmod(join(bin, 'docker'), 0o755);
  const sshLog = join(root, 'ssh.log');
  const dockerLog = join(root, 'docker.log');
  const loginStdin = join(root, 'login.stdin');
  await writeFile(join(deployDir, '.env'), SERVER_ENV);
  await chmod(join(deployDir, '.env'), 0o644);
  harness = {
    root,
    deployDir,
    sshLog,
    dockerLog,
    loginStdin,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      DEPLOY_HOST: 'box.example.com',
      DEPLOY_PORT: '22',
      DEPLOY_USER: 'deploy',
      DEPLOY_PATH: deployDir,
      PLAKBOEK_IMAGE: NEW_IMAGE,
      SSH_KEY_FILE: join(root, 'key'),
      KNOWN_HOSTS_FILE: join(root, 'known_hosts'),
      FAKE_SSH_LOG: sshLog,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_LOGIN_STDIN: loginStdin,
    },
  };
});

afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true });
});

function deploy(extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT], {
    env: { ...harness.env, ...extra },
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function lines(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter((l) => l !== '');
}

const COMPOSE_STEPS = [
  'compose -f compose.yaml pull app',
  'compose -f compose.yaml up -d --wait postgres',
  'compose -f compose.yaml run --rm migrate',
  'compose -f compose.yaml up -d --wait app caddy',
];

describe('deploy script harness', () => {
  it('uses a deploy directory the script accepts', () => {
    expect(harness.deployDir).toMatch(DEPLOY_PATH_PATTERN);
  });
});

describe('deploy script, registry login', () => {
  it('logs in as the repository owner and sends the token only on stdin', async () => {
    const token = 'tok_9f3a7c1e5b2d4a60b8e1c7d3f2a94b05';
    const result = deploy({
      REGISTRY_HOST: 'ghcr.io',
      REGISTRY_USER: 'acme-corp',
      REGISTRY_TOKEN: token,
    });
    expect(result.code).toBe(0);

    const docker = await lines(harness.dockerLog);
    const login = docker.indexOf('login ghcr.io -u acme-corp --password-stdin');
    expect(login).toBe(0);
    expect(await readFile(harness.loginStdin, 'utf8')).toBe(token);

    const sshLog = await readFile(harness.sshLog, 'utf8');
    expect(sshLog).not.toContain(token);
    expect(docker.join('\n')).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(token);

    const after = docker.slice(login + 1);
    expect(after).toEqual(COMPOSE_STEPS);

    expect(
      await readFile(join(harness.deployDir, 'compose.yaml'), 'utf8'),
    ).toBe(await readFile(join(TEMPLATE, 'compose.yaml'), 'utf8'));
  });

  it.each([
    ['a single letter', 'a'],
    ['mixed case', 'Acme'],
    ['hyphens and digits', 'acme-corp-2'],
    ['the 39-character maximum', 'a1-'.repeat(13)],
  ])('accepts a GitHub login with %s', async (_label, user) => {
    expect(user.length).toBeLessThanOrEqual(39);
    const result = deploy({
      REGISTRY_HOST: 'ghcr.io',
      REGISTRY_USER: user,
      REGISTRY_TOKEN: 'token',
    });
    expect(result.code).toBe(0);
    expect(await lines(harness.dockerLog)).toContain(
      `login ghcr.io -u ${user} --password-stdin`,
    );
  });

  it('refuses a bot actor before connecting', async () => {
    const result = deploy({
      REGISTRY_HOST: 'ghcr.io',
      REGISTRY_USER: 'renovate[bot]',
      REGISTRY_TOKEN: 'token',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FATAL: REGISTRY_USER');
    expect(await lines(harness.sshLog)).toEqual([]);
    expect(existsSync(join(harness.deployDir, 'compose.yaml'))).toBe(false);
  });

  it('refuses a registry host with shell syntax before connecting', async () => {
    const result = deploy({
      REGISTRY_HOST: 'ghcr.io;id',
      REGISTRY_USER: 'acme-corp',
      REGISTRY_TOKEN: 'token',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FATAL: REGISTRY_HOST');
    expect(await lines(harness.sshLog)).toEqual([]);
    expect(existsSync(join(harness.deployDir, 'compose.yaml'))).toBe(false);
  });

  it('skips the login without a token', async () => {
    const result = deploy();
    expect(result.code).toBe(0);
    const docker = await lines(harness.dockerLog);
    expect(docker.some((line) => line.startsWith('login'))).toBe(false);
    expect(docker).toEqual(COMPOSE_STEPS);
  });
});

describe('deploy script, ordering', () => {
  it('stops before the app is recreated when the migration fails', async () => {
    const result = deploy({ FAKE_DOCKER_FAIL_ON: 'run --rm migrate' });
    expect(result.code).not.toBe(0);
    expect(await lines(harness.dockerLog)).toEqual(COMPOSE_STEPS.slice(0, 3));
  });

  it('leaves the server .env untouched and writes no temporary file when the migration fails', async () => {
    const envPath = join(harness.deployDir, '.env');
    const result = deploy({ FAKE_DOCKER_FAIL_ON: 'run --rm migrate' });
    expect(result.code).not.toBe(0);
    expect(await readFile(envPath, 'utf8')).toBe(SERVER_ENV);
    expect((await stat(envPath)).mode & 0o777).toBe(0o644);
    expect(await lines(harness.dockerLog)).not.toContain(
      'compose -f compose.yaml up -d --wait app caddy',
    );
    expect(existsSync(join(harness.deployDir, '.env.next'))).toBe(false);
  });

  it('leaves the server .env untouched when the app fails to start', async () => {
    const envPath = join(harness.deployDir, '.env');
    const result = deploy({ FAKE_DOCKER_FAIL_ON: 'up -d --wait app caddy' });
    expect(result.code).not.toBe(0);
    expect(await readFile(envPath, 'utf8')).toBe(SERVER_ENV);
    expect(existsSync(join(harness.deployDir, '.env.next'))).toBe(false);
  });
});

describe('deploy script, recording the deployed image', () => {
  it('keeps exactly one image line, at the end, and every other line as it was', async () => {
    const envPath = join(harness.deployDir, '.env');
    const result = deploy();
    expect(result.code).toBe(0);

    const after = await readFile(envPath, 'utf8');
    const kept = SERVER_ENV.split('\n')
      .filter((line) => !line.startsWith('PLAKBOEK_IMAGE='))
      .join('\n');
    expect(after).toBe(`${kept}PLAKBOEK_IMAGE=${NEW_IMAGE}\n`);
    expect(after.match(/^PLAKBOEK_IMAGE=/gm)).toHaveLength(1);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(harness.deployDir, '.env.next'))).toBe(false);
  });

  it('puts the record on its own line after a last line without a newline', async () => {
    const envPath = join(harness.deployDir, '.env');
    await writeFile(
      envPath,
      'POSTGRES_USER=plakboek\nSITE_ADDRESS=example.com',
    );
    const result = deploy();
    expect(result.code).toBe(0);
    expect(await readFile(envPath, 'utf8')).toBe(
      `POSTGRES_USER=plakboek\nSITE_ADDRESS=example.com\nPLAKBOEK_IMAGE=${NEW_IMAGE}\n`,
    );
  });

  it('replaces the record again on the next deploy', async () => {
    const envPath = join(harness.deployDir, '.env');
    expect(deploy().code).toBe(0);
    expect(deploy({ PLAKBOEK_IMAGE: 'ghcr.io/acme/site:next' }).code).toBe(0);
    const after = await readFile(envPath, 'utf8');
    expect(after.match(/^PLAKBOEK_IMAGE=.*$/gm)).toEqual([
      'PLAKBOEK_IMAGE=ghcr.io/acme/site:next',
    ]);
  });
});
