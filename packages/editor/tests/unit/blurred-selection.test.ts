import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { DEFAULT_TEXT_THEME } from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import { blurredSelectionDecorations } from '../../src/client/text/blurred-selection.js';
import { buildTextExtensions } from '../../src/client/text/extensions.js';

const schema = getSchema(buildTextExtensions(DEFAULT_TEXT_THEME));

/** Two paragraphs; 'new' in the first is bold. Positions: p1 1..22, p2 24..30. */
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello brave ' },
        { type: 'text', text: 'new', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' world' },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
  ],
});

function stateWith(anchor: number, head: number): EditorState {
  const state = EditorState.create({ doc });
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, anchor, head)),
  );
}

describe('blurredSelectionDecorations', () => {
  it('draws nothing while the field has the focus', () => {
    expect(blurredSelectionDecorations(stateWith(7, 16), true).find()).toEqual(
      [],
    );
  });

  it('draws nothing for a caret', () => {
    expect(blurredSelectionDecorations(stateWith(7, 7), false).find()).toEqual(
      [],
    );
  });

  it('draws one inline decoration over exactly the selected range', () => {
    const [only, ...rest] = blurredSelectionDecorations(
      stateWith(7, 16),
      false,
    ).find();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ from: 7, to: 16 });
    const attributes = (
      only as unknown as { type: { attrs: Record<string, string> } }
    ).type.attrs;
    expect(attributes['data-pk-selection']).toBe('');
    expect(attributes['style']).toContain('background-color: Highlight');
    expect(attributes['style']).toContain('color: HighlightText');
  });

  it('keeps one decoration over a selection across a mark boundary and two paragraphs', () => {
    const marks = blurredSelectionDecorations(stateWith(7, 20), false).find();
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ from: 7, to: 20 });
    const paragraphs = blurredSelectionDecorations(
      stateWith(10, 27),
      false,
    ).find();
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toMatchObject({ from: 10, to: 27 });
  });
});
