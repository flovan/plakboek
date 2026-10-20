/**
 * The life of one rich text field session: enter (TipTap mounts on the site's
 * own field element), update (every change is previewed and queued through the
 * one write path as a coalesced edit), exit (flush, restore, hand back).
 *
 * The editor is mounted on the field element itself without TipTap's stylesheet,
 * so the site's markup, classes and attributes stay and no stylesheet reaches
 * either document. While a session runs the block carries the inline-edit
 * mark, so the server's render of the block waits until the session ends and
 * never replaces the element under the caret.
 *
 * A session ends on Escape, Done, a click elsewhere, a different selection, a
 * structural action, an undo or redo, a frame reload and lock loss. Never on
 * blur alone. Every ending flushes the pending save first.
 */
import { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import {
  isEmptyRichTextDocument,
  isRichTextDocumentInTheme,
  stripOutOfTheme,
} from '@plakboek/content/rich-text';
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { DEFAULT_TEXT_RENDERERS, type TextRenderers } from '@plakboek/render';
import { formatString } from '../../chrome/strings.js';
import type { EditorStore } from '../session/store.js';
import { textOf } from '../session/selection-announcement.js';
import { labelOf } from '../session/tree-model.js';
import { hasPending } from '../session/save-queue.js';
import { beginInlineEdit, endInlineEdit } from '../frame/patch.js';
import { buildTextExtensions } from './extensions.js';
import { cleanPastedHtml, pasteLostFormatting } from './paste.js';
import { createRendererShells, type RendererShells } from './shells.js';
import { findEditableField, type FieldTarget } from './field-target.js';
import {
  cleanChildren,
  restoreField,
  snapshotField,
  type FieldSnapshot,
} from './field-snapshot.js';

export type TextExitReason =
  | 'escape'
  | 'done'
  | 'click'
  | 'selection'
  | 'structure'
  | 'undo'
  | 'reload'
  | 'lock';

export type TextControllerOptions = {
  readonly store: EditorStore;
  /** Writes the property's candidate value: previews it, then queues the save. */
  readonly changeProperties: (
    blockId: string,
    values: Readonly<Record<string, unknown>>,
    changedKey: string,
    immediate: boolean,
  ) => Promise<unknown>;
  /** Sends what is queued for the block now (the blur flush). */
  readonly ready: (blockId: string) => void;
  /** Puts keyboard focus on the page region. */
  readonly focusRegion: () => void;
  readonly announce: (text: string) => void;
  /**
   * The host's renderer map; the field is edited in node views derived from it
   * so it keeps the host's own markup. The default map when the host has none.
   */
  readonly renderers?: TextRenderers;
};

export type TextController = {
  /**
   * Starts a session on the field, ending a running one first. The caret goes
   * to `point` (frame viewport coordinates) when the editor finds a position
   * there, else to the end of the field.
   */
  enter(target: FieldTarget, point?: { x: number; y: number }): void;
  /** Ends the session after flushing its pending save; resolves once flushed. */
  exit(reason: TextExitReason): Promise<void>;
  /** The field being edited, or null. */
  active(): FieldTarget | null;
  /**
   * "Keep as is" on the unsupported-formatting notice: closes it and leaves
   * the stored text untouched and the field read-only.
   */
  keepUnsupported(): void;
  /**
   * "Remove unsupported formatting": rewrites the field with everything the
   * theme no longer allows stripped (every word kept) as a normal write, and,
   * once it is saved, edits the field with the caret at its end. When the save
   * fails the notice stays and the save error row shows. Resolves with whether
   * the field is now being edited.
   */
  removeUnsupported(): Promise<boolean>;
  /**
   * Whether the event happened inside the active field, so the browser keeps
   * it (caret, word selection). Also remembers where a press began.
   */
  ownsEvent(event: Event): boolean;
  /** True once after a press that began inside the field and ended outside it. */
  pressEndedOutside(): boolean;
  dispose(): void;
};

type Session = {
  readonly target: FieldTarget;
  readonly editor: Editor;
  readonly block: Element;
  readonly snapshot: FieldSnapshot;
  readonly shells: RendererShells;
  /** The document as mounted, so an unchanged field gives back its exact markup. */
  readonly initial: string;
  /** Any change was made, so the value must be sent even when it ends as it began. */
  touched: boolean;
};

const EMPTY_DOCUMENT = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
} as const;

/** The value a document saves as: an emptied field is an absent value. */
function savedValue(editor: Editor): unknown {
  const json = editor.getJSON();
  return isEmptyRichTextDocument(json) ? undefined : json;
}

function containsNode(root: Element, node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof Reflect.get(node, 'nodeType') === 'number' &&
    root.contains(node as Node)
  );
}

export function createTextController(
  options: TextControllerOptions,
): TextController {
  const { store, changeProperties, ready, focusRegion, announce } = options;
  const renderers = options.renderers ?? DEFAULT_TEXT_RENDERERS;
  let current: Session | null = null;
  let pressInside = false;
  /** The field the unsupported-formatting notice is about. */
  let refused: FieldTarget | null = null;

  function blockLabel(id: string): string {
    const { model, session } = store.getState();
    if (model === null) return '';
    const byKey = new Map(
      (session?.catalogue ?? []).map((entry) => [entry.key, entry]),
    );
    return textOf(labelOf(model, byKey, id));
  }

  async function exit(reason: TextExitReason): Promise<void> {
    const session = current;
    if (session === null) {
      // A field the editor refused to mount has no editor to end.
      if (store.getState().textField !== null) store.setTextField(null);
      return;
    }
    current = null;
    const { target, editor, block, snapshot, shells } = session;
    const { blockId, key } = target;
    const value = savedValue(editor);
    const changed = JSON.stringify(editor.getJSON()) !== session.initial;
    // What the field shows until the server's render replaces the block.
    const interim = changed ? cleanChildren(target.element) : undefined;
    try {
      editor.destroy();
    } catch {
      // The document may already be gone (a reload); the restore below is
      // harmless on a detached element.
    }
    shells.dispose();
    restoreField(target.element, snapshot, interim);
    endInlineEdit(block);
    store.setTextField(null);
    if (reason === 'escape' || reason === 'done') {
      focusRegion();
      announce(
        formatString('text.announce.stopped', { label: blockLabel(blockId) }),
      );
    }
    if (session.touched) {
      await changeProperties(blockId, { [key]: value }, key, true);
    }
    if (reason !== 'reload') ready(blockId);
  }

  function enter(target: FieldTarget, point?: { x: number; y: number }): void {
    if (current !== null) void exit('click');
    const state = store.getState();
    if (state.status !== 'editing' || state.mode !== 'edit') return;
    const theme = target.property.textTheme;
    if (theme === undefined) return;
    const stored = state.model?.get(target.blockId)?.props[target.key];
    const present = stored !== undefined && stored !== null;
    if (present && !isRichTextDocumentInTheme(stored, theme)) {
      // Formatting the theme no longer allows: the field stays read-only and
      // its words are kept as they are until the editor chooses otherwise.
      refused = target;
      store.setTextField({
        blockId: target.blockId,
        key: target.key,
        kind: target.kind,
        unsupported: true,
      });
      return;
    }
    const block = target.element.closest('[data-pk-block]');
    if (block === null) return;

    const snapshot = snapshotField(target.element);
    beginInlineEdit(block);
    const shells = createRendererShells(
      renderers,
      target.element.ownerDocument,
    );
    let editor: Editor;
    try {
      editor = new Editor({
        // ProseMirror's place option: mount on the field, no wrapper. TipTap
        // types the option as an element.
        element: { mount: target.element } as unknown as Element,
        injectCSS: false,
        editorProps: {
          // Defence in depth beside the locked schema: pasted styling never
          // reaches the editor, and the author is told when formatting was
          // dropped. The paste transaction follows this call synchronously, so
          // the message is raised once it has run.
          transformPastedHTML: (html) => {
            if (pasteLostFormatting(html)) {
              queueMicrotask(() => {
                store.showMessage('text.paste.stripped');
              });
            }
            return cleanPastedHtml(html);
          },
        },
        extensions: buildTextExtensions(theme, {
          onEscape: () => {
            void exit('escape');
          },
          shells,
        }),
        content: present ? (stored as object) : EMPTY_DOCUMENT,
      });
    } catch {
      shells.dispose();
      restoreField(target.element, snapshot);
      endInlineEdit(block);
      return;
    }

    const { view } = editor;
    const position =
      point === undefined
        ? null
        : view.posAtCoords({ left: point.x, top: point.y });
    const doc = view.state.doc;
    const selection =
      position === null
        ? Selection.atEnd(doc)
        : Selection.near(doc.resolve(position.pos));
    view.dispatch(view.state.tr.setSelection(selection));
    // `view.focus()` is synchronous; the editor command defers by a frame.
    view.focus();

    const session: Session = {
      target,
      editor,
      block,
      snapshot,
      shells,
      initial: JSON.stringify(editor.getJSON()),
      touched: false,
    };
    current = session;
    // Registered after the first transaction, so a node the editor adds by
    // itself on mount is not a change.
    editor.on('update', () => {
      session.touched = true;
      void changeProperties(
        target.blockId,
        { [target.key]: savedValue(editor) },
        target.key,
        false,
      );
    });
    store.setTextField({
      blockId: target.blockId,
      key: target.key,
      kind: target.kind,
      unsupported: false,
    });
    announce(
      formatString('text.announce.editingRich', {
        label: target.property.label,
      }),
    );
  }

  /** Resolves once everything queued is sent, or sending has stopped. */
  function settled(): Promise<'saved' | 'failed'> {
    const outcome = (): 'saved' | 'failed' | null => {
      const { queue } = store.getState();
      if (queue.status === 'failed' || queue.status === 'paused') {
        return 'failed';
      }
      return hasPending(queue) ? null : 'saved';
    };
    const now = outcome();
    if (now !== null) return Promise.resolve(now);
    return new Promise((resolve) => {
      const stop = store.subscribe(() => {
        const next = outcome();
        if (next === null) return;
        stop();
        resolve(next);
      });
    });
  }

  function keepUnsupported(): void {
    refused = null;
    const field = store.getState().textField;
    if (field !== null && field.unsupported) store.setTextField(null);
  }

  async function removeUnsupported(): Promise<boolean> {
    const target = refused;
    const field = store.getState().textField;
    if (target === null || field === null || !field.unsupported) return false;
    const theme = target.property.textTheme;
    const stored = store.getState().model?.get(target.blockId)?.props[
      target.key
    ];
    if (theme === undefined) return false;
    const stripped = stripOutOfTheme(stored, theme);
    if (stripped === null) return false;
    const frameDocument = target.element.ownerDocument;
    // A normal write: previewed, queued, undoable by the session undo.
    const response = await changeProperties(
      target.blockId,
      {
        [target.key]: isEmptyRichTextDocument(stripped) ? undefined : stripped,
      },
      target.key,
      true,
    );
    if (response === null || (response as { ok?: unknown }).ok !== true) {
      return false;
    }
    ready(target.blockId);
    if ((await settled()) !== 'saved') return false;
    const now = store.getState();
    // The block was patched by the write: the field is looked up again.
    const element = Array.from(
      frameDocument.querySelectorAll(`[${EDIT_ATTRIBUTE.block}]`),
    )
      .find(
        (block) => block.getAttribute(EDIT_ATTRIBUTE.block) === target.blockId,
      )
      ?.querySelector(`[${EDIT_ATTRIBUTE.field}="${target.key}"]`);
    if (
      element === undefined ||
      element === null ||
      now.model === null ||
      now.session === null ||
      now.selection.selectedId !== target.blockId
    ) {
      refused = null;
      store.setTextField(null);
      return false;
    }
    const next = findEditableField(element, now.model, now.session.catalogue);
    refused = null;
    store.setTextField(null);
    if (next === null) return false;
    enter(next);
    return current !== null;
  }

  // The session follows the store: another selection, a mode that is not Edit,
  // lost editing, a picker, a delete confirmation or a drag all end it.
  const unsubscribe = store.subscribe(() => {
    const state = store.getState();
    const field = state.textField;
    if (field === null) return;
    if (state.status !== 'editing') {
      void exit('lock');
    } else if (
      state.mode !== 'edit' ||
      state.selection.selectedId !== field.blockId
    ) {
      void exit('selection');
    } else if (
      state.picker !== null ||
      state.deleteRequest !== null ||
      state.drag !== null
    ) {
      void exit('structure');
    }
  });

  return {
    enter,
    exit,
    active: () => current?.target ?? null,
    keepUnsupported,
    removeUnsupported,
    ownsEvent(event) {
      const inside =
        current !== null && containsNode(current.target.element, event.target);
      if (event.type === 'pointerdown') pressInside = inside;
      return inside;
    },
    pressEndedOutside() {
      const was = pressInside;
      pressInside = false;
      return was;
    },
    dispose() {
      unsubscribe();
      void exit('reload');
    },
  };
}
