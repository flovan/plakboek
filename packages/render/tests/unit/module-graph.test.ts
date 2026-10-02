import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The editor-exclusion invariant: editor code must never be reachable from the
 * visitor-facing build. This walks the *built* output with a real ES module
 * lexer (static imports, re-exports, side-effect imports and dynamic `import()`),
 * following relative chunks and, optionally, `@plakboek/*` workspace packages.
 */

/**
 * Specifier prefixes that must never be reachable from the render build. The
 * guarded set is empty until the editor package exists; extend this list when
 * its package name differs from the ones listed here.
 */
const EDITOR_DENYLIST = [
  '@plakboek/editor',
  '@plakboek/admin',
  '@tiptap/',
  '@dnd-kit/',
  'prosemirror',
] as const;

type Violation = {
  kind: 'non-literal-dynamic-import' | 'unresolved-workspace-package';
  file: string;
  detail: string;
};

type ModuleGraph = {
  files: Set<string>;
  /** Every non-relative specifier reached, with the file chain that reached it. */
  bareSpecifiers: Map<string, string[]>;
  violations: Violation[];
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../');

const isJavaScript = (file: string): boolean => /\.[cm]?js$/.test(file);

async function collectModuleGraph(
  entryFile: string,
  options: { followWorkspace: boolean },
): Promise<ModuleGraph> {
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
        violations.push({
          kind: 'non-literal-dynamic-import',
          file,
          detail: source.slice(record.ss, record.se),
        });
        continue;
      }

      if (isRelative(specifier)) {
        const target = path.resolve(path.dirname(file), specifier);
        if (isJavaScript(target))
          queue.push({ file: target, chain: [...chain, target] });
        continue;
      }

      if (!bareSpecifiers.has(specifier)) bareSpecifiers.set(specifier, chain);

      if (options.followWorkspace && specifier.startsWith('@plakboek/')) {
        let resolved: string;
        try {
          resolved = createRequire(file).resolve(specifier);
        } catch {
          violations.push({
            kind: 'unresolved-workspace-package',
            file,
            detail: specifier,
          });
          continue;
        }
        if (isJavaScript(resolved))
          queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }

  return { files, bareSpecifiers, violations };
}

function matchesDenylist(specifier: string): boolean {
  return EDITOR_DENYLIST.some((entry) => specifier.startsWith(entry));
}

function deniedReaches(
  graph: ModuleGraph,
): { specifier: string; chain: string[] }[] {
  return [...graph.bareSpecifiers]
    .filter(([specifier]) => matchesDenylist(specifier))
    .map(([specifier, chain]) => ({ specifier, chain }));
}

/** Server-only code the root (client-safe) entry must never reach. */
function isServerOnly(specifier: string): boolean {
  return (
    specifier === 'react-dom/server' ||
    specifier.startsWith('drizzle-orm') ||
    specifier === 'postgres' ||
    specifier === '@plakboek/pages' ||
    specifier === '@plakboek/auth' ||
    specifier.startsWith('node:')
  );
}

const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
const serverEntry = path.join(distDir, 'server.js');
const indexEntry = path.join(distDir, 'index.js');

describe('collectModuleGraph (seeded leaks prove the walker can fail)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'plakboek-module-graph-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports an editor package reached through a relative chunk and a dynamic import', async () => {
    await writeFile(path.join(dir, 'entry.js'), "import './chunk-a.js';\n");
    await writeFile(
      path.join(dir, 'chunk-a.js'),
      "export * from './chunk-b.js';\n",
    );
    await writeFile(
      path.join(dir, 'chunk-b.js'),
      "export const load = () => import('@plakboek/editor');\n",
    );

    const graph = await collectModuleGraph(path.join(dir, 'entry.js'), {
      followWorkspace: false,
    });
    const reached = deniedReaches(graph);

    expect(reached).toHaveLength(1);
    expect(reached[0]!.specifier).toBe('@plakboek/editor');
    expect(reached[0]!.chain.map((file) => path.basename(file))).toEqual([
      'entry.js',
      'chunk-a.js',
      'chunk-b.js',
    ]);
  });

  it('reports a static import of an editor package', async () => {
    await writeFile(
      path.join(dir, 'static.js'),
      "import { Editor } from '@tiptap/core';\n",
    );
    const graph = await collectModuleGraph(path.join(dir, 'static.js'), {
      followWorkspace: false,
    });
    expect(deniedReaches(graph).map((entry) => entry.specifier)).toEqual([
      '@tiptap/core',
    ]);
  });

  it('does not report import-looking text inside comments', async () => {
    await writeFile(
      path.join(dir, 'comment.js'),
      [
        "// import '@tiptap/core';",
        "/* import('@tiptap/core'); export * from '@dnd-kit/core'; */",
        'export const note = 1;',
        '',
      ].join('\n'),
    );
    const graph = await collectModuleGraph(path.join(dir, 'comment.js'), {
      followWorkspace: false,
    });
    expect(graph.bareSpecifiers.size).toBe(0);
    expect(graph.violations).toEqual([]);
  });

  it('reports a dynamic import whose specifier is not a string literal', async () => {
    await writeFile(
      path.join(dir, 'dynamic.js'),
      'export const load = (name) => import(name);\n',
    );
    const graph = await collectModuleGraph(path.join(dir, 'dynamic.js'), {
      followWorkspace: false,
    });
    expect(graph.violations).toHaveLength(1);
    expect(graph.violations[0]!.kind).toBe('non-literal-dynamic-import');
  });
});

describe('the built @plakboek/render output', () => {
  beforeAll(() => {
    if (!existsSync(serverEntry) || !existsSync(indexEntry)) {
      throw new Error(
        'run pnpm run build before the render unit tests: dist/server.js and dist/index.js are required by the module-graph invariant',
      );
    }
  });

  it('reaches no editor package from either entry, through chunks or workspace packages', async () => {
    for (const entry of [serverEntry, indexEntry]) {
      const graph = await collectModuleGraph(entry, { followWorkspace: true });
      expect(
        deniedReaches(graph),
        `editor code reachable from ${entry}`,
      ).toEqual([]);
    }
  });

  it('has only statically analysable dynamic imports and resolvable workspace packages', async () => {
    for (const entry of [serverEntry, indexEntry]) {
      const graph = await collectModuleGraph(entry, { followWorkspace: true });
      expect(graph.violations).toEqual([]);
    }
  });

  it('keeps server-only code out of the root entry', async () => {
    const graph = await collectModuleGraph(indexEntry, {
      followWorkspace: false,
    });
    expect([...graph.bareSpecifiers.keys()].filter(isServerOnly)).toEqual([]);
  });

  it('actually walks the server graph (positive control)', async () => {
    const graph = await collectModuleGraph(serverEntry, {
      followWorkspace: true,
    });

    expect(graph.files.size).toBeGreaterThan(1);
    expect(graph.bareSpecifiers.has('react-dom/server')).toBe(true);
    const followedIntoPages = [...graph.files].some((file) =>
      file.split(path.sep).join('/').includes('/packages/pages/'),
    );
    expect(followedIntoPages).toBe(true);
  });
});
