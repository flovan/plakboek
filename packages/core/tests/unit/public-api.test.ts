/**
 * The `@plakboek/core` entry points are a contract: hosts import these names
 * and build against these paths. This suite holds each entry as one literal
 * list and fails when what the entry's source exports drifts from what the
 * README documents under that entry's own heading, or when the package's
 * published subpaths and the build's entry names drift apart. Reads source
 * and README from disk, so the README checks run before a build.
 *
 * The "no extra values" checks catch an export appearing without a matching
 * list entry, so a server-only symbol cannot slip into the documented
 * surface unnoticed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function pathOf(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const README_PATH = pathOf('../../README.md');

type ValueKind = 'function' | 'class' | 'constant';

const ROOT_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  defineBlock: 'function',
  defineModule: 'function',
});

const ROOT_TYPES: readonly string[] = Object.freeze([
  'HostBlockDefinition',
  'HostModule',
  'MenuDefinitions',
  'MenuItem',
  'MenuLabel',
  'ModuleDefinition',
  'PlakboekConfig',
  'PlakboekConfigInput',
  'ResolvedMenuItem',
  'SeedBlock',
  'SeedPage',
  'SiteContext',
  'SiteModule',
]);

const CONFIG_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  defineConfig: 'function',
  PlakboekConfigError: 'class',
  defaultRoles: 'constant',
});

const CONFIG_TYPES: readonly string[] = Object.freeze([
  'PlakboekConfigIssue',
  'PlakboekConfigIssueCode',
]);

const ROUTES_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  cmsRoutes: 'function',
});

const ROUTES_TYPES: readonly string[] = Object.freeze([]);

const VITE_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  plakboek: 'function',
});

const VITE_TYPES: readonly string[] = Object.freeze(['PlakboekPluginOptions']);

const SERVER_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  createServer: 'function',
});

const SERVER_TYPES: readonly string[] = Object.freeze([
  'CreateServerOptions',
  'PlakboekServer',
  'RunningServer',
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

/**
 * Every type a source file exports, by either form: a re-export list
 * (`export type { A, B } from`) or a declaration (`export type A =`).
 */
function typeNamesIn(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const reexported = [...source.matchAll(/export type \{([^}]*)\}\s*from/g)];
  const declared = [...source.matchAll(/^export type (\w+)\b/gm)];
  return [
    ...reexported.flatMap((match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
    ...declared.map((match) => match[1]!),
  ];
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
    heading: '### Root entry: `@plakboek/core`',
    sourceRelative: '../../src/index.ts',
    values: ROOT_VALUES,
    types: ROOT_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/index.js'),
  },
  {
    label: 'config entry (src/config.ts)',
    heading: '### Config entry: `@plakboek/core/config`',
    sourceRelative: '../../src/config.ts',
    values: CONFIG_VALUES,
    types: CONFIG_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/config.js'),
  },
  {
    label: 'routes entry (src/routes.ts)',
    heading: '### Routes entry: `@plakboek/core/routes`',
    sourceRelative: '../../src/routes.ts',
    values: ROUTES_VALUES,
    types: ROUTES_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/routes.js'),
  },
  {
    label: 'vite entry (src/vite.ts)',
    heading: '### Vite entry: `@plakboek/core/vite`',
    sourceRelative: '../../src/vite.ts',
    values: VITE_VALUES,
    types: VITE_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/vite.js'),
  },
  {
    label: 'server entry (src/server.ts)',
    heading: '### Server entry: `@plakboek/core/server`',
    sourceRelative: '../../src/server.ts',
    values: SERVER_VALUES,
    types: SERVER_TYPES,
    load: async (): Promise<Record<string, unknown>> =>
      await import('../../src/server.js'),
  },
] as const;

for (const entry of ENTRIES) {
  describe(`the @plakboek/core ${entry.label}`, () => {
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

    it('exports no type beyond the documented list, and no wildcard or default', () => {
      const source = readFileSync(pathOf(entry.sourceRelative), 'utf8');
      // Anchored to a line start: a comment or a generated-code string may
      // mention these without exporting them.
      expect(source).not.toMatch(/^export \*/m);
      expect(source).not.toMatch(/^export default/m);
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
  const manifest: {
    exports: Record<string, unknown>;
    bin: Record<string, string>;
  } = JSON.parse(readFileSync(pathOf('../../package.json'), 'utf8'));

  it('exposes exactly the five entries, the route-module subpath and package.json', () => {
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './config',
      './routes',
      './vite',
      './server',
      './route-modules/*',
      './package.json',
    ]);
  });

  it('builds the five entries and the CLI by name, plus the route modules', () => {
    const config = readFileSync(pathOf('../../tsdown.config.ts'), 'utf8');
    const entryBlock = /entry:\s*\{([^}]*)\}/.exec(config);
    expect(entryBlock).not.toBeNull();
    const names = [
      ...(entryBlock?.[1] ?? '').matchAll(/(\w+)\s*:\s*'src\//g),
    ].map((match) => match[1]!);
    expect(sorted(names)).toEqual([
      'cli',
      'config',
      'index',
      'routes',
      'server',
      'vite',
    ]);
    expect(entryBlock?.[1]).toContain('...routeModules');
  });

  it('ships the plakboek bin from the built CLI entry', () => {
    expect(manifest.bin).toEqual({ plakboek: './dist/cli.js' });
  });
});

describe('the README', () => {
  const readme = readFileSync(README_PATH, 'utf8');

  it('marks the route-modules subpath internal', () => {
    const line = readme
      .split('\n')
      .find((candidate) => candidate.includes('./route-modules/*'));
    expect(line).toBeDefined();
    expect(line).toMatch(/internal/i);
  });

  it('documents the plakboek bin and each of its commands', () => {
    expect(readme).toContain('`plakboek`');
    for (const command of ['migrate', 'bootstrap', 'mail:test']) {
      expect(readme).toContain(`plakboek ${command}`);
    }
  });

  it('documents every runtime environment variable', () => {
    for (const variable of [
      'DATABASE_URL',
      'DATABASE_MIGRATION_URL',
      'PLAKBOEK_URL',
      'PLAKBOEK_SECRET',
      'PLAKBOEK_BUILD_ID',
      'PLAKBOEK_SMTP_HOST',
      'PLAKBOEK_MAIL_FROM',
      'PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS',
      'PLAKBOEK_BOOTSTRAP_PASSWORD',
      'PORT',
      'HOST',
    ]) {
      expect(readme).toContain(`\`${variable}\``);
    }
  });
});

describe('the root entry stays client-safe', () => {
  it('imports no server-only module', () => {
    for (const file of ['index', 'blocks', 'modules']) {
      const source = readFileSync(pathOf(`../../src/${file}.ts`), 'utf8');
      expect(source).not.toMatch(
        /from '(react-dom|drizzle-orm|postgres|node:|hono|@hono|@plakboek\/)/,
      );
    }
  });
});
