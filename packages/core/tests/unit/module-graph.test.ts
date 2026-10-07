import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The root entry is imported by every host block file, and Phase 7 will
 * bundle those files for the browser. This walks the BUILT `dist/index.js`
 * with a real ES module lexer (static imports, re-exports, side-effect
 * imports and dynamic `import()`), following relative chunks, and fails on
 * any server, driver, auth, mail or build-tool specifier.
 */

/** Exact specifiers, matched together with their own subpaths. */
const SERVER_ONLY = [
  'drizzle-orm',
  'pg',
  'postgres',
  'better-auth',
  'nodemailer',
  'html-to-text',
  'react-dom/server',
  'hono',
  '@hono/',
  'vite',
  '@react-router/dev',
  'tsx',
  '@plakboek/db',
  '@plakboek/auth',
  '@plakboek/pages',
  '@plakboek/content',
  '@plakboek/cache',
] as const;

type Violation = { file: string; detail: string };

type ModuleGraph = {
  files: Set<string>;
  bareSpecifiers: Map<string, string[]>;
  violations: Violation[];
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../');

const isJavaScript = (file: string): boolean => /\.[cm]?js$/.test(file);

async function collectModuleGraph(entryFile: string): Promise<ModuleGraph> {
  await init;
  const files = new Set<string>();
  const bareSpecifiers = new Map<string, string[]>();
  const violations: Violation[] = [];
  const queue: { file: string; chain: string[] }[] = [
    { file: entryFile, chain: [entryFile] },
  ];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);

    const source = await readFile(file, 'utf8');
    const [imports] = parse(source, file);

    for (const record of imports) {
      // `import.meta` is reported as an import record; it names no module.
      if (record.d === -2) continue;

      const specifier = record.n;
      if (specifier === undefined) {
        violations.push({ file, detail: source.slice(record.ss, record.se) });
        continue;
      }

      if (isRelative(specifier)) {
        const target = path.resolve(path.dirname(file), specifier);
        if (isJavaScript(target))
          queue.push({ file: target, chain: [...chain, target] });
        continue;
      }

      if (!bareSpecifiers.has(specifier)) bareSpecifiers.set(specifier, chain);
    }
  }

  return { files, bareSpecifiers, violations };
}

function isServerOnly(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return SERVER_ONLY.some((entry) =>
    entry.endsWith('/')
      ? specifier.startsWith(entry)
      : specifier === entry || specifier.startsWith(`${entry}/`),
  );
}

const serverOnlyReaches = (graph: ModuleGraph): string[] =>
  [...graph.bareSpecifiers.keys()].filter(isServerOnly);

const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
const indexEntry = path.join(distDir, 'index.js');
const configEntry = path.join(distDir, 'config.js');

describe('collectModuleGraph (seeded leaks prove the walker can fail)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'plakboek-core-graph-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a server package reached through a relative chunk and a dynamic import', async () => {
    await writeFile(path.join(dir, 'entry.js'), "import './chunk-a.js';\n");
    await writeFile(
      path.join(dir, 'chunk-a.js'),
      "export * from './chunk-b.js';\n",
    );
    await writeFile(
      path.join(dir, 'chunk-b.js'),
      "export const load = () => import('@plakboek/pages');\n",
    );

    const graph = await collectModuleGraph(path.join(dir, 'entry.js'));
    expect(serverOnlyReaches(graph)).toEqual(['@plakboek/pages']);
    expect(
      graph.bareSpecifiers.get('@plakboek/pages')!.map((f) => path.basename(f)),
    ).toEqual(['entry.js', 'chunk-a.js', 'chunk-b.js']);
  });

  it('reports node: builtins, subpaths of a denied package and @hono scope', async () => {
    await writeFile(
      path.join(dir, 'static.js'),
      [
        "import fs from 'node:fs';",
        "import { sql } from 'drizzle-orm/pg-core';",
        "import { Hono } from 'hono';",
        "import { serve } from '@hono/node-server';",
        '',
      ].join('\n'),
    );
    const graph = await collectModuleGraph(path.join(dir, 'static.js'));
    expect(serverOnlyReaches(graph).sort()).toEqual(
      ['@hono/node-server', 'drizzle-orm/pg-core', 'hono', 'node:fs'].sort(),
    );
  });

  it('does not flag a look-alike package or import-looking comment text', async () => {
    await writeFile(
      path.join(dir, 'clean.js'),
      [
        "// import 'node:fs';",
        "/* import('@plakboek/pages'); */",
        "import { x } from 'pg-like';",
        "import { y } from 'react';",
        'export const note = 1;',
        '',
      ].join('\n'),
    );
    const graph = await collectModuleGraph(path.join(dir, 'clean.js'));
    expect(serverOnlyReaches(graph)).toEqual([]);
  });

  it('reports a dynamic import whose specifier is not a string literal', async () => {
    await writeFile(
      path.join(dir, 'dynamic.js'),
      'export const load = (name) => import(name);\n',
    );
    const graph = await collectModuleGraph(path.join(dir, 'dynamic.js'));
    expect(graph.violations).toHaveLength(1);
  });
});

describe('the built @plakboek/core root entry', () => {
  beforeAll(() => {
    if (!existsSync(indexEntry) || !existsSync(configEntry)) {
      throw new Error(
        'run pnpm run build before the core unit tests: dist/index.js and dist/config.js are required by the client-safety invariant',
      );
    }
  });

  it('reaches no node: builtin, driver, auth, mail, server or build-tool package', async () => {
    const graph = await collectModuleGraph(indexEntry);
    expect(
      serverOnlyReaches(graph).map((specifier) => ({
        specifier,
        chain: graph.bareSpecifiers
          .get(specifier)!
          .map((f) => path.basename(f)),
      })),
    ).toEqual([]);
  });

  it('has only statically analysable dynamic imports', async () => {
    const graph = await collectModuleGraph(indexEntry);
    expect(graph.violations).toEqual([]);
  });

  it('actually sees server code from the config entry (positive control)', async () => {
    const graph = await collectModuleGraph(configEntry);
    expect(graph.bareSpecifiers.has('@plakboek/pages')).toBe(true);
    expect(serverOnlyReaches(graph).length).toBeGreaterThan(0);
  });
});
