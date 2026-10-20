import { getSchema } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { DEFAULT_TEXT_THEME } from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import { buildTextExtensions } from '../../src/client/text/extensions.js';
import {
  linkContext,
  linkTargetOf,
  linkTransaction,
  unlinkTransaction,
} from '../../src/client/text/link.js';

const PAGE = '3f8d2a6e-1b4c-4d5e-9a7f-0c1b2d3e4f5a';

const schema: Schema = getSchema(buildTextExtensions(DEFAULT_TEXT_THEME));

function doc(text: string, link?: Record<string, unknown>): PMNode {
  return PMNode.fromJSON(schema, {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Go ' },
          {
            type: 'text',
            text,
            ...(link === undefined
              ? {}
              : { marks: [{ type: 'link', attrs: link }] }),
          },
          { type: 'text', text: ' now' },
        ],
      },
    ],
  });
}

function stateOf(node: PMNode, from: number, to = from): EditorState {
  const base = EditorState.create({ schema, doc: node });
  return base.apply(base.tr.setSelection(TextSelection.create(node, from, to)));
}

/** "Go word now": the paragraph opens at 1, so `word` spans 4 to 8. */
const WORD = { from: 4, to: 8 };

const web = { href: 'https://example.com', pageId: null, target: null };

describe('the link mark of the schema', () => {
  const spec = schema.marks['link']?.spec;

  it('stores exactly href, pageId and target', () => {
    expect(Object.keys(spec?.attrs ?? {})).toEqual([
      'href',
      'pageId',
      'target',
    ]);
  });

  /** What the parse rule makes of an anchor with these attributes; false when it makes none. */
  function parse(attributes: Record<string, string>): unknown {
    const rule = spec?.parseDOM?.[0];
    const element = {
      getAttribute: (name: string): string | null => attributes[name] ?? null,
    };
    return rule?.getAttrs?.(element as unknown as HTMLElement);
  }

  it('reads a web address, a page id and a new tab from an anchor', () => {
    expect(parse({ href: 'https://example.com', target: '_blank' })).toEqual({
      href: 'https://example.com',
      pageId: null,
      target: '_blank',
    });
    expect(parse({ href: '#', 'data-pk-page': PAGE })).toEqual({
      href: null,
      pageId: PAGE,
      target: null,
    });
  });

  it('never makes a link from an address the policy refuses', () => {
    for (const href of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'ftp://example.com',
      '//example.com',
      'example.com',
    ]) {
      expect(parse({ href })).toBe(false);
    }
  });

  it('ignores a page id that is not a page id, and keeps nothing but the three attributes', () => {
    expect(parse({ 'data-pk-page': 'nope' })).toBe(false);
    expect(
      parse({
        href: 'https://example.com',
        rel: 'nofollow',
        class: 'c',
        title: 't',
      }),
    ).toEqual({ href: 'https://example.com', pageId: null, target: null });
  });

  function render(attrs: Record<string, unknown>): unknown {
    const mark = schema.marks['link']?.create(attrs);
    if (mark === undefined) throw new Error('no link mark');
    return spec?.toDOM?.(mark, true);
  }

  it('writes an address as an href, with rel for a new tab', () => {
    expect(render(web)).toEqual(['a', { href: 'https://example.com' }, 0]);
    expect(render({ ...web, target: '_blank' })).toEqual([
      'a',
      {
        href: 'https://example.com',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      0,
    ]);
  });

  it('writes a page link with its id and no navigation of its own', () => {
    expect(render({ href: null, pageId: PAGE, target: null })).toEqual([
      'a',
      { href: '#', 'data-pk-page': PAGE },
      0,
    ]);
  });

  it('writes no address the policy refuses', () => {
    expect(
      render({ href: 'javascript:alert(1)', pageId: null, target: null }),
    ).toEqual(['a', {}, 0]);
  });
});

describe('linkTargetOf', () => {
  it('prefers a page id, and reads nothing from an address the policy refuses', () => {
    expect(linkTargetOf({ href: 'https://a.b', pageId: PAGE })?.pageId).toBe(
      PAGE,
    );
    expect(linkTargetOf({ href: 'javascript:alert(1)', pageId: null })).toBe(
      null,
    );
    expect(linkTargetOf({ href: null, pageId: null })).toBeNull();
    expect(linkTargetOf(null)).toBeNull();
  });
});

describe('linkContext', () => {
  it('is a selection over selected text and a caret at a bare caret', () => {
    expect(linkContext(stateOf(doc('word'), WORD.from, WORD.to))).toEqual({
      kind: 'selection',
      ...WORD,
    });
    expect(linkContext(stateOf(doc('word'), 5))).toEqual({
      kind: 'caret',
      from: 5,
      to: 5,
    });
  });

  it('is the whole link while the selection lies inside one, ends included', () => {
    for (const [from, to] of [
      [5, 5],
      [4, 4],
      [8, 8],
      [5, 7],
    ] as const) {
      expect(linkContext(stateOf(doc('word', web), from, to))).toEqual({
        kind: 'edit',
        ...WORD,
        target: web,
      });
    }
  });

  it('applies over the selection when it reaches outside the link', () => {
    expect(linkContext(stateOf(doc('word', web), 2, 6))?.kind).toBe(
      'selection',
    );
  });
});

describe('linkTransaction', () => {
  const state = stateOf(doc('word'), WORD.from, WORD.to);

  it('puts the link on the selection and leaves the selection where it was', () => {
    const context = linkContext(state);
    if (context === null) throw new Error('no context');
    const tr = linkTransaction(state, context, web, null);
    if (tr === null) throw new Error('no transaction');
    const next = state.apply(tr);
    expect(next.doc.nodeAt(WORD.from)?.marks[0]?.attrs).toEqual(web);
    expect(next.doc.textContent).toBe('Go word now');
    expect([next.selection.from, next.selection.to]).toEqual([
      WORD.from,
      WORD.to,
    ]);
  });

  it('replaces the target of an existing link over its whole extent', () => {
    const linked = stateOf(doc('word', web), 5);
    const context = linkContext(linked);
    if (context === null) throw new Error('no context');
    const page = { href: null, pageId: PAGE, target: '_blank' as const };
    const tr = linkTransaction(linked, context, page, null);
    if (tr === null) throw new Error('no transaction');
    const next = linked.apply(tr);
    for (let at = WORD.from; at < WORD.to; at += 1) {
      expect(next.doc.nodeAt(at)?.marks[0]?.attrs).toEqual(page);
    }
    expect(next.doc.nodeAt(WORD.to)?.marks).toEqual([]);
  });

  it('at a bare caret inserts the title as linked text and ends the link there', () => {
    const caret = stateOf(doc('word'), 5);
    const context = linkContext(caret);
    if (context === null) throw new Error('no context');
    const tr = linkTransaction(caret, context, web, 'Our team');
    if (tr === null) throw new Error('no transaction');
    const next = caret.apply(tr);
    expect(next.doc.textContent).toBe('Go wOur teamord now');
    expect(next.doc.nodeAt(5)?.marks[0]?.attrs).toEqual(web);
    expect(next.selection.from).toBe(5 + 'Our team'.length);
    expect(
      next.selection.$from.marks().some((m) => m.type.name === 'link'),
    ).toBe(false);
  });

  it('at a bare caret with no title inserts the address', () => {
    const caret = stateOf(doc('word'), 5);
    const context = linkContext(caret);
    if (context === null) throw new Error('no context');
    const tr = linkTransaction(caret, context, web, null);
    expect(tr && caret.apply(tr).doc.textContent).toBe(
      'Go whttps://example.comord now',
    );
  });

  it('does nothing for a page with no title at a bare caret', () => {
    const caret = stateOf(doc('word'), 5);
    const context = linkContext(caret);
    if (context === null) throw new Error('no context');
    expect(
      linkTransaction(
        caret,
        context,
        { href: null, pageId: PAGE, target: null },
        null,
      ),
    ).toBeNull();
  });
});

describe('unlinkTransaction', () => {
  it('takes the link off its whole extent and nothing else', () => {
    const linked = stateOf(doc('word', web), 5);
    const context = linkContext(linked);
    if (context === null) throw new Error('no context');
    const tr = unlinkTransaction(linked, context);
    if (tr === null) throw new Error('no transaction');
    const next = linked.apply(tr);
    expect(
      next.doc.rangeHasMark(0, next.doc.content.size, schema.marks['link']!),
    ).toBe(false);
    expect(next.doc.textContent).toBe('Go word now');
  });

  it('has nothing to remove outside a link', () => {
    const plain = stateOf(doc('word'), 5);
    const context = linkContext(plain);
    if (context === null) throw new Error('no context');
    expect(unlinkTransaction(plain, context)).toBeNull();
  });
});
