/**
 * The commands behind the Custom style row: set and clear a colour or a size,
 * align the blocks a selection touches, and reset all of it in one step. They
 * are plain ProseMirror commands over `EditorState`, with no DOM, so they are
 * proven in Node. Every command reports false, and dispatches nothing, when
 * the schema lacks the mark or attribute (a theme without it) or when there
 * is nothing to change.
 *
 * A palette entry is stored as a token reference, a custom value as a
 * literal; a mark carries exactly one of the two.
 */
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import {
  isCustomColorValue,
  isCustomSizeValue,
  TOKEN_PATTERN,
  type TextAlign,
} from '@plakboek/content/rich-text';

export type TextStyleChoice = { token: string } | { value: string };

/**
 * What applies at the selection, from its first run: the colour and size as
 * the token or the literal stored (a token starts with a letter, a literal
 * with `#` or a digit), and the alignment of the first block touched.
 */
export type CustomStyle = {
  color: string | null;
  size: string | null;
  align: TextAlign | null;
};

type Touched = { pos: number; node: PMNode };

function markType(
  state: EditorState,
  name: 'textColor' | 'textSize',
): MarkType | undefined {
  return state.schema.marks[name];
}

function hasAlignAttribute(node: PMNode): boolean {
  return (
    node.isTextblock &&
    node.type.spec.attrs !== undefined &&
    'textAlign' in node.type.spec.attrs
  );
}

/** Every paragraph and heading the selection touches, once each, in order. */
function touchedBlocks(state: EditorState): Touched[] {
  const found = new Map<number, PMNode>();
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (hasAlignAttribute(node)) found.set(pos, node);
    });
  }
  return [...found].map(([pos, node]) => ({ pos, node }));
}

/** The marks that apply at a caret: the stored ones, else those around it. */
function caretMarks(state: EditorState) {
  return state.storedMarks ?? state.selection.$from.marks();
}

function selectionHasMark(state: EditorState, type: MarkType): boolean {
  if (state.selection.empty)
    return type.isInSet(caretMarks(state)) !== undefined;
  return state.selection.ranges.some((range) =>
    state.doc.rangeHasMark(range.$from.pos, range.$to.pos, type),
  );
}

function isValidChoice(
  choice: TextStyleChoice,
  isLiteral: (value: string) => boolean,
): boolean {
  if ('token' in choice) return TOKEN_PATTERN.test(choice.token);
  return isLiteral(choice.value);
}

function attrsOf(choice: TextStyleChoice) {
  return 'token' in choice
    ? { token: choice.token, value: null }
    : { token: null, value: choice.value };
}

function setStyleMark(
  name: 'textColor' | 'textSize',
  isLiteral: (value: string) => boolean,
  choice: TextStyleChoice,
): Command {
  return (state, dispatch) => {
    const type = markType(state, name);
    if (type === undefined || !isValidChoice(choice, isLiteral)) return false;
    if (dispatch !== undefined) {
      const mark = type.create(attrsOf(choice));
      const tr = state.tr;
      if (state.selection.empty) {
        tr.addStoredMark(mark);
      } else {
        for (const range of state.selection.ranges) {
          tr.addMark(range.$from.pos, range.$to.pos, mark);
        }
      }
      dispatch(tr);
    }
    return true;
  };
}

function removeStyleMark(tr: Transaction, state: EditorState, type: MarkType) {
  if (state.selection.empty) {
    tr.removeStoredMark(type);
    return;
  }
  for (const range of state.selection.ranges) {
    tr.removeMark(range.$from.pos, range.$to.pos, type);
  }
}

function clearStyleMark(name: 'textColor' | 'textSize'): Command {
  return (state, dispatch) => {
    const type = markType(state, name);
    if (type === undefined || !selectionHasMark(state, type)) return false;
    if (dispatch !== undefined) {
      const tr = state.tr;
      removeStyleMark(tr, state, type);
      dispatch(tr);
    }
    return true;
  };
}

/** Colour the selection (or what is typed next) with a palette token or a hex literal. */
export const setTextColor = (choice: TextStyleChoice): Command =>
  setStyleMark('textColor', isCustomColorValue, choice);

/** Size the selection (or what is typed next) with a palette token or a px literal. */
export const setTextSize = (choice: TextStyleChoice): Command =>
  setStyleMark('textSize', isCustomSizeValue, choice);

/** The "Theme default" choice for colour. */
export const clearTextColor: Command = clearStyleMark('textColor');

/** The "Theme default" choice for size. */
export const clearTextSize: Command = clearStyleMark('textSize');

/**
 * Align every paragraph and heading the selection touches. Pressing the
 * alignment every touched block already has clears it, and `null` clears it.
 */
export const setTextAlign =
  (align: TextAlign | null): Command =>
  (state, dispatch) => {
    const blocks = touchedBlocks(state);
    if (blocks.length === 0) return false;
    const target =
      align !== null &&
      blocks.every(({ node }) => node.attrs.textAlign === align)
        ? null
        : align;
    const changing = blocks.filter(
      ({ node }) => node.attrs.textAlign !== target,
    );
    if (changing.length === 0) return false;
    if (dispatch !== undefined) {
      const tr = state.tr;
      for (const { pos, node } of changing) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: target });
      }
      dispatch(tr);
    }
    return true;
  };

/** Whether any colour, size or alignment applies to the selection or caret. */
export function hasCustomStyle(state: EditorState): boolean {
  for (const name of ['textColor', 'textSize'] as const) {
    const type = markType(state, name);
    if (type !== undefined && selectionHasMark(state, type)) return true;
  }
  return touchedBlocks(state).some(({ node }) => node.attrs.textAlign != null);
}

/** What a mark stands for: its token, else its literal. */
function choiceOf(attrs: Record<string, unknown>): string | null {
  if (typeof attrs.token === 'string') return attrs.token;
  return typeof attrs.value === 'string' ? attrs.value : null;
}

/** The marks of the first text run in the selection, or at a caret. */
function firstRunMarks(state: EditorState) {
  if (state.selection.empty) return caretMarks(state);
  for (const range of state.selection.ranges) {
    let marks: PMNode['marks'] | null = null;
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
      if (marks !== null) return false;
      if (node.isText) marks = node.marks;
      return true;
    });
    if (marks !== null) return marks;
  }
  return [];
}

/** The colour, size and alignment of the first run and block, for the toolbar. */
export function currentCustomStyle(state: EditorState): CustomStyle {
  const marks = firstRunMarks(state);
  const attrsFor = (name: 'textColor' | 'textSize') => {
    const type = markType(state, name);
    return type === undefined ? undefined : type.isInSet(marks)?.attrs;
  };
  const color = attrsFor('textColor');
  const size = attrsFor('textSize');
  const align = touchedBlocks(state)[0]?.node.attrs.textAlign;
  return {
    color: color === undefined ? null : choiceOf(color),
    size: size === undefined ? null : choiceOf(size),
    align: typeof align === 'string' ? (align as TextAlign) : null,
  };
}

/**
 * Strip colour, size and alignment from the selection in one transaction, so
 * one undo brings it all back. Bold, italic, links and headings are left
 * alone. At a caret it clears the stored marks and the block's alignment.
 * Reports false when there is nothing to reset.
 */
export const resetStyle: Command = (state, dispatch) => {
  if (!hasCustomStyle(state)) return false;
  if (dispatch !== undefined) {
    const tr = state.tr;
    for (const name of ['textColor', 'textSize'] as const) {
      const type = markType(state, name);
      if (type !== undefined) removeStyleMark(tr, state, type);
    }
    for (const { pos, node } of touchedBlocks(state)) {
      if (node.attrs.textAlign != null) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: null });
      }
    }
    dispatch(tr);
  }
  return true;
};
