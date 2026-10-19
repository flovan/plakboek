import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSchema, Mark, type Extensions } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import {
  AllSelection,
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from '@tiptap/pm/state';
import {
  resolveTextTheme,
  type TextTheme,
  type TextThemeInput,
} from '@plakboek/content/rich-text';
import { describe, expect, it, vi } from 'vitest';
import { buildLockedExtensions } from '../../src/client/text/extensions.js';
import {
  clearTextColor,
  clearTextSize,
  currentCustomStyle,
  hasCustomStyle,
  resetStyle,
  setTextAlign,
  setTextColor,
  setTextSize,
} from '../../src/client/text/commands.js';
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

describe('the custom style commands', () => {
  const schema = schemaFor(FULL);

  const para = (
    attrs: Record<string, unknown> | null,
    ...content: PMNode[]
  ): PMNode => schema.node('paragraph', attrs, content);

  const heading = (attrs: Record<string, unknown>, ...content: PMNode[]) =>
    schema.node('heading', attrs, content);

  const run = (text: string, ...marks: [string, Record<string, unknown>?][]) =>
    schema.text(
      text,
      marks.map(([name, attrs]) => schema.marks[name]!.create(attrs)),
    );

  const docOf = (...blocks: PMNode[]) => schema.node('doc', null, blocks);

  /** The range of the first text node that contains `text`. */
  function rangeOf(doc: PMNode, text: string): { from: number; to: number } {
    let found: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (found === null && node.isText && node.text!.includes(text)) {
        const from = pos + node.text!.indexOf(text);
        found = { from, to: from + text.length };
      }
    });
    if (found === null) throw new Error(`no text "${text}" in the document`);
    return found;
  }

  function stateOf(doc: PMNode, from?: number, to?: number): EditorState {
    const state = EditorState.create({ schema, doc });
    if (from === undefined) return state;
    return state.apply(
      state.tr.setSelection(TextSelection.create(doc, from, to ?? from)),
    );
  }

  const selectText = (doc: PMNode, text: string): EditorState => {
    const { from, to } = rangeOf(doc, text);
    return stateOf(doc, from, to);
  };

  function stateOfAll(source: PMNode): EditorState {
    const state = EditorState.create({ schema, doc: source });
    return state.apply(state.tr.setSelection(new AllSelection(source)));
  }

  /** Run a command; `next` is the state after its single dispatch, if any. */
  function apply(command: Command, state: EditorState) {
    const dispatched: Transaction[] = [];
    const dispatch = vi.fn((tr: Transaction) => {
      dispatched.push(tr);
    });
    const handled = command(state, dispatch);
    return {
      handled,
      dispatch,
      next: dispatched.length > 0 ? state.apply(dispatched[0]!) : state,
    };
  }

  const marksOf = (doc: PMNode, text: string) => {
    let marks: readonly { type: { name: string }; attrs: Json }[] = [];
    doc.descendants((node) => {
      if (node.isText && node.text!.includes(text)) marks = node.marks;
    });
    return marks.map((mark) => ({ name: mark.type.name, attrs: mark.attrs }));
  };

  const aligns = (doc: PMNode): unknown[] => {
    const found: unknown[] = [];
    doc.descendants((node) => {
      if (node.isTextblock) found.push(node.attrs.textAlign);
    });
    return found;
  };

  describe('colour and size', () => {
    const doc = docOf(para(null, run('Hello')));

    it('stores a token reference for a palette entry', () => {
      const { handled, next } = apply(
        setTextColor({ token: 'accent' }),
        selectText(doc, 'Hello'),
      );
      expect(handled).toBe(true);
      expect(marksOf(next.doc, 'Hello')).toEqual([
        { name: 'textColor', attrs: { token: 'accent', value: null } },
      ]);
    });

    it('stores a literal for a custom value', () => {
      const { next } = apply(
        setTextColor({ value: '#1d4ed8' }),
        selectText(doc, 'Hello'),
      );
      expect(marksOf(next.doc, 'Hello')).toEqual([
        { name: 'textColor', attrs: { token: null, value: '#1d4ed8' } },
      ]);
    });

    it('replaces the colour instead of stacking a second one', () => {
      const first = apply(
        setTextColor({ token: 'accent' }),
        selectText(doc, 'Hello'),
      ).next;
      const reselected = stateOf(first.doc, 1, 6);
      const { next } = apply(setTextColor({ value: '#1d4ed8' }), reselected);
      expect(marksOf(next.doc, 'Hello')).toEqual([
        { name: 'textColor', attrs: { token: null, value: '#1d4ed8' } },
      ]);
    });

    it('removes the colour for Theme default', () => {
      const coloured = apply(
        setTextColor({ token: 'accent' }),
        selectText(doc, 'Hello'),
      ).next;
      expect(marksOf(coloured.doc, 'Hello')).toHaveLength(1);
      const { next } = apply(clearTextColor, stateOf(coloured.doc, 1, 6));
      expect(marksOf(next.doc, 'Hello')).toEqual([]);
    });

    it('stores a size by token and by literal and clears it', () => {
      const byLiteral = apply(
        setTextSize({ value: '18px' }),
        selectText(doc, 'Hello'),
      ).next;
      expect(marksOf(byLiteral.doc, 'Hello')).toEqual([
        { name: 'textSize', attrs: { token: null, value: '18px' } },
      ]);
      const byToken = apply(
        setTextSize({ token: 'xl' }),
        stateOf(byLiteral.doc, 1, 6),
      ).next;
      expect(marksOf(byToken.doc, 'Hello')).toEqual([
        { name: 'textSize', attrs: { token: 'xl', value: null } },
      ]);
      const cleared = apply(clearTextSize, stateOf(byToken.doc, 1, 6)).next;
      expect(marksOf(cleared.doc, 'Hello')).toEqual([]);
    });

    it('refuses a value that is not a token or a literal', () => {
      for (const command of [
        setTextColor({ token: 'a;b' }),
        setTextColor({ value: 'red' }),
        setTextSize({ value: '2em' }),
        setTextSize({ value: '9999px' }),
      ]) {
        const { handled, dispatch } = apply(command, selectText(doc, 'Hello'));
        expect(handled).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
      }
    });

    it('does nothing in a schema that has no such mark', () => {
      const lean = getSchema(buildLockedExtensions());
      const state = EditorState.create({
        schema: lean,
        doc: lean.node('doc', null, [
          lean.node('paragraph', null, [lean.text('Hello')]),
        ]),
      });
      const selected = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, 1, 6)),
      );
      for (const command of [
        setTextColor({ token: 'accent' }),
        setTextSize({ token: 'xl' }),
        clearTextColor,
        setTextAlign('center'),
        resetStyle,
      ]) {
        expect(apply(command, selected).handled).toBe(false);
      }
    });

    it('stores the choice for what is typed next when the selection is a caret', () => {
      const { handled, next } = apply(
        setTextColor({ token: 'accent' }),
        stateOf(doc, 3),
      );
      expect(handled).toBe(true);
      expect(next.doc.eq(doc)).toBe(true);
      expect(next.storedMarks?.map((mark) => mark.type.name)).toEqual([
        'textColor',
      ]);
    });
  });

  describe('alignment', () => {
    const doc = docOf(
      para(null, run('One')),
      heading({ level: 2 }, run('Two')),
      para(null, run('Three')),
      para(null, run('Four')),
    );

    it('sets every paragraph and heading the selection touches', () => {
      const from = rangeOf(doc, 'One').from + 1;
      const to = rangeOf(doc, 'Three').from + 1;
      const { next } = apply(setTextAlign('center'), stateOf(doc, from, to));
      expect(aligns(next.doc)).toEqual(['center', 'center', 'center', null]);
    });

    it('clears them for null', () => {
      const centred = apply(setTextAlign('center'), stateOfAll(doc)).next;
      expect(aligns(centred.doc)).toEqual([
        'center',
        'center',
        'center',
        'center',
      ]);
      const { next } = apply(setTextAlign(null), stateOfAll(centred.doc));
      expect(aligns(next.doc)).toEqual([null, null, null, null]);
    });

    it('clears the active alignment when it is pressed again', () => {
      const state = stateOf(doc, rangeOf(doc, 'Four').from);
      const right = apply(setTextAlign('right'), state).next;
      expect(aligns(right.doc)).toEqual([null, null, null, 'right']);
      const { next } = apply(
        setTextAlign('right'),
        stateOf(right.doc, rangeOf(right.doc, 'Four').from),
      );
      expect(aligns(next.doc)).toEqual([null, null, null, null]);
    });

    it('aligns only the block holding a caret', () => {
      const { next } = apply(
        setTextAlign('left'),
        stateOf(doc, rangeOf(doc, 'Two').from),
      );
      expect(aligns(next.doc)).toEqual([null, 'left', null, null]);
    });
  });

  describe('Reset style', () => {
    const styled = () =>
      docOf(
        para(
          { textAlign: 'center' },
          run('Plain '),
          run('red', ['textColor', { token: 'accent' }]),
          run(' and '),
          run('big', ['textSize', { value: '18px' }], ['bold']),
        ),
        heading({ level: 2, textAlign: 'right' }, run('Title', ['bold'])),
        para(null, run('Tail')),
      );

    it('strips colour, size and alignment and keeps bold and the heading, in one step', () => {
      const { handled, dispatch, next } = apply(
        resetStyle,
        stateOfAll(styled()),
      );
      expect(handled).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(marksOf(next.doc, 'red')).toEqual([]);
      expect(marksOf(next.doc, 'big')).toEqual([{ name: 'bold', attrs: {} }]);
      expect(aligns(next.doc)).toEqual([null, null, null]);
      expect(next.doc.child(1).type.name).toBe('heading');
      expect(next.doc.child(1).attrs.level).toBe(2);
      expect(marksOf(next.doc, 'Title')).toEqual([{ name: 'bold', attrs: {} }]);
    });

    it('resets only what the selection touches', () => {
      const doc = styled();
      const { next } = apply(resetStyle, selectText(doc, 'red'));
      expect(marksOf(next.doc, 'red')).toEqual([]);
      expect(marksOf(next.doc, 'big').map((mark) => mark.name)).toEqual([
        'textSize',
        'bold',
      ]);
      // The selection sits in the first paragraph, so its alignment goes too.
      expect(aligns(next.doc)).toEqual([null, 'right', null]);
    });

    it('reports false and dispatches nothing when there is nothing to reset', () => {
      const plain = docOf(para(null, run('Plain', ['bold'])));
      const { handled, dispatch } = apply(resetStyle, stateOfAll(plain));
      expect(handled).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('clears the stored colour at a caret', () => {
      const doc = docOf(para(null, run('Plain')));
      const withStored = apply(
        setTextColor({ token: 'accent' }),
        stateOf(doc, 3),
      ).next;
      expect(hasCustomStyle(withStored)).toBe(true);
      const { handled, next } = apply(resetStyle, withStored);
      expect(handled).toBe(true);
      expect(next.storedMarks?.map((mark) => mark.type.name) ?? []).toEqual([]);
      expect(hasCustomStyle(next)).toBe(false);
    });
  });

  describe('the current custom style', () => {
    const doc = docOf(
      para(
        null,
        run('lead ', ['textColor', { token: 'accent' }]),
        run('sized', ['textSize', { value: '18px' }]),
        run(' plain'),
      ),
      heading({ level: 3, textAlign: 'right' }, run('Title')),
    );

    it('reads the first run of a selection', () => {
      const from = rangeOf(doc, 'lead').from;
      const to = rangeOf(doc, 'plain').to;
      const state = stateOf(doc, from, to);
      expect(currentCustomStyle(state)).toEqual({
        color: 'accent',
        size: null,
        align: null,
      });
      expect(hasCustomStyle(state)).toBe(true);
    });

    it('reports a literal as the literal', () => {
      expect(currentCustomStyle(selectText(doc, 'sized'))).toEqual({
        color: null,
        size: '18px',
        align: null,
      });
    });

    it('reads the alignment of the first block touched', () => {
      expect(currentCustomStyle(selectText(doc, 'Title'))).toEqual({
        color: null,
        size: null,
        align: 'right',
      });
    });

    it('reports no custom style on plain text', () => {
      const state = selectText(doc, 'plain');
      expect(hasCustomStyle(state)).toBe(false);
      expect(currentCustomStyle(state)).toEqual({
        color: null,
        size: null,
        align: null,
      });
    });

    it('reads the marks at a caret', () => {
      const state = stateOf(doc, rangeOf(doc, 'lead').from + 2);
      expect(currentCustomStyle(state).color).toBe('accent');
    });
  });
});
