import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The client entry ships to signed-in editors' browsers. This walks the BUILT
 * `dist/client.js` with a real ES module lexer (static imports, re-exports,
 * side-effect imports and dynamic `import()`), following relative chunks, and
 * fails on any server, driver, auth, mail or build-tool specifier.
 */

/** Exact specifiers, matched together with their own subpaths. */
const SERVER_ONLY = [
  'drizzle-orm',
  'pg',
  'postgres',
  'better-auth/adapters',
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
  '@plakboek/render/server',
  '@plakboek/core/config',
  '@plakboek/core/server',
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

/**
 * The auth library is allowed in the client only as its browser client and
 * that client's plugin subpath: the package root and every other subpath
 * (the server, its adapters, its plugins) are server code.
 */
const BETTER_AUTH_CLIENT = ['better-auth/client'] as const;

function isDisallowedBetterAuth(specifier: string): boolean {
  if (specifier === 'better-auth') return true;
  if (!specifier.startsWith('better-auth/')) return false;
  return !BETTER_AUTH_CLIENT.some(
    (entry) => specifier === entry || specifier.startsWith(`${entry}/`),
  );
}

function isServerOnly(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  if (isDisallowedBetterAuth(specifier)) return true;
  return SERVER_ONLY.some((entry) =>
    entry.endsWith('/')
      ? specifier.startsWith(entry)
      : specifier === entry || specifier.startsWith(`${entry}/`),
  );
}

const serverOnlyReaches = (graph: ModuleGraph): string[] =>
  [...graph.bareSpecifiers.keys()].filter(isServerOnly);

const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
const clientEntry = path.join(distDir, 'client.js');
const serverEntry = path.join(distDir, 'server.js');
const hotEntry = path.join(distDir, 'hot.js');

describe('collectModuleGraph (seeded leaks prove the walker can fail)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'plakboek-editor-graph-'));
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

  it('reports node: builtins, react-dom/server, drivers and the auth root', async () => {
    await writeFile(
      path.join(dir, 'static.js'),
      [
        "import fs from 'node:fs';",
        "import { renderToString } from 'react-dom/server';",
        "import { sql } from 'drizzle-orm/pg-core';",
        "import postgres from 'postgres';",
        "import pg from 'pg';",
        "import { createAuth } from '@plakboek/auth';",
        "import { createDb } from '@plakboek/db';",
        "import mail from 'nodemailer';",
        '',
      ].join('\n'),
    );
    const graph = await collectModuleGraph(path.join(dir, 'static.js'));
    expect(serverOnlyReaches(graph).sort()).toEqual(
      [
        '@plakboek/auth',
        '@plakboek/db',
        'drizzle-orm/pg-core',
        'node:fs',
        'nodemailer',
        'pg',
        'postgres',
        'react-dom/server',
      ].sort(),
    );
  });

  it('reports the auth library root and its server subpaths, but not its browser client', async () => {
    await writeFile(
      path.join(dir, 'auth.js'),
      [
        "import { betterAuth } from 'better-auth';",
        "import { admin } from 'better-auth/plugins';",
        "import { drizzleAdapter } from 'better-auth/adapters/drizzle';",
        "import { createAuthClient } from 'better-auth/client';",
        "export const load = () => import('better-auth/client/plugins');",
        '',
      ].join('\n'),
    );
    const graph = await collectModuleGraph(path.join(dir, 'auth.js'));
    expect(serverOnlyReaches(graph).sort()).toEqual(
      [
        'better-auth',
        'better-auth/adapters/drizzle',
        'better-auth/plugins',
      ].sort(),
    );
  });

  it('does not flag a look-alike package, client-safe imports or import-looking comment text', async () => {
    await writeFile(
      path.join(dir, 'clean.js'),
      [
        "// import 'node:fs';",
        "/* import('@plakboek/pages'); */",
        "import { x } from 'pg-like';",
        "import { y } from 'react';",
        "import { z } from 'react-dom/client';",
        "import { c } from 'better-auth/client';",
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

describe('the built @plakboek/editor client entry', () => {
  beforeAll(() => {
    if (
      !existsSync(clientEntry) ||
      !existsSync(serverEntry) ||
      !existsSync(hotEntry)
    ) {
      throw new Error(
        'run pnpm run build before the editor unit tests: dist/client.js, dist/server.js and dist/hot.js are required by the client-safety invariant',
      );
    }
  });

  it('reaches no node: builtin, driver, auth, mail, server or build-tool package', async () => {
    const graph = await collectModuleGraph(clientEntry);
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
    const graph = await collectModuleGraph(clientEntry);
    expect(graph.violations).toEqual([]);
  });

  it('reaches the auth library through its browser client only', async () => {
    const graph = await collectModuleGraph(clientEntry);
    const reached = [...graph.bareSpecifiers.keys()].filter(
      (specifier) =>
        specifier === 'better-auth' || specifier.startsWith('better-auth/'),
    );
    expect(reached.length).toBeGreaterThan(0);
    for (const specifier of reached) {
      expect(specifier).toMatch(/^better-auth\/client(\/|$)/);
    }
  });

  it('walks the entry and its chunks (the walker is not vacuous)', async () => {
    const graph = await collectModuleGraph(clientEntry);
    expect(graph.files.has(clientEntry)).toBe(true);
    const source = await readFile(clientEntry, 'utf8');
    expect(source).toContain('adoptedStyleSheets');
  });
});

/** The dev swap is plain DOM code: nothing a framework or the chrome brings. */
const HOT_FORBIDDEN = [
  'react',
  'react-dom',
  '@tanstack/',
  '@plakboek/render',
] as const;

const isHotForbidden = (specifier: string): boolean =>
  HOT_FORBIDDEN.some((entry) =>
    entry.endsWith('/')
      ? specifier.startsWith(entry)
      : specifier === entry || specifier.startsWith(`${entry}/`),
  );

describe('the built @plakboek/editor hot entry', () => {
  it('reaches no server module, no framework and no other package', async () => {
    const graph = await collectModuleGraph(hotEntry);
    const reached = [...graph.bareSpecifiers.keys()];
    expect(reached.filter(isServerOnly)).toEqual([]);
    expect(reached.filter(isHotForbidden)).toEqual([]);
    expect(graph.violations).toEqual([]);
  });

  it('walks the entry and holds the dev swap (the walker is not vacuous)', async () => {
    const graph = await collectModuleGraph(hotEntry);
    expect(graph.files.has(hotEntry)).toBe(true);
    expect(await readFile(hotEntry, 'utf8')).toContain(
      'plakboek:blocks-swapped',
    );
  });

  it('is detected when a framework is imported (seeded)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plakboek-hot-graph-'));
    try {
      await writeFile(
        path.join(dir, 'hot.js'),
        "import { useState } from 'react';\nimport { x } from '@plakboek/render';\n",
      );
      const graph = await collectModuleGraph(path.join(dir, 'hot.js'));
      expect(
        [...graph.bareSpecifiers.keys()].filter(isHotForbidden).sort(),
      ).toEqual(['@plakboek/render', 'react']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
