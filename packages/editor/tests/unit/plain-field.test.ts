import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, it } from 'vitest';
import {
  buildPlainExtensions,
  clampPlainText,
  documentText,
  plainDocument,
  plainFieldPlugin,
  plainTextOf,
} from '../../src/client/text/plain-field.js';

const noop = (): void => undefined;
const schema = getSchema(
  buildPlainExtensions({ onEnter: noop, onEscape: noop }),
);

function stateWith(text: string, max: number): EditorState {
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON(plainDocument(text)),
    plugins: [plainFieldPlugin(max)],
  });
}

/** Applies a transaction the way the view does, filters included. */
function apply(
  state: EditorState,
  make: (tr: Transaction) => Transaction,
): EditorState {
  return state.applyTransaction(make(state.tr)).state;
}

describe('the plain document', () => {
  it('round-trips a text through its document', () => {
    expect(plainTextOf(plainDocument('Hi'))).toBe('Hi');
    expect(plainTextOf(schema.nodeFromJSON(plainDocument('Hi')).toJSON())).toBe(
      'Hi',
    );
  });

  it('gives an empty document for an empty text', () => {
    expect(plainDocument('')).toEqual({ type: 'doc' });
    expect(plainTextOf(plainDocument(''))).toBe('');
    expect(plainTextOf(null)).toBe('');
  });

  it('allows text and nothing else', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(['doc', 'text']);
    expect(Object.keys(schema.marks)).toEqual([]);
  });
});

describe('clampPlainText', () => {
  it('turns every kind of line break into one space', () => {
    expect(clampPlainText('a\nb\r\nc', 10)).toBe('a b c');
    expect(clampPlainText(`a\rb${String.fromCodePoint(0x2028)}c`, 10)).toBe(
      'a b c',
    );
  });

  it('cuts to the limit in UTF-16 code units', () => {
    expect(clampPlainText('abcdef', 4)).toBe('abcd');
    expect(clampPlainText('abc', 4)).toBe('abc');
    expect(clampPlainText('abc', 0)).toBe('');
    expect(clampPlainText('abc', -3)).toBe('');
  });

  it('counts a surrogate pair as two units and never leaves half of one', () => {
    const pair = '\u{1F600}';
    expect(pair.length).toBe(2);
    expect(clampPlainText(`a${pair}b`, 3)).toBe(`a${pair}`);
    // the cut falls inside the pair: the whole pair goes
    expect(clampPlainText(`a${pair}b`, 2)).toBe('a');
    expect(clampPlainText(`${pair}${pair}`, 3)).toBe(pair);
  });
});

describe('the length guard', () => {
  it('refuses a transaction that grows the text beyond the limit', () => {
    const state = stateWith('abc', 4);
    const next = apply(state, (tr) => tr.insertText('XY', 3));
    expect(next.doc.textContent).toBe('abc');
  });

  it('lets a change that stays at or under the limit through', () => {
    const state = stateWith('abc', 4);
    expect(apply(state, (tr) => tr.insertText('Z', 3)).doc.textContent).toBe(
      'abcZ',
    );
    expect(
      apply(state, (tr) => tr.insertText('ZZ', 1, 3)).doc.textContent,
    ).toBe('aZZ');
  });

  it('counts UTF-16 code units, as the server does', () => {
    const state = stateWith('abc', 4);
    // one emoji is two units: 3 + 2 is 5, above the limit of 4
    expect(
      apply(state, (tr) => tr.insertText('\u{1F600}', 3)).doc.textContent,
    ).toBe('abc');
  });

  it('never refuses a change that shortens a value already over the limit', () => {
    const state = stateWith('abcdefgh', 4);
    const shorter = apply(state, (tr) => tr.delete(0, 2));
    expect(shorter.doc.textContent).toBe('cdefgh');
    const longer = apply(shorter, (tr) => tr.insertText('XX', 0));
    expect(longer.doc.textContent).toBe('cdefgh');
  });
});

describe('pasting', () => {
  function view(state: EditorState): { view: EditorView; text: () => string } {
    let current = state;
    const fake = {
      get state() {
        return current;
      },
      dispatch(tr: Transaction) {
        current = current.applyTransaction(tr).state;
      },
    } as unknown as EditorView;
    return { view: fake, text: () => current.doc.textContent };
  }

  function paste(
    state: EditorState,
    text: string,
    max: number,
  ): { handled: boolean; text: string } {
    const held = view(state);
    const handler = plainFieldPlugin(max).props.handlePaste;
    if (handler === undefined) throw new Error('The plugin has no paste rule');
    const event = {
      clipboardData: { getData: () => text },
    } as unknown as ClipboardEvent;
    const handled = handler.call(
      plainFieldPlugin(max),
      held.view,
      event,
      null as never,
    );
    return { handled: handled === true, text: held.text() };
  }

  it('makes a multi-line paste one line', () => {
    const state = stateWith('', 50);
    expect(paste(state, 'one\ntwo\r\nthree', 50)).toEqual({
      handled: true,
      text: 'one two three',
    });
  });

  it('cuts the paste to the room left', () => {
    const base = stateWith('abc', 6);
    const caret = apply(base, (tr) =>
      tr.setSelection(TextSelection.create(tr.doc, 3)),
    );
    expect(paste(caret, 'XYZW', 6).text).toBe('abcXYZ');
  });

  it('replaces the selection and counts the room it frees', () => {
    const base = stateWith('abcdef', 6);
    const selected = apply(base, (tr) =>
      tr.setSelection(TextSelection.create(tr.doc, 1, 4)),
    );
    expect(paste(selected, '12345', 6).text).toBe('a123ef');
  });

  it('leaves a clipboard with no plain text to the editor', () => {
    expect(paste(stateWith('', 10), '', 10).handled).toBe(false);
  });
});

describe('documentText', () => {
  const p = (...content: unknown[]) => ({ type: 'paragraph', content });
  const t = (text: string) => ({ type: 'text', text });

  it('gives one line per block and keeps the words of marked text together', () => {
    expect(
      documentText({
        type: 'doc',
        content: [
          p(t('Hello '), { ...t('bold'), marks: [{ type: 'bold' }] }),
          { type: 'heading', content: [t('Next')] },
        ],
      }),
    ).toBe('Hello bold\nNext');
  });

  it('breaks a line at a hard break and walks lists', () => {
    expect(
      documentText({
        type: 'doc',
        content: [
          p(t('a'), { type: 'hardBreak' }, t('b')),
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [p(t('one'))] }],
          },
        ],
      }),
    ).toBe('a\nb\none');
  });

  it('reads a button by its label and anything that is not a document as empty', () => {
    expect(
      documentText({
        type: 'doc',
        content: [{ type: 'cta', attrs: { label: 'Buy now' } }],
      }),
    ).toBe('Buy now');
    expect(documentText(undefined)).toBe('');
    expect(documentText('text')).toBe('');
    expect(documentText({ type: 'doc' })).toBe('');
  });
});
