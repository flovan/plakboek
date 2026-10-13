/**
 * The `@plakboek/editor` entry points are a contract. This suite holds it as
 * one literal list per entry and fails when what `src/server.ts` or
 * `src/client.ts` exports drifts from what the README documents under that
 * entry's own heading, or when the package's published subpaths and the
 * build's entry names drift apart. Reads source and README from disk; the
 * generated stylesheet module must exist, which `pnpm test` guarantees.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function pathOf(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const README_PATH = pathOf('../../README.md');
const SERVER_HEADING = '### Server entry: `@plakboek/editor/server`';
const CLIENT_HEADING = '### Client entry: `@plakboek/editor/client`';

type ValueKind = 'function' | 'class' | 'constant';

const SERVER_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // server/entrypoint
  createEditEntrypoint: 'function',
  // server/cms-pages
  createCmsPages: 'function',
  // chrome/styles
  chromeStyleElement: 'function',
  CHROME_STYLE_CSP_HASH: 'constant',
});

const SERVER_TYPES: readonly string[] = Object.freeze([
  // server/entrypoint
  'EditEntrypointDeps',
  // server/cms-pages
  'CmsPages',
  'CmsPagesDeps',
  // server/assets
  'EditorAssets',
  'EditorDevScript',
]);

const CLIENT_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // client/boot
  bootEditor: 'function',
  // chrome/styles
  chromeStyleSheet: 'function',
  adoptChromeStyles: 'function',
  // chrome/strings
  STRINGS: 'constant',
  formatString: 'function',
});

const CLIENT_TYPES: readonly string[] = Object.freeze([
  // client/boot
  'BootEditorOptions',
  // client/frame/block-edit-loader
  'BlockEditLoaders',
  // chrome/shell
  'SidebarSlots',
  // chrome/strings
  'StringKey',
]);

type Documented = { readonly name: string; readonly kind: string };

/** Every `| \`name\` | kind | purpose |` row between a heading and the next
 * heading of any level. */
function documentedUnder(heading: string): Documented[] {
  const lines = readFileSync(README_PATH, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.flatMap((line) => {
    const match =
      /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|\s*(function|class|constant|type)\s*\|/.exec(
        line,
      );
    return match === null ? [] : [{ name: match[1]!, kind: match[2]! }];
  });
}

function typeNamesIn(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  return [...source.matchAll(/export type \{([^}]*)\}\s*from/g)].flatMap(
    (match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

function kindOf(value: unknown): ValueKind {
  if (typeof value !== 'function') return 'constant';
  return Function.prototype.toString.call(value).startsWith('class')
    ? 'class'
    : 'function';
}

const ENTRIES = [
  {
    label: 'server entry (src/server.ts)',
    heading: SERVER_HEADING,
    sourceRelative: '../../src/server.ts',
    values: SERVER_VALUES,
    types: SERVER_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/server.js'),
  },
  {
    label: 'client entry (src/client.ts)',
    heading: CLIENT_HEADING,
    sourceRelative: '../../src/client.ts',
    values: CLIENT_VALUES,
    types: CLIENT_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/client.js'),
  },
] as const;

for (const entry of ENTRIES) {
  describe(`the @plakboek/editor ${entry.label}`, () => {
    it('exports every documented value, each of its expected kind', async () => {
      const api = await entry.load();
      const actual = Object.fromEntries(
        Object.keys(entry.values).map((name) => [name, kindOf(api[name])]),
      );
      expect(actual).toEqual(entry.values);
    });

    it('exports no value beyond the documented list', async () => {
      const api = await entry.load();
      expect(sorted(Object.keys(api))).toEqual(
        sorted(Object.keys(entry.values)),
      );
    });

    it('re-exports by name, with no wildcard or default export', () => {
      const source = readFileSync(pathOf(entry.sourceRelative), 'utf8');
      expect(source).not.toMatch(/export \*/);
      expect(source).not.toMatch(/export default/);
      expect(sorted(typeNamesIn(pathOf(entry.sourceRelative)))).toEqual(
        sorted(entry.types),
      );
    });

    it("documents exactly the entry's values in its own README table, with the same kinds", () => {
      const documented = documentedUnder(entry.heading).filter(
        (row) => row.kind !== 'type',
      );
      const byName = Object.fromEntries(
        documented.map((row) => [row.name, row.kind]),
      );
      expect(documented).toHaveLength(Object.keys(byName).length);
      expect(byName).toEqual(entry.values);
    });

    it("documents exactly the entry's types in its own README table", () => {
      const documented = documentedUnder(entry.heading)
        .filter((row) => row.kind === 'type')
        .map((row) => row.name);
      expect(sorted(documented)).toEqual(sorted(entry.types));
    });
  });
}

describe('the published subpaths', () => {
  it('exposes exactly ./server, ./client and ./package.json', () => {
    const manifest: { exports: Record<string, unknown> } = JSON.parse(
      readFileSync(pathOf('../../package.json'), 'utf8'),
    );
    expect(Object.keys(manifest.exports)).toEqual([
      './server',
      './client',
      './package.json',
    ]);
  });

  it('builds exactly the entries server and client', () => {
    const config = readFileSync(pathOf('../../tsdown.config.ts'), 'utf8');
    const names = [...config.matchAll(/(\w+)\s*:\s*'src\//g)].map(
      (match) => match[1]!,
    );
    expect(sorted(names)).toEqual(['client', 'server']);
  });

  it('declares react and react-dom as catalog peers', () => {
    const manifest: { peerDependencies: Record<string, string> } = JSON.parse(
      readFileSync(pathOf('../../package.json'), 'utf8'),
    );
    expect(manifest.peerDependencies).toEqual({
      react: 'catalog:',
      'react-dom': 'catalog:',
    });
  });
});
