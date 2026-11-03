/**
 * `@plakboek/content/rich-text` is a second published entry point, and a
 * client-safe one: the editor ships it to the browser. This suite holds its
 * contract as a literal list and fails when `src/rich-text/index.ts` or the
 * README's "Rich text entry" section drifts from it, and when any module in
 * `src/rich-text` imports something that is not `zod` or a sibling module.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RICH_TEXT_DIR = fileURLToPath(
  new URL('../../src/rich-text/', import.meta.url),
);
const INDEX_PATH = `${RICH_TEXT_DIR}index.ts`;
const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));

type ValueKind = 'function' | 'class' | 'constant';

const PUBLIC_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // theme
  TEXT_MARK_NAMES: 'constant',
  TEXT_NODE_NAMES: 'constant',
  HEADING_LEVELS: 'constant',
  TEXT_ALIGNS: 'constant',
  DEFAULT_TEXT_THEME: 'constant',
  resolveTextTheme: 'function',
  narrowTextTheme: 'function',
  findWideningNarrowing: 'function',
  textThemeNarrowingSchema: 'constant',
  TextThemeError: 'class',
  // href
  HREF_MAX_LENGTH: 'constant',
  isAllowedHref: 'function',
  // document
  validateRichTextDocument: 'function',
  isRichTextDocumentInTheme: 'function',
  stripOutOfTheme: 'function',
  isEmptyRichTextDocument: 'function',
  collectRichTextPageIds: 'function',
  isCompleteCta: 'function',
  // link
  PAGE_ID_PATTERN: 'constant',
  linkTargetSchema: 'constant',
  isCompleteLinkTarget: 'function',
  // values
  TOKEN_PATTERN: 'constant',
  CUSTOM_SIZE_MIN: 'constant',
  CUSTOM_SIZE_MAX: 'constant',
  parseCustomColor: 'function',
  parseCustomSize: 'function',
  isCustomColorValue: 'function',
  isCustomSizeValue: 'function',
});

const PUBLIC_TYPES: readonly string[] = [
  'TextMarkName',
  'TextNodeName',
  'HeadingLevel',
  'TextAlign',
  'TextPaletteEntry',
  'TextSizeEntry',
  'CtaVariant',
  'TextThemeInput',
  'TextTheme',
  'TextThemeNarrowing',
  'TextThemeIssueCode',
  'TextThemeIssue',
  'RichTextDocument',
  'RichTextNodeJson',
  'RichTextMarkJson',
  'RichTextIssueCode',
  'RichTextIssue',
  'LinkTarget',
];

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

function kindOf(value: unknown): ValueKind {
  if (typeof value !== 'function') return 'constant';
  return Function.prototype.toString.call(value).startsWith('class')
    ? 'class'
    : 'function';
}

/** Every name inside an `export type { ... } from` statement of the barrel. */
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

type Documented = { readonly name: string; readonly kind: string };

/** Every table row under the README's "Rich text entry" subsection. */
function documentedExports(): Documented[] {
  const lines = readFileSync(README_PATH, 'utf8').split('\n');
  const start = lines.findIndex((line) =>
    line.startsWith('### Rich text entry'),
  );
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.flatMap((line) => {
    const match =
      /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|\s*(function|class|constant|type)\s*\|/.exec(
        line,
      );
    return match === null
      ? []
      : [{ name: match[1] ?? '', kind: match[2] ?? '' }];
  });
}

describe('the @plakboek/content/rich-text public surface', () => {
  it('exports every documented value, each of its expected kind', async () => {
    const api: Record<string, unknown> =
      await import('../../src/rich-text/index.js');
    const actual = Object.fromEntries(
      Object.keys(PUBLIC_VALUES).map((name) => [name, kindOf(api[name])]),
    );
    expect(actual).toEqual(PUBLIC_VALUES);
  });

  it('exports no value beyond the documented list', async () => {
    const api = await import('../../src/rich-text/index.js');
    expect(sorted(Object.keys(api))).toEqual(
      sorted(Object.keys(PUBLIC_VALUES)),
    );
  });

  it('re-exports each module by name, with no wildcard or default export', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');
    expect(source).not.toMatch(/export \*/);
    expect(source).not.toMatch(/export default/);
    expect(sorted(barrelTypeNames())).toEqual(sorted(PUBLIC_TYPES));
  });

  it('names its error class after itself, as an Error subclass', async () => {
    const { TextThemeError } = await import('../../src/rich-text/index.js');
    const error = new TextThemeError([{ code: 'INVALID_SHAPE', message: 'x' }]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TextThemeError');
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
});

describe('the client-safe boundary', () => {
  const files = readdirSync(RICH_TEXT_DIR).filter((name) =>
    name.endsWith('.ts'),
  );

  /** Every module specifier a source file imports, re-exports or dynamically imports. */
  function specifiersOf(source: string): string[] {
    return [
      ...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1] ?? '');
  }

  it('finds the modules and their imports', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'index.ts',
        'theme.ts',
        'document.ts',
        'href.ts',
        'values.ts',
        'link.ts',
      ]),
    );
    const all = files.flatMap((name) =>
      specifiersOf(readFileSync(`${RICH_TEXT_DIR}${name}`, 'utf8')),
    );
    expect(all).toContain('zod');
    expect(all).toContain('./theme.js');
  });

  it('recognises the import forms it must police', () => {
    expect(
      specifiersOf(
        [
          "import { a } from 'drizzle-orm';",
          "import type { b } from 'node:fs';",
          "export { c } from '../x.js';",
          "import 'side-effect';",
          "const d = await import('lazy');",
        ].join('\n'),
      ),
    ).toEqual(['drizzle-orm', 'node:fs', '../x.js', 'side-effect', 'lazy']);
  });

  it.each(files)('%s imports only zod and its own siblings', (name) => {
    const specifiers = specifiersOf(
      readFileSync(`${RICH_TEXT_DIR}${name}`, 'utf8'),
    );
    for (const specifier of specifiers) {
      const allowed =
        specifier === 'zod' ||
        (/^\.\/[\w-]+\.js$/.test(specifier) && !specifier.includes('..'));
      expect({ name, specifier, allowed }).toEqual({
        name,
        specifier,
        allowed: true,
      });
    }
  });
});
