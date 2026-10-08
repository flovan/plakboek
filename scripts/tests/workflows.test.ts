import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(import.meta.dirname, '..', '..', '.github', 'workflows');

const read = (name: string): Promise<string> =>
  readFile(join(WORKFLOWS, name), 'utf8');

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

const FORK_GUARD =
  /if:\s*github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name != github\.repository/;

describe('run script extraction helper', () => {
  it('reads inline and block scripts and stops at the next key', () => {
    const text = [
      'steps:',
      '  - run: echo one',
      '  - name: two',
      '    run: |',
      '      echo two',
      '    env:',
      '      X: ${{ secrets.X }}',
    ].join('\n');
    expect(runScripts(text)).toEqual(['echo one', '      echo two']);
  });
});

describe('CI workflow', () => {
  it('scaffolds a host from the packed packages against a Postgres service', async () => {
    const scaffold = jobs(await read('ci.yml')).get('scaffold') ?? '';
    expect(scaffold).not.toBe('');
    expect(scaffold).toMatch(FORK_GUARD);
    expect(scaffold).toMatch(/timeout-minutes:\s*\d+/);
    expect(scaffold).toMatch(/persist-credentials:\s*false/);
    expect(scaffold).toMatch(/image:\s*postgres:17/);
    expect(scaffold).toMatch(/SCAFFOLD_DATABASE_URL:\s*postgres:\/\//);
    expect(scaffold).toContain('pnpm install --frozen-lockfile');
    expect(scaffold).toMatch(/run:\s*bash scripts\/verify-scaffold\.sh\s*$/m);
  });

  it('proves the generated deploy against a throwaway target', async () => {
    const proof = jobs(await read('ci.yml')).get('deploy-proof') ?? '';
    expect(proof).not.toBe('');
    expect(proof).toMatch(FORK_GUARD);
    expect(proof).toMatch(/timeout-minutes:\s*\d+/);
    expect(proof).toMatch(/persist-credentials:\s*false/);
    expect(proof).toContain('pnpm install --frozen-lockfile');
    expect(proof).toMatch(/run:\s*bash scripts\/verify-deploy\.sh\s*$/m);
  });

  it('runs each proof script once', async () => {
    const text = await read('ci.yml');
    expect(text.match(/verify-deploy\.sh/g)).toHaveLength(1);
    expect(text.match(/verify-scaffold\.sh/g)).toHaveLength(1);
  });

  it('never puts an expression inside a run script', async () => {
    const scripts = runScripts(await read('ci.yml'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain('${{');
  });
});

describe('release workflow', () => {
  it('smoke-tests the released packages from the registry', async () => {
    const all = jobs(await read('release.yml'));
    const smoke = all.get('smoke') ?? '';
    expect(smoke).not.toBe('');
    expect(smoke).toMatch(/needs:\s*\[\s*version\s*,\s*publish\s*\]/);
    expect(smoke).toContain(
      "if: needs.version.outputs.hasChangesets == 'false'",
    );
    expect(smoke).toMatch(/timeout-minutes:\s*\d+/);
    expect(smoke).toMatch(/persist-credentials:\s*false/);
    expect(smoke).toMatch(/image:\s*postgres:17/);
    expect(smoke).toMatch(/SCAFFOLD_DATABASE_URL:\s*postgres:\/\//);
    expect(smoke).toContain('pnpm install --frozen-lockfile');
    expect(smoke).toContain('packages/create-plakboek/package.json');
    expect(smoke).toMatch(
      /run:\s*node scripts\/release\/wait-for-registry\.ts\s*$/m,
    );
    expect(
      Number(/timeout-minutes:\s*(\d+)/.exec(smoke)?.[1]),
    ).toBeGreaterThanOrEqual(40);
    expect(smoke).toMatch(
      /bash scripts\/verify-scaffold\.sh --registry "\$VERSION"/,
    );
  });

  it('holds no publishing credential in the smoke job', async () => {
    const smoke = jobs(await read('release.yml')).get('smoke') ?? '';
    const permissions = /^ {4}permissions:\s*\n((?: {6}.*\n?)+)/m.exec(smoke);
    expect(permissions?.[1]).toMatch(/contents:\s*read/);
    expect(smoke).not.toMatch(/^\s*id-token:/m);
    expect(smoke).not.toMatch(/^\s*registry-url:/m);
    expect(smoke).not.toContain('NODE_AUTH_TOKEN');
  });

  it('keeps the publish job as the only holder of id-token', async () => {
    const text = await read('release.yml');
    // Comments explain the rule and mention the permission by name.
    const grants = text
      .split('\n')
      .filter((line) => /^\s*id-token:/.test(line));
    expect(grants).toHaveLength(1);
    expect(jobs(text).get('publish') ?? '').toContain('id-token: write');
  });

  it('never puts an expression inside a run script', async () => {
    const scripts = runScripts(await read('release.yml'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain('${{');
  });
});
