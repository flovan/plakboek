import { describe, expect, it } from 'vitest';
import {
  customStyleRuns,
  flattenedText,
  type JsonNode,
} from '../../src/client/text/style-runs.js';

const text = (value: string, marks: readonly string[] = []): JsonNode => ({
  type: 'text',
  text: value,
  ...(marks.length === 0 ? {} : { marks: marks.map((type) => ({ type })) }),
});

const paragraph = (
  content: readonly JsonNode[],
  textAlign?: string,
): JsonNode => ({
  type: 'paragraph',
  ...(textAlign === undefined ? {} : { attrs: { textAlign } }),
  content,
});

const doc = (...content: JsonNode[]): JsonNode => ({ type: 'doc', content });

describe('flattenedText', () => {
  it('joins the text of every block with nothing between them', () => {
    expect(
      flattenedText(
        doc(
          paragraph([text('One '), text('two', ['bold'])]),
          paragraph([text('three')]),
        ),
      ),
    ).toBe('One twothree');
  });

  it('counts a hard break as no text', () => {
    expect(
      flattenedText(
        doc(paragraph([text('a'), { type: 'hardBreak' }, text('b')])),
      ),
    ).toBe('ab');
  });

  it('counts the label of a button as text', () => {
    expect(
      flattenedText(
        doc(paragraph([text('Go')]), {
          type: 'cta',
          attrs: { label: 'Sign up', variant: 'primary' },
        }),
      ),
    ).toBe('GoSign up');
  });

  it('is empty for an empty document', () => {
    expect(flattenedText(doc())).toBe('');
    expect(flattenedText({ type: 'doc' })).toBe('');
  });
});

describe('customStyleRuns', () => {
  it('lists a coloured or sized run by its offsets in the flattened text', () => {
    const runs = customStyleRuns(
      doc(
        paragraph([
          text('Make the '),
          text('word', ['textColor']),
          text(' bigger and '),
          text('bigger', ['textSize']),
        ]),
      ),
    );
    expect(runs).toEqual([
      { kind: 'style', start: 9, end: 13 },
      { kind: 'style', start: 25, end: 31 },
    ]);
  });

  it('merges adjacent runs with custom style into one', () => {
    const runs = customStyleRuns(
      doc(
        paragraph([
          text('ab', ['textColor']),
          text('cd', ['textColor', 'textSize']),
          text('ef', ['bold', 'textSize']),
          text('gh'),
        ]),
      ),
    );
    expect(runs).toEqual([{ kind: 'style', start: 0, end: 6 }]);
  });

  it('does not treat bold, italic or a link as custom style', () => {
    expect(
      customStyleRuns(
        doc(paragraph([text('a', ['bold']), text('b', ['italic', 'link'])])),
      ),
    ).toEqual([]);
  });

  it('lists an aligned paragraph or heading as its own span, before the runs inside it', () => {
    const runs = customStyleRuns(
      doc(
        paragraph([text('plain')]),
        paragraph([text('centre '), text('red', ['textColor'])], 'center'),
        {
          type: 'heading',
          attrs: { level: 3, textAlign: 'right' },
          content: [text('Head')],
        },
      ),
    );
    expect(runs).toEqual([
      { kind: 'align', start: 5, end: 15 },
      { kind: 'style', start: 12, end: 15 },
      { kind: 'align', start: 15, end: 19 },
    ]);
  });

  it('does not merge a style run into the next block', () => {
    const runs = customStyleRuns(
      doc(
        paragraph([text('end', ['textColor'])]),
        paragraph([text('start', ['textColor'])]),
      ),
    );
    expect(runs).toEqual([
      { kind: 'style', start: 0, end: 3 },
      { kind: 'style', start: 3, end: 8 },
    ]);
  });

  it('ignores an empty aligned paragraph and a null or unknown alignment', () => {
    expect(
      customStyleRuns(
        doc(paragraph([], 'center'), paragraph([text('x')], 'justify')),
      ),
    ).toEqual([]);
    expect(
      customStyleRuns(
        doc({
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [text('x')],
        }),
      ),
    ).toEqual([]);
  });

  it('counts the label of a button toward the offsets after it', () => {
    const runs = customStyleRuns(
      doc(
        { type: 'cta', attrs: { label: 'Go' } },
        paragraph([text('after', ['textSize'])]),
      ),
    );
    expect(runs).toEqual([{ kind: 'style', start: 2, end: 7 }]);
  });

  it('returns an empty list for a document with none', () => {
    expect(customStyleRuns(doc(paragraph([text('plain')])))).toEqual([]);
    expect(customStyleRuns(doc())).toEqual([]);
  });
});
