import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSchema } from '@tiptap/core';
import { deleteSelection } from '@tiptap/pm/commands';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import { DEFAULT_TEXT_THEME } from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import {
  CTA_INSERTED,
  capLabel,
  caretAfterCta,
  insertCta,
  paragraphAfterCta,
  removeCta,
  selectedCta,
  updateCta,
} from '../../src/client/text/cta.js';
import { buildTextExtensions } from '../../src/client/text/extensions.js';
import {
  incompleteCtas,
  type JsonNode,
} from '../../src/client/text/style-runs.js';

const PAGE = '3f8d2a6e-1b4c-4d5e-9a7f-0c1b2d3e4f5a';
const VARIANTS = DEFAULT_TEXT_THEME.ctaVariants.map((entry) => entry.value);

const schema: Schema = getSchema(buildTextExtensions(DEFAULT_TEXT_THEME));

type Fixture = { name: string; theme: string; doc: JsonNode };

const fixtures = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../content/tests/fixtures/rich-text/shapes.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as { valid: Fixture[] }
).valid.filter(
  (fixture) =>
    fixture.theme === 'lean' && JSON.stringify(fixture.doc).includes('"cta"'),
);

const text = (value: string) => ({ type: 'text', text: value });
const para = (value?: string) => ({
  type: 'paragraph',
  ...(value === undefined ? {} : { content: [text(value)] }),
});
const cta = (attrs: Record<string, unknown> = {}) => ({
  type: 'cta',
  attrs: {
    label: 'Contact us',
    href: '/contact',
    pageId: null,
    target: null,
    variant: 'primary',
    ...attrs,
  },
});

function stateOf(
  content: unknown[],
  select?: (doc: PMNode) => number,
): EditorState {
  const doc = PMNode.fromJSON(schema, { type: 'doc', content });
  const base = EditorState.create({ schema, doc });
  if (select === undefined) return base;
  return base.apply(
    base.tr.setSelection(TextSelection.create(doc, select(doc))),
  );
}

/** Applies a command that dispatches a transaction. */
function run(
  state: EditorState,
  command: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean,
): EditorState {
  let next = state;
  const done = command(state, (tr) => {
    next = state.apply(tr);
  });
  expect(done).toBe(true);
  return next;
}

const typesOf = (state: EditorState): string[] => {
  const types: string[] = [];
  state.doc.forEach((node) => types.push(node.type.name));
  return types;
};

describe('the cta node of the schema', () => {
  const spec = schema.nodes['cta']?.spec;

  it('is a selectable atom block that stores exactly five attributes', () => {
    expect(spec?.atom).toBe(true);
    expect(spec?.selectable).toBe(true);
    expect(spec?.draggable).toBeFalsy();
    expect(spec?.group).toBe('block');
    expect(Object.keys(spec?.attrs ?? {})).toEqual([
      'label',
      'href',
      'pageId',
      'target',
      'variant',
    ]);
  });

  it('gives a new button the first variant of the theme', () => {
    const made = schema.nodes['cta']?.createAndFill();
    expect(made?.attrs['variant']).toBe('primary');
    expect(made?.attrs['label']).toBe('');
  });

  it('has no cta for a theme that does not name it', () => {
    const without = getSchema(
      buildTextExtensions({
        ...DEFAULT_TEXT_THEME,
        nodes: DEFAULT_TEXT_THEME.nodes.filter((name) => name !== 'cta'),
      }),
    );
    expect(without.nodes['cta']).toBeUndefined();
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture.doc] as const))(
    'reads the stored fixture "%s" back as the same document',
    (_name, doc) => {
      const node = PMNode.fromJSON(schema, doc);
      node.check();
      expect(node.toJSON()).toEqual(doc);
    },
  );

  it('fills the defaults of a stored button that omits its attributes', () => {
    const node = PMNode.fromJSON(schema, {
      type: 'doc',
      content: [{ type: 'cta', attrs: { label: 'Go', href: '/go' } }],
    });
    expect(node.firstChild?.attrs).toEqual({
      label: 'Go',
      href: '/go',
      pageId: null,
      target: null,
      variant: 'primary',
    });
  });

  it('has fixtures to compare (the filter is not vacuous)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  /** What the parse rule makes of an element with these attributes; false when it makes none. */
  function parse(attributes: Record<string, string>): unknown {
    const rule = spec?.parseDOM?.[0];
    const element = {
      getAttribute: (name: string): string | null => attributes[name] ?? null,
    };
    return rule?.getAttrs?.(element as never);
  }

  it('reads a pasted button from its data attributes only', () => {
    expect(spec?.parseDOM?.[0]?.tag).toBe('[data-pk-cta]');
    expect(
      parse({
        'data-label': 'Read more',
        'data-page-id': PAGE,
        'data-target': '_blank',
        'data-variant': 'secondary',
      }),
    ).toEqual({
      label: 'Read more',
      href: null,
      pageId: PAGE,
      target: '_blank',
      variant: 'secondary',
    });
  });

  it('refuses a script address and an unknown variant, and cuts a long label', () => {
    expect(
      parse({
        'data-label': 'x',
        'data-href': 'javascript:alert(1)',
        'data-variant': 'sneaky',
      }),
    ).toEqual({
      label: 'x',
      href: null,
      pageId: null,
      target: null,
      variant: 'primary',
    });
    const parsed = parse({ 'data-label': 'a'.repeat(300) }) as {
      label: string;
    };
    expect(parsed.label).toHaveLength(200);
  });

  it('writes only validated data attributes', () => {
    const node = PMNode.fromJSON(
      schema,
      cta({ href: '/contact', target: '_blank' }),
    );
    const [tag, attributes] = (schema.nodes['cta']?.spec.toDOM?.(node) ??
      []) as [string, Record<string, string>];
    expect(tag).toBe('div');
    expect(attributes).toEqual({
      'data-pk-cta': '',
      'data-label': 'Contact us',
      'data-href': '/contact',
      'data-target': '_blank',
      'data-variant': 'primary',
    });
    const hostile = PMNode.fromJSON(
      schema,
      cta({ href: 'javascript:alert(1)' }),
    );
    const [, written] = (schema.nodes['cta']?.spec.toDOM?.(hostile) ?? []) as [
      string,
      Record<string, string>,
    ];
    expect(written).not.toHaveProperty('data-href');
  });
});

describe('capLabel', () => {
  it('cuts at 200 UTF-16 code units and never splits a surrogate pair', () => {
    expect(capLabel('short')).toBe('short');
    expect(capLabel('a'.repeat(250))).toHaveLength(200);
    // the 200th unit would be the first half of a pair
    const cut = capLabel(`${'a'.repeat(199)}😀tail`);
    expect(cut).toBe('a'.repeat(199));
  });
});

describe('insertCta', () => {
  it('puts a button after a paragraph and keeps a paragraph below it', () => {
    const state = stateOf([para('Hello')], () => 6);
    const next = run(state, (s, d) => insertCta(s, d));
    expect(typesOf(next)).toEqual(['paragraph', 'cta', 'paragraph']);
    expect(next.doc.lastChild?.content.size).toBe(0);
    expect(next.doc.child(1).attrs).toMatchObject({
      href: null,
      pageId: null,
      target: null,
    });
    // selected, so its popover can open on it
    expect(selectedCta(next)?.node.type.name).toBe('cta');
  });

  it('takes the place of an empty paragraph', () => {
    const state = stateOf(
      [para('One'), para(), para('Two')],
      (doc) => doc.child(0).nodeSize + 1,
    );
    const next = run(state, (s, d) => insertCta(s, d));
    expect(typesOf(next)).toEqual(['paragraph', 'cta', 'paragraph']);
    expect(next.doc.lastChild?.textContent).toBe('Two');
  });

  it('is marked, so the field can open the popover for it', () => {
    const state = stateOf([para('Hello')], () => 6);
    let marked: unknown;
    insertCta(state, (tr) => {
      marked = tr.getMeta(CTA_INSERTED);
    });
    expect(typeof marked).toBe('number');
  });

  it('goes after the whole list when the caret is in a list item', () => {
    const list = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para('Item')] }],
    };
    const state = stateOf([list, para('After')], () => 4);
    const next = run(state, (s, d) => insertCta(s, d));
    expect(typesOf(next)).toEqual(['bulletList', 'cta', 'paragraph']);
  });

  it('adds nothing without a button in the schema', () => {
    const plain = getSchema(
      buildTextExtensions({
        ...DEFAULT_TEXT_THEME,
        nodes: DEFAULT_TEXT_THEME.nodes.filter((name) => name !== 'cta'),
      }),
    );
    const state = EditorState.create({
      schema: plain,
      doc: PMNode.fromJSON(plain, { type: 'doc', content: [para('Hi')] }),
    });
    expect(insertCta(state, () => undefined)).toBe(false);
  });
});

describe('with a button selected', () => {
  const selectedState = (): EditorState => {
    const state = stateOf([para('Above'), cta(), para('Below')]);
    const at = state.doc.child(0).nodeSize;
    return state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, at)),
    );
  };

  it('removes it on Backspace, as any selected block', () => {
    const next = run(selectedState(), (s, d) => deleteSelection(s, d));
    expect(typesOf(next)).toEqual(['paragraph', 'paragraph']);
  });

  it('removes it with removeCta, and an undo is the transaction before', () => {
    const state = selectedState();
    const tr = removeCta(state);
    expect(tr).not.toBeNull();
    expect(typesOf(state.apply(tr as Transaction))).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });

  it('starts a paragraph below on Enter and puts the caret in it', () => {
    const state = selectedState();
    const tr = paragraphAfterCta(state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr as Transaction);
    expect(typesOf(next)).toEqual([
      'paragraph',
      'cta',
      'paragraph',
      'paragraph',
    ]);
    expect(next.selection instanceof TextSelection).toBe(true);
    expect(next.selection.$from.parent.content.size).toBe(0);
  });

  it('moves the caret to the line below on Done', () => {
    const state = selectedState();
    const next = state.apply(caretAfterCta(state) as Transaction);
    expect(next.selection.$from.parent.textContent).toBe('Below');
  });

  it('does nothing of this for another selection', () => {
    const state = stateOf([para('Hello')], () => 2);
    expect(selectedCta(state)).toBeNull();
    expect(removeCta(state)).toBeNull();
    expect(paragraphAfterCta(state)).toBeNull();
    expect(caretAfterCta(state)).toBeNull();
  });

  it('changes the label, the variant and the target, and stays selected', () => {
    let state = selectedState();
    state = run(
      state,
      updateCta({ label: 'Read more', variant: 'secondary' }, VARIANTS),
    );
    state = run(
      state,
      updateCta({ href: null, pageId: PAGE, target: '_blank' }, VARIANTS),
    );
    expect(selectedCta(state)?.node.attrs).toEqual({
      label: 'Read more',
      href: null,
      pageId: PAGE,
      target: '_blank',
      variant: 'secondary',
    });
  });

  it('refuses a variant the theme does not list and a script address', () => {
    let state = selectedState();
    state = run(state, updateCta({ variant: 'sneaky' }, VARIANTS));
    expect(selectedCta(state)?.node.attrs['variant']).toBe('primary');
    state = run(
      state,
      updateCta(
        { href: 'javascript:alert(1)', pageId: null, target: null },
        VARIANTS,
      ),
    );
    expect(selectedCta(state)?.node.attrs['href']).toBe('/contact');
  });

  it('cuts a label over the cap', () => {
    const state = run(
      selectedState(),
      updateCta({ label: 'w'.repeat(300) }, VARIANTS),
    );
    expect(String(selectedCta(state)?.node.attrs['label']).length).toBe(200);
  });
});

describe('incompleteCtas', () => {
  const doc = (...content: unknown[]): JsonNode =>
    ({ type: 'doc', content }) as JsonNode;

  it('names what each unfinished button lacks, as its label span in the flattened text', () => {
    const found = incompleteCtas(
      doc(
        para('Hi '),
        cta({ label: 'Go', href: null }),
        cta({ label: '', href: null }),
        cta({ label: 'Done' }),
      ),
    );
    expect(found).toEqual([
      { start: 3, end: 5, lacks: 'link' },
      { start: 5, end: 5, lacks: 'label' },
    ]);
  });

  it('counts a label of spaces as missing', () => {
    expect(incompleteCtas(doc(cta({ label: '  ' })))).toEqual([
      { start: 0, end: 2, lacks: 'label' },
    ]);
  });

  it('finds none in a complete document', () => {
    expect(incompleteCtas(doc(para('x'), cta()))).toEqual([]);
  });
});
