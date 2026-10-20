/**
 * Where a rich text field carries custom style, for the edit-mode marker: a
 * run of text with a colour or size mark, or a paragraph or heading with an
 * alignment. Two views of the same fact:
 *
 * - `customStyleRuns(doc)` works on a stored document and answers in offsets
 *   into the field's flattened text (the text nodes, and a button's label,
 *   concatenated the way a renderer emits them). `rangesForRuns` turns those
 *   offsets into DOM ranges over the field's rendered text, and only when that
 *   text equals `flattenedText(doc)`, so a host renderer that adds text of its
 *   own can never produce a marker in the wrong place: it gets none.
 * - `customStylePositions(doc)` works on the live editor's document and
 *   answers in its positions, which `rangesForPositions` maps through the
 *   view, so an active field is always exact.
 *
 * Nothing here draws or touches the page.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { TEXT_ALIGNS } from '@plakboek/content/rich-text';

/** The structural shape of a stored document node. */
export type JsonNode = {
  readonly type?: string;
  readonly text?: string;
  readonly marks?: readonly {
    readonly type?: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  }[];
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly JsonNode[];
};

export type StyleRunKind = 'style' | 'align';

/** A run of the field's flattened text, `[start, end)`. */
export type StyleRun = {
  readonly kind: StyleRunKind;
  readonly start: number;
  readonly end: number;
};

/** A run in the live editor's document positions, `[from, to)`. */
export type PositionRun = {
  readonly kind: StyleRunKind;
  readonly from: number;
  readonly to: number;
};

const STYLE_MARKS: ReadonlySet<string> = new Set(['textColor', 'textSize']);
const ALIGNED_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading']);

function isAlign(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (TEXT_ALIGNS as readonly string[]).includes(value)
  );
}

/** What a node adds to the flattened text: its text, or a button's label. */
function ownText(node: JsonNode): string | null {
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'cta') {
    const label = node.attrs?.['label'];
    return typeof label === 'string' ? label : '';
  }
  return null;
}

/** The text a renderer emits for the document: no separators, no hard breaks. */
export function flattenedText(doc: JsonNode): string {
  const own = ownText(doc);
  if (own !== null) return own;
  return (doc.content ?? []).map(flattenedText).join('');
}

/**
 * The runs of custom style in a stored document, in document order: each text
 * run carrying a colour or size mark (adjacent ones merged), and each aligned
 * paragraph or heading as its own span, listed before the runs inside it. A
 * block with no text has no span to mark.
 */
export function customStyleRuns(doc: JsonNode): readonly StyleRun[] {
  const runs: StyleRun[] = [];
  let offset = 0;
  let blocks = 0;
  /** The block the last style run was in: runs merge only within one block. */
  let lastBlock = -1;

  const walk = (node: JsonNode, block: number): void => {
    const own = ownText(node);
    if (own !== null) {
      const start = offset;
      offset += own.length;
      const custom = (node.marks ?? []).some(
        (mark) => mark.type !== undefined && STYLE_MARKS.has(mark.type),
      );
      if (!custom || own.length === 0) return;
      const last = runs.at(-1);
      if (
        last !== undefined &&
        last.kind === 'style' &&
        last.end === start &&
        lastBlock === block
      ) {
        runs[runs.length - 1] = { ...last, end: offset };
      } else {
        runs.push({ kind: 'style', start, end: offset });
      }
      lastBlock = block;
      return;
    }
    const aligned =
      node.type !== undefined &&
      ALIGNED_BLOCKS.has(node.type) &&
      isAlign(node.attrs?.['textAlign']);
    const start = offset;
    const at = runs.length;
    blocks += 1;
    const mine = blocks;
    for (const child of node.content ?? []) walk(child, mine);
    if (aligned && offset > start) {
      runs.splice(at, 0, { kind: 'align', start, end: offset });
    }
  };

  walk(doc, 0);
  return runs;
}

/**
 * The same runs in the live editor's positions: text with a colour or size
 * mark (adjacent ones merged) and aligned paragraphs and headings that hold
 * text.
 */
export function customStylePositions(doc: PMNode): readonly PositionRun[] {
  const runs: PositionRun[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const custom = node.marks.some((mark) => STYLE_MARKS.has(mark.type.name));
      if (!custom) return false;
      const to = pos + node.nodeSize;
      const last = runs.at(-1);
      if (last !== undefined && last.kind === 'style' && last.to === pos) {
        runs[runs.length - 1] = { ...last, to };
      } else {
        runs.push({ kind: 'style', from: pos, to });
      }
      return false;
    }
    if (
      ALIGNED_BLOCKS.has(node.type.name) &&
      isAlign(node.attrs['textAlign']) &&
      node.content.size > 0
    ) {
      runs.push({
        kind: 'align',
        from: pos + 1,
        to: pos + 1 + node.content.size,
      });
    }
    return true;
  });
  // An aligned block is listed before the runs inside it.
  return runs.toSorted(
    (a, b) =>
      a.from - b.from || (a.kind === b.kind ? 0 : a.kind === 'align' ? -1 : 1),
  );
}

/** One run as a DOM range over the field's rendered text. */
export type MarkedRange = {
  readonly kind: StyleRunKind;
  readonly range: Range;
};

const SHOW_TEXT = 4;

/**
 * DOM ranges for stored-document runs, found by walking the field's text
 * nodes in order. Only when their text equals `flattenedText(doc)` is the
 * mapping trusted; a field whose rendered text differs (a host renderer that
 * adds its own) gets no ranges at all.
 */
export function rangesForRuns(
  field: Element,
  doc: JsonNode,
  runs: readonly StyleRun[],
): MarkedRange[] {
  if (runs.length === 0) return [];
  const owner = field.ownerDocument;
  const walker = owner.createTreeWalker(field, SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let total = 0;
  let text = '';
  for (let at = walker.nextNode(); at !== null; at = walker.nextNode()) {
    const node = at as Text;
    nodes.push({ node, start: total });
    total += node.data.length;
    text += node.data;
  }
  if (text !== flattenedText(doc)) return [];

  const locate = (
    offset: number,
    preferEnd: boolean,
  ): [Text, number] | null => {
    for (const entry of nodes) {
      const end = entry.start + entry.node.data.length;
      const inside = preferEnd
        ? offset > entry.start && offset <= end
        : offset >= entry.start && offset < end;
      if (inside) return [entry.node, offset - entry.start];
    }
    return null;
  };

  const found: MarkedRange[] = [];
  for (const run of runs) {
    const from = locate(run.start, false);
    const to = locate(run.end, true);
    if (from === null || to === null) continue;
    const range = owner.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    found.push({ kind: run.kind, range });
  }
  return found;
}

/** DOM ranges for live-editor runs, through the view: always exact. */
export function rangesForPositions(
  view: EditorView,
  runs: readonly PositionRun[],
): MarkedRange[] {
  const found: MarkedRange[] = [];
  for (const run of runs) {
    try {
      const from = view.domAtPos(run.from);
      const to = view.domAtPos(run.to);
      const range = view.dom.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      found.push({ kind: run.kind, range });
    } catch {
      // A position the view cannot place yet; the next pass finds it.
    }
  }
  return found;
}
