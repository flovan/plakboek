/**
 * The `@plakboek/cache` entry point is a contract. This suite holds that
 * contract as a literal list and fails when what `src/index.ts` exports and
 * what the README's "Public API" tables document drift apart. Reads the
 * barrel and README from disk, so it runs before a build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INDEX_PATH = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
);
const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));

type ValueKind = 'function' | 'class' | 'constant';

const PUBLIC_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // tags
  CACHE_TAG_PATTERN: 'constant',
  contentTypeTag: 'function',
  GLOBAL_TAG: 'constant',
  InvalidCacheTagError: 'class',
  isCacheTag: 'function',
  menuTag: 'function',
  pageTag: 'function',
  // compose
  CachePurgeError: 'class',
  composeInvalidators: 'function',
  purgePageTags: 'function',
  // memory
  createMemoryCache: 'function',
  DEFAULT_MEMORY_CACHE_MAX_BYTES: 'constant',
  DEFAULT_MEMORY_CACHE_MAX_ENTRIES: 'constant',
  DEFAULT_MEMORY_CACHE_TTL_MS: 'constant',
  MemoryCacheConfigError: 'class',
});

const PUBLIC_TYPES: readonly string[] = Object.freeze([
  // backend
  'CacheBackend',
  'CacheEntry',
  'CacheInvalidator',
  'CacheSetOptions',
  // memory
  'MemoryCacheOptions',
]);

const ERROR_FACTORIES: Readonly<
  Record<string, (Klass: new (...args: never[]) => unknown) => unknown>
> = Object.freeze({
  InvalidCacheTagError: (K) =>
    new (K as new (helper: string) => unknown)('pageTag'),
  CachePurgeError: (K) =>
    new (K as new (failures: unknown[], layerCount: number) => unknown)(
      [new Error('layer failed')],
      2,
    ),
  MemoryCacheConfigError: (K) =>
    new (K as new (issues: string[]) => unknown)(['maxEntries is invalid']),
});

type Documented = { readonly name: string; readonly kind: string };

function documentedExports(): Documented[] {
  const lines = readFileSync(README_PATH, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Public API');
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.startsWith('## ') && !line.startsWith('### '),
  );
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.flatMap((line) => {
    const match =
      /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|\s*(function|class|constant|type)\s*\|/.exec(
        line,
      );
    return match === null ? [] : [{ name: match[1]!, kind: match[2]! }];
  });
}

function barrelTypeNames(): string[] {
  const source = readFileSync(INDEX_PATH, 'utf8');
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

describe('the @plakboek/cache public surface', () => {
  it('exports every documented value, each of its expected kind', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    const actual = Object.fromEntries(
      Object.keys(PUBLIC_VALUES).map((name) => [name, kindOf(api[name])]),
    );
    expect(actual).toEqual(PUBLIC_VALUES);
  });

  it('exports no value beyond the documented list', async () => {
    const api = await import('../../src/index.js');
    expect(sorted(Object.keys(api))).toEqual(
      sorted(Object.keys(PUBLIC_VALUES)),
    );
  });

  it('keeps the test-only size probe unreachable', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    expect(api['inspectMemoryCache']).toBeUndefined();
  });

  it('re-exports each module by name, with no wildcard or default export', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');
    expect(source).not.toMatch(/export \*/);
    expect(source).not.toMatch(/export default/);
    expect(sorted(barrelTypeNames())).toEqual(sorted(PUBLIC_TYPES));
  });

  it('names every exported error class after itself, as an Error subclass', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    const classes = Object.entries(PUBLIC_VALUES)
      .filter(([, kind]) => kind === 'class')
      .map(([name]) => name);
    expect(sorted(Object.keys(ERROR_FACTORIES))).toEqual(sorted(classes));

    for (const name of classes) {
      const Klass = api[name] as new (...args: never[]) => unknown;
      const instance = ERROR_FACTORIES[name]!(Klass);
      expect({
        name,
        isError: instance instanceof Error,
        ownName: (instance as Error).name,
      }).toEqual({ name, isError: true, ownName: name });
    }
  });
});

describe('README drift', () => {
  it('documents exactly the exported values, with the same kinds', () => {
    const documented = documentedExports().filter((row) => row.kind !== 'type');
    const byName = Object.fromEntries(
      documented.map((row) => [row.name, row.kind]),
    );
    expect(documented).toHaveLength(Object.keys(byName).length);
    expect(byName).toEqual(PUBLIC_VALUES);
  });

  it('documents exactly the exported types', () => {
    const documented = documentedExports()
      .filter((row) => row.kind === 'type')
      .map((row) => row.name);
    expect(sorted(documented)).toEqual(sorted(PUBLIC_TYPES));
  });

  it('states the ordering contract and the process-local limit', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    expect(readme).toContain('## Ordering contract');
    expect(readme).toContain('## Process-local');
  });
});
