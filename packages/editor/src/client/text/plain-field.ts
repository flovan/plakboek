/**
 * The editing schema of a short text field: one line of plain text. No marks,
 * no nodes besides text, no line breaks, and a length cap counted in UTF-16
 * code units (what `String.length` and the server's zod `max` count), so a
 * value the editor lets through is a value the server accepts.
 *
 * The field element keeps its own tag (an `h2`, a `span`): the document is its
 * text and nothing wraps it.
 */
import { Extension, Node, type Extensions } from '@tiptap/core';
import { redo, undo, history } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * The server's cap for a short text without its own `maxLength` option. The
 * editor package does not depend on the content package's server entry, so the
 * number is repeated here; a property's own `maxLength` is always below it.
 */
export const PLAIN_TEXT_CAP = 1000;

/** A stored short text as an editor document. */
export type PlainDocument = {
  readonly type: 'doc';
  readonly content?: readonly {
    readonly type: 'text';
    readonly text: string;
  }[];
};

/** The document of a text; an empty text is an empty document. */
export function plainDocument(text: string): PlainDocument {
  return text === ''
    ? { type: 'doc' }
    : { type: 'doc', content: [{ type: 'text', text }] };
}

/** The text of a document (the editor's JSON, or the document of `plainDocument`). */
export function plainTextOf(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return '';
  const content: unknown = Reflect.get(doc, 'content');
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const node of content as unknown[]) {
    if (typeof node !== 'object' || node === null) continue;
    const value: unknown = Reflect.get(node, 'text');
    if (typeof value === 'string') text += value;
  }
  return text;
}

/**
 * The words of a formatted document as plain text, one line per block, for a
 * read-only preview. A button counts by its label; unknown nodes are walked
 * for the text they hold.
 */
export function documentText(doc: unknown): string {
  const lines: string[] = [];
  let line = '';
  const flush = (): void => {
    if (line !== '') lines.push(line);
    line = '';
  };
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const type: unknown = Reflect.get(node, 'type');
    const text: unknown = Reflect.get(node, 'text');
    if (typeof text === 'string') {
      line += text;
      return;
    }
    if (type === 'hardBreak') {
      flush();
      return;
    }
    if (type === 'cta') {
      const attrs: unknown = Reflect.get(node, 'attrs');
      const label: unknown =
        typeof attrs === 'object' && attrs !== null
          ? Reflect.get(attrs, 'label')
          : undefined;
      if (typeof label === 'string') line += label;
      return;
    }
    const content: unknown = Reflect.get(node, 'content');
    if (Array.isArray(content)) {
      for (const child of content as unknown[]) walk(child);
    }
    if (type !== 'doc') flush();
  };
  walk(doc);
  flush();
  return lines.join('\n');
}

const LINE_BREAKS = new RegExp('\\r\\n|[\\r\\n\\u2028\\u2029]', 'gu');

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A text as one line, cut to `max` UTF-16 code units: every line break becomes
 * one space, and a surrogate pair the cut would split is dropped whole rather
 * than left as a lone half.
 */
export function clampPlainText(text: string, max: number): string {
  const line = text.replace(LINE_BREAKS, ' ');
  if (max <= 0) return '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  const next = line.charCodeAt(max);
  return isHighSurrogate(last) && isLowSurrogate(next) ? cut.slice(0, -1) : cut;
}

export type PlainFieldHooks = {
  /** The property's `maxLength`; the server's cap when absent. */
  readonly maxLength?: number;
  /** Enter ends the session like Done. */
  readonly onEnter: () => void;
  /** Escape ends the session. */
  readonly onEscape: () => void;
};

/** The one text node of the schema. */
const PlainDocumentNode = Node.create({
  name: 'doc',
  topNode: true,
  content: 'text*',
});

const PlainTextNode = Node.create({
  name: 'text',
  group: 'inline',
});

const guardKey = new PluginKey('plainFieldGuard');

/** What a paste of `text` into the current selection adds: one line, within the room left. */
function pasteInto(view: EditorView, text: string, max: number): void {
  const { state } = view;
  const { from, to } = state.selection;
  const room = max - (state.doc.textContent.length - (to - from));
  const line = clampPlainText(text, room);
  if (line === '') return;
  view.dispatch(state.tr.insertText(line, from, to).scrollIntoView());
}

/**
 * The guard of the length cap and the paste rule. A transaction that grows the
 * text beyond the cap is refused; one that shrinks it is never refused, so a
 * stored value already over a lowered limit can still be cut down. A paste is
 * read as plain text whatever else the clipboard holds.
 */
export function plainFieldPlugin(max: number): Plugin {
  return new Plugin({
    key: guardKey,
    filterTransaction(transaction, state) {
      if (!transaction.docChanged) return true;
      const next = transaction.doc.textContent.length;
      return next <= max || next < state.doc.textContent.length;
    },
    props: {
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined || text === '') return false;
        pasteInto(view, text, max);
        return true;
      },
    },
  });
}

/**
 * The extension set of a short text field: text only, its own undo history,
 * Enter and Escape end the session, Shift+Enter does nothing, and the length
 * guard.
 */
export function buildPlainExtensions(hooks: PlainFieldHooks): Extensions {
  const max = Math.min(hooks.maxLength ?? PLAIN_TEXT_CAP, PLAIN_TEXT_CAP);
  const Behaviour = Extension.create({
    name: 'plainField',

    addKeyboardShortcuts() {
      return {
        // An Enter that confirms an input method's composition is not ours.
        Enter: ({ editor }) => {
          if (editor.view.composing) return false;
          hooks.onEnter();
          return true;
        },
        'Shift-Enter': () => true,
        Escape: () => {
          hooks.onEscape();
          return true;
        },
        'Mod-z': ({ editor }) =>
          undo(editor.state, editor.view.dispatch.bind(editor.view)),
        'Mod-y': ({ editor }) =>
          redo(editor.state, editor.view.dispatch.bind(editor.view)),
        'Shift-Mod-z': ({ editor }) =>
          redo(editor.state, editor.view.dispatch.bind(editor.view)),
      };
    },

    addProseMirrorPlugins() {
      return [history(), plainFieldPlugin(max)];
    },
  });
  return [PlainDocumentNode, PlainTextNode, Behaviour];
}
