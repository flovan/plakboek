/**
 * The `@plakboek/render` entry points are a contract. This suite holds it as
 * one literal list per entry and fails when what `src/index.ts` or
 * `src/server.ts` exports drifts from what the README documents under that
 * entry's own heading, or when the package's published subpaths and the
 * build's entry names drift apart. Reads source and README from disk, so it
 * runs before a build.
 *
 * The "no extra values" checks below catch an export appearing without a
 * matching list entry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function pathOf(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const README_PATH = pathOf('../../README.md');
const ROOT_HEADING = '### Root entry: `@plakboek/render`';
const SERVER_HEADING = '### Server entry: `@plakboek/render/server`';

type ValueKind = 'function' | 'class' | 'constant';

const ROOT_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // constants
  EDIT_PARAM: 'constant',
  EDITOR_FLAG_KEY: 'constant',
  TOOLBAR_DISMISSED_KEY: 'constant',
  // edit-proxy
  NOOP_EDIT: 'constant',
});

const ROOT_TYPES: readonly string[] = Object.freeze([
  // block-component
  'BlockComponent',
  'BlockComponentProps',
  'BlockIdentity',
  // head
  'DocumentInput',
  'PageHead',
  'RenderDocument',
  // edit-proxy
  'EditAttributes',
  'EditProxy',
]);

const SERVER_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // head
  buildPageHead: 'function',
  renderHeadHtml: 'function',
  // document
  renderDefaultDocument: 'function',
  // components
  createComponentMap: 'function',
  // render-snapshot
  renderPageSnapshot: 'function',
  // handler
  createVisitorHandler: 'function',
  VisitorHandlerConfigError: 'class',
  // edit-seam
  renderToolbarBootstrap: 'function',
  TOOLBAR_BOOTSTRAP_CSP_HASH: 'constant',
});

const SERVER_TYPES: readonly string[] = Object.freeze([
  // head
  'PageHeadInput',
  'PageSeoInput',
  // components
  'ComponentMap',
  // hooks
  'BlockRenderErrorEvent',
  'CacheErrorEvent',
  'MissingComponentEvent',
  'RenderErrorEvent',
  'RenderHooks',
  'UnknownBlockEvent',
  // render-snapshot
  'RenderedPage',
  'RenderPageSnapshotInput',
  // handler
  'VisitorHandler',
  'VisitorHandlerConfigIssue',
  'VisitorHandlerDeps',
  // edit-seam
  'EditEntrypoint',
  'EditRequestContext',
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
    label: 'root entry (src/index.ts)',
    heading: ROOT_HEADING,
    sourceRelative: '../../src/index.ts',
    values: ROOT_VALUES,
    types: ROOT_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/index.js'),
  },
  {
    label: 'server entry (src/server.ts)',
    heading: SERVER_HEADING,
    sourceRelative: '../../src/server.ts',
    values: SERVER_VALUES,
    types: SERVER_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/server.js'),
  },
] as const;

for (const entry of ENTRIES) {
  describe(`the @plakboek/render ${entry.label}`, () => {
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
  it('exposes exactly ., ./server and ./package.json', () => {
    const manifest: { exports: Record<string, unknown> } = JSON.parse(
      readFileSync(pathOf('../../package.json'), 'utf8'),
    );
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './server',
      './package.json',
    ]);
  });

  it('builds exactly the entries index and server', () => {
    const config = readFileSync(pathOf('../../tsdown.config.ts'), 'utf8');
    const entryBlock = /entry:\s*\{([^}]*)\}/.exec(config);
    expect(entryBlock).not.toBeNull();
    const names = [
      ...(entryBlock?.[1] ?? '').matchAll(/(\w+)\s*:\s*'src\//g),
    ].map((match) => match[1]!);
    expect(sorted(names)).toEqual(['index', 'server']);
  });

  it('keeps the root source free of server-only imports', () => {
    for (const file of [
      'index',
      'constants',
      'block-component',
      'edit-proxy',
    ]) {
      const source = readFileSync(pathOf(`../../src/${file}.ts`), 'utf8');
      expect(source).not.toMatch(
        /from '(react-dom|drizzle-orm|postgres|node:|@plakboek\/)/,
      );
    }
  });
});

describe('block catalogue prohibition', () => {
  it('ships no block, section or block component from either entry', async () => {
    const names = [
      ...Object.keys(await import('../../src/index.js')),
      ...Object.keys(await import('../../src/server.js')),
    ];
    for (const name of names) {
      expect(name).not.toMatch(/^(Hero|Section|Heading|Paragraph|Text|Image)/);
    }
    expect(readFileSync(pathOf('../../src/index.ts'), 'utf8')).not.toMatch(
      /defineBlocks|BlockDefinition/,
    );
  });
});
