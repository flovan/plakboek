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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_TOKENS,
  SUBSTITUTED_FILES,
  scaffoldProject,
} from '../../src/scaffold.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'template');

const answers = {
  packageName: 'acme-site',
  siteName: 'Acme',
  defaultLocale: 'en',
  additionalLocales: ['nl'],
  timezone: 'Europe/Brussels',
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'create-plakboek-scaffold-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(
        ...(await listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)),
      );
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out.sort();
}

describe('scaffoldProject', () => {
  it('copies every fixture file, renaming _gitignore, and returns the count', async () => {
    const target = join(root, 'out');
    const count = await scaffoldProject({
      templateDir: FIXTURE,
      targetDir: target,
      answers,
      version: '1.2.3',
    });
    expect(await listFiles(target)).toEqual([
      '.gitignore',
      'app/routes.ts',
      'package.json',
      'plakboek.config.ts',
    ]);
    expect(count).toBe(4);
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe(
      await readFile(join(FIXTURE, '_gitignore'), 'utf8'),
    );
  });

  it('substitutes whole tokens with JSON literals in the listed files', async () => {
    const target = join(root, 'out');
    await scaffoldProject({
      templateDir: FIXTURE,
      targetDir: target,
      answers,
      version: '1.2.3',
    });
    const manifest = JSON.parse(
      await readFile(join(target, 'package.json'), 'utf8'),
    );
    expect(manifest.name).toBe('acme-site');
    expect(manifest.dependencies['@plakboek/core']).toBe('1.2.3');
    expect(manifest.dependencies['@plakboek/render']).toBe('1.2.3');

    const config = await readFile(join(target, 'plakboek.config.ts'), 'utf8');
    expect(config).toContain('name: "Acme",');
    expect(config).toContain('defaultLocale: "en",');
    expect(config).toContain('locales: ["en","nl"],');
    expect(config).toContain('timezone: "Europe/Brussels",');
    expect(config).not.toMatch(/__[A-Z_]+__/);
  });

  it('round-trips a hostile site name through JSON.parse', async () => {
    const hostile = 'Acme "Q" \\ back\\slash </script> \'x\' $& $1 `tick`';
    const target = join(root, 'out');
    await scaffoldProject({
      templateDir: FIXTURE,
      targetDir: target,
      answers: { ...answers, siteName: hostile },
      version: '1.2.3',
    });
    const config = await readFile(join(target, 'plakboek.config.ts'), 'utf8');
    const literal = /name: (".*"),\n/.exec(config)?.[1];
    expect(JSON.parse(literal ?? '')).toBe(hostile);
  });

  it('does not re-expand a token that appears inside an answer', async () => {
    const target = join(root, 'out');
    await scaffoldProject({
      templateDir: FIXTURE,
      targetDir: target,
      answers: { ...answers, siteName: "'__LOCALES__' __FOO__" },
      version: '1.2.3',
    });
    const config = await readFile(join(target, 'plakboek.config.ts'), 'utf8');
    const literal = /name: (".*"),\n/.exec(config)?.[1];
    expect(JSON.parse(literal ?? '')).toBe("'__LOCALES__' __FOO__");
    expect(config).toContain('locales: ["en","nl"],');
  });

  it('deduplicates the locales with the default first', async () => {
    const target = join(root, 'out');
    await scaffoldProject({
      templateDir: FIXTURE,
      targetDir: target,
      answers: { ...answers, additionalLocales: ['en', 'nl', 'nl'] },
      version: '1.2.3',
    });
    const config = await readFile(join(target, 'plakboek.config.ts'), 'utf8');
    expect(config).toContain('locales: ["en","nl"],');
  });

  it('copies files outside the substituted list byte for byte', async () => {
    const target = join(root, 'out');
    await scaffoldProject({
      templateDir: FIXTURE,
      targetDir: target,
      answers,
      version: '1.2.3',
    });
    expect(await readFile(join(target, 'app/routes.ts'))).toEqual(
      await readFile(join(FIXTURE, 'app/routes.ts')),
    );
  });

  it('exposes the token and file lists', () => {
    expect(PLACEHOLDER_TOKENS).toContain("'__SITE_NAME__'");
    expect(PLACEHOLDER_TOKENS).toContain('"__PLAKBOEK_VERSION__"');
    expect(SUBSTITUTED_FILES).toEqual(['package.json', 'plakboek.config.ts']);
  });

  it('refuses to overwrite an existing file and leaves it unchanged', async () => {
    const target = join(root, 'out');
    await mkdir(target);
    await writeFile(join(target, 'package.json'), 'mine');
    await expect(
      scaffoldProject({
        templateDir: FIXTURE,
        targetDir: target,
        answers,
        version: '1.2.3',
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(target, 'package.json'), 'utf8')).toBe('mine');
  });

  it('writes nothing when a template holds an unknown placeholder', async () => {
    const template = join(root, 'template');
    await mkdir(template);
    await writeFile(
      join(template, 'package.json'),
      '{ "name": "__PACKAGE_NAME__" }',
    );
    await writeFile(
      join(template, 'plakboek.config.ts'),
      "export default '__NOT_A_TOKEN__';",
    );
    const target = join(root, 'out');
    await expect(
      scaffoldProject({
        templateDir: template,
        targetDir: target,
        answers,
        version: '1.2.3',
      }),
    ).rejects.toThrow(/__NOT_A_TOKEN__/);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a template entry that would escape the target', async () => {
    const template = join(root, 'template');
    await mkdir(template);
    await writeFile(join(template, 'a.txt'), 'x');
    const target = join(root, 'out');
    // A destination outside the target is impossible through readdir names,
    // so exercise the guard through the exported resolver directly.
    const { resolveInside } = await import('../../src/scaffold.js');
    expect(() => resolveInside(target, '../evil.txt')).toThrow(/outside/);
    expect(resolveInside(target, 'a/b.txt')).toBe(join(target, 'a', 'b.txt'));
  });
});
