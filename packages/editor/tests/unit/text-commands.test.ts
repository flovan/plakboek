import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSchema, Mark, type Extensions } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import {
  resolveTextTheme,
  type TextTheme,
  type TextThemeInput,
} from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import { buildLockedExtensions } from '../../src/client/text/extensions.js';
import { unlockExtensions } from '../../src/client/text/unlock.js';

type Json = Record<string, unknown>;
type Fixtures = {
  themes: Record<string, TextThemeInput>;
  valid: { name: string; theme: string; doc: Json }[];
};

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../content/tests/fixtures/rich-text/shapes.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Fixtures;

const FULL = resolveTextTheme({
  colors: [
    { label: 'Text', token: 'text' },
    { label: 'Muted', token: 'text-muted' },
    { label: 'Accent', token: 'accent' },
  ],
  sizes: [
    { label: 'Small', token: 'sm' },
    { label: 'Large', token: 'xl' },
    { label: 'Display', token: 'display' },
  ],
  align: true,
});

function schemaFor(theme: TextTheme, extra: Extensions = []): Schema {
  return getSchema([
    ...buildLockedExtensions(),
    ...unlockExtensions(theme),
    ...extra,
  ]);
}

/** An element-shaped value: parse rules only ever call getAttribute and hasAttribute. */
function element(attributes: Record<string, string>): HTMLElement {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
  } as unknown as HTMLElement;
}

type Rule = {
  tag?: string;
  getAttrs?: (node: HTMLElement) => Record<string, unknown> | false | null;
};

function rulesOf(schema: Schema, kind: 'marks' | 'nodes', name: string) {
  const type = schema[kind][name];
  return (type?.spec.parseDOM ?? []) as Rule[];
}

function parseMark(
  schema: Schema,
  name: string,
  attributes: Record<string, string>,
) {
  const rule = rulesOf(schema, 'marks', name)[0];
  return rule?.getAttrs?.(element(attributes));
}

function parseBlock(
  schema: Schema,
  name: string,
  attributes: Record<string, string>,
) {
  const rule = rulesOf(schema, 'nodes', name)[0];
  return rule?.getAttrs?.(element(attributes));
}

describe('the unlock schema is present only when the theme declares it', () => {
  it('adds no colour, size or alignment for a theme without them', () => {
    const schema = schemaFor(resolveTextTheme());
    expect(schema.marks.textColor).toBeUndefined();
    expect(schema.marks.textSize).toBeUndefined();
    expect(schema.nodes.paragraph?.spec.attrs).toBeUndefined();
    expect(schema.nodes.heading?.spec.attrs).not.toHaveProperty('textAlign');
  });

  it('adds the colour and size marks and the alignment attribute for a full theme', () => {
    const schema = schemaFor(FULL);
    expect(schema.marks.textColor).toBeDefined();
    expect(schema.marks.textSize).toBeDefined();
    expect(schema.nodes.paragraph?.spec.attrs).toHaveProperty('textAlign');
    expect(schema.nodes.heading?.spec.attrs).toHaveProperty('textAlign');
  });

  it('adds only the part the theme declares', () => {
    const colorsOnly = schemaFor(
      resolveTextTheme({ colors: [{ label: 'Accent', token: 'accent' }] }),
    );
    expect(colorsOnly.marks.textColor).toBeDefined();
    expect(colorsOnly.marks.textSize).toBeUndefined();
    expect(colorsOnly.nodes.paragraph?.spec.attrs).toBeUndefined();

    const alignOnly = schemaFor(resolveTextTheme({ align: true }));
    expect(alignOnly.marks.textColor).toBeUndefined();
    expect(alignOnly.nodes.paragraph?.spec.attrs).toHaveProperty('textAlign');
  });
});

describe('the unlock marks and alignment parse only their own attributes', () => {
  const schema = schemaFor(FULL);

  it('reads a colour token from its data attributes', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-token': 'accent',
      }),
    ).toMatchObject({ token: 'accent' });
    expect(rulesOf(schema, 'marks', 'textColor')[0]?.tag).toBe(
      'span[data-pk-color]',
    );
  });

  it('reads a colour literal and a size literal', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-value': '#1d4ed8',
      }),
    ).toMatchObject({ value: '#1d4ed8' });
    expect(
      parseMark(schema, 'textSize', {
        'data-pk-size': '',
        'data-pk-size-value': '18px',
      }),
    ).toMatchObject({ value: '18px' });
  });

  it('never reads a style attribute', () => {
    // The tag selector does not match a bare styled span, and even a span that
    // carries the marker takes nothing from its style.
    expect(rulesOf(schema, 'marks', 'textColor')[0]?.tag).not.toContain(
      'style',
    );
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        style: 'color: red',
      }),
    ).toBe(false);
    expect(
      parseMark(schema, 'textSize', {
        'data-pk-size': '',
        style: 'font-size: 40px',
      }),
    ).toBe(false);
  });

  it('refuses a token that is not a token', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-token': 'a;b',
      }),
    ).toBe(false);
    expect(
      parseMark(schema, 'textSize', {
        'data-pk-size': '',
        'data-pk-size-token': 'Big',
      }),
    ).toBe(false);
  });

  it('refuses a token the theme does not list', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-token': 'hot-pink',
      }),
    ).toBe(false);
  });

  it('refuses a literal that is not a hex colour or a whole px size', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-value': 'red',
      }),
    ).toBe(false);
    expect(
      parseMark(schema, 'textSize', {
        'data-pk-size': '',
        'data-pk-size-value': '2em',
      }),
    ).toBe(false);
  });

  it('refuses both a token and a literal, and neither', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-token': 'accent',
        'data-pk-color-value': '#1d4ed8',
      }),
    ).toBe(false);
    expect(parseMark(schema, 'textColor', { 'data-pk-color': '' })).toBe(false);
  });

  it('ignores a plain token attribute that is not the data attribute', () => {
    expect(
      parseMark(schema, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-token': 'accent',
        token: 'text',
        value: '#000000',
      }),
    ).toMatchObject({ token: 'accent', value: null });
  });

  it('refuses a literal when the theme turns custom values off', () => {
    const strict = schemaFor(
      resolveTextTheme({
        colors: [{ label: 'Accent', token: 'accent' }],
        allowCustomValues: false,
      }),
    );
    expect(
      parseMark(strict, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-value': '#1d4ed8',
      }),
    ).toBe(false);
    expect(
      parseMark(strict, 'textColor', {
        'data-pk-color': '',
        'data-pk-color-token': 'accent',
      }),
    ).toMatchObject({ token: 'accent' });
  });

  it('reads alignment from data-pk-align and never from style', () => {
    expect(
      parseBlock(schema, 'paragraph', { 'data-pk-align': 'center' }),
    ).toMatchObject({ textAlign: 'center' });
    expect(
      parseBlock(schema, 'heading', { 'data-pk-align': 'right' }),
    ).toMatchObject({ textAlign: 'right' });
    const fromStyle = parseBlock(schema, 'paragraph', {
      style: 'text-align: center',
    });
    expect(fromStyle).not.toBe(false);
    expect(fromStyle || {}).not.toHaveProperty('textAlign');
    const outside = parseBlock(schema, 'paragraph', {
      'data-pk-align': 'justify',
    });
    expect(outside).not.toBe(false);
    expect(outside || {}).not.toHaveProperty('textAlign');
  });
});

describe('the unlock marks write only validated values', () => {
  const schema = schemaFor(FULL);
  const render = (name: string, attrs: Record<string, unknown>) => {
    const mark = schema.marks[name]?.create(attrs);
    return mark?.type.spec.toDOM?.(mark, true) as [
      string,
      Record<string, string>,
      0,
    ];
  };

  it('writes a token as a variable and a literal as the literal', () => {
    expect(render('textColor', { token: 'accent' })[1]).toMatchObject({
      'data-pk-color': '',
      'data-pk-color-token': 'accent',
      style: 'color: var(--color-accent)',
    });
    expect(render('textSize', { value: '18px' })[1]).toMatchObject({
      'data-pk-size': '',
      'data-pk-size-value': '18px',
      style: 'font-size: 18px',
    });
  });

  it('writes no style for a value that is not a token or a literal', () => {
    expect(render('textColor', { token: 'a;b' })[1]?.style).toBeUndefined();
    expect(
      render('textColor', { value: 'red; background: url(x)' })[1]?.style,
    ).toBeUndefined();
    expect(render('textSize', { value: '9999px' })[1]?.style).toBeUndefined();
  });
});

describe('the stored colour, size and alignment fixtures round-trip', () => {
  const NAMES = new Set([
    'aligned paragraph and heading',
    'colour by token',
    'colour by literal',
    'size by token',
    'size by literal at both bounds',
    'colour, size and link on one run',
    'tokens when custom values are off',
  ]);

  // The link mark belongs to a later plan; a stand-in with the stored
  // attributes lets the one fixture that carries a link run.
  const Link = Mark.create({
    name: 'link',
    addAttributes() {
      return {
        href: { default: null },
        pageId: { default: null },
        target: { default: null },
      };
    },
  });

  /**
   * ProseMirror writes `textAlign: null` on every paragraph of an alignment
   * schema and orders marks by schema rank; the stored form leaves a null
   * alignment out and the comparison is not about mark order.
   */
  function canonical(node: Json): Json {
    const copy: Json = { ...node };
    const attrs = copy.attrs as Record<string, unknown> | undefined;
    if (attrs !== undefined) {
      const kept = Object.fromEntries(
        Object.entries(attrs).filter(
          ([key, value]) => !(key === 'textAlign' && value === null),
        ),
      );
      if (Object.keys(kept).length === 0) delete copy.attrs;
      else copy.attrs = kept;
    }
    if (Array.isArray(copy.marks)) {
      copy.marks = [...(copy.marks as { type: string }[])].sort((a, b) =>
        a.type.localeCompare(b.type),
      );
    }
    if (Array.isArray(copy.content)) {
      copy.content = (copy.content as Json[]).map(canonical);
    }
    return copy;
  }

  const cases = fixtures.valid.filter((entry) => NAMES.has(entry.name));

  it('finds every fixture it is meant to cover', () => {
    expect(cases.map((entry) => entry.name).sort()).toEqual([...NAMES].sort());
  });

  for (const entry of cases) {
    it(`keeps ${entry.name}`, () => {
      const theme = resolveTextTheme(fixtures.themes[entry.theme]);
      const schema = schemaFor(theme, [Link]);
      const node = PMNode.fromJSON(schema, entry.doc);
      node.check();
      expect(canonical(node.toJSON() as Json)).toEqual(canonical(entry.doc));
    });
  }
});
