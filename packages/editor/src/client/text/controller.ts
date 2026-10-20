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
import type { SlashState } from './slash.js';
import {
  buildPlainExtensions,
  plainDocument,
  plainTextOf,
} from './plain-field.js';
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
  | 'lock'
  | 'panel';

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
  /** The running session's editor, for the text toolbar's commands; null between sessions. */
  editor(): Editor | null;
  /**
   * Calls the listener on every editor transaction (a keystroke, a selection
   * move, a toolbar command) and when a session starts or ends; returns the
   * function that stops it. The toolbar reads its state through this.
   */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * The '/' menu of the running session: what it lists and where, or null
   * while it is closed. Changes are announced through `subscribe`.
   */
  slash(): SlashState | null;
  /** Puts keyboard focus back in the field with its selection as it was. */
  focusField(): void;
  /**
   * Alt+F10 in the field: focuses the toolbar's current control, through the
   * function the toolbar registered. Does nothing without a toolbar.
   */
  focusToolbar(): void;
  /** The toolbar registers (and, with null, withdraws) how to focus itself. */
  setToolbarFocus(focus: (() => void) | null): void;
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
  /** The node views of a rich text field; a plain field has none. */
  readonly shells: RendererShells | null;
  /** The latest value not yet shown to the Properties panel, and its timer. */
  live: { timer: ReturnType<typeof setTimeout> | null; value: unknown };
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
function savedValue(editor: Editor, kind: FieldTarget['kind']): unknown {
  const json = editor.getJSON();
  if (kind === 'plain') {
    const text = plainTextOf(json);
    return text === '' ? undefined : text;
  }
  return isEmptyRichTextDocument(json) ? undefined : json;
}

/** How long typing waits before the Properties panel is shown the new value. */
const LIVE_VALUE_DELAY_MS = 150;

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
  const listeners = new Set<() => void>();
  let toolbarFocus: (() => void) | null = null;
  let slashState: SlashState | null = null;

  function notify(): void {
    for (const listener of listeners) listener();
  }

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
    slashState = null;
    const { target, editor, block, snapshot, shells } = session;
    const { blockId, key } = target;
    const value = savedValue(editor, target.kind);
    if (session.live.timer !== null) clearTimeout(session.live.timer);
    // The panel shows what was typed from now until the write has landed.
    if (session.touched && target.kind === 'plain') {
      store.setLiveValue(blockId, key, plainTextOf(editor.getJSON()));
    }
    const changed = JSON.stringify(editor.getJSON()) !== session.initial;
    // What the field shows until the server's render replaces the block.
    const interim = changed ? cleanChildren(target.element) : undefined;
    try {
      editor.destroy();
    } catch {
      // The document may already be gone (a reload); the restore below is
      // harmless on a detached element.
    }
    shells?.dispose();
    restoreField(target.element, snapshot, interim);
    endInlineEdit(block);
    store.setTextField(null);
    notify();
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
    if (target.kind === 'plain') {
      // Once everything queued is sent the model holds the value, so the
      // panel reads the model again; until then it keeps showing the typing.
      if (reason === 'reload') store.clearLiveValues(blockId);
      else {
        void settled().then((outcome) => {
          // A failed or paused queue keeps the typing on show, like a draft
          // the engine refused.
          if (outcome === 'saved' && current?.target.blockId !== blockId) {
            store.clearLiveValues(blockId);
          }
        });
      }
    }
  }

  function enter(target: FieldTarget, point?: { x: number; y: number }): void {
    if (current !== null) void exit('click');
    const state = store.getState();
    if (state.status !== 'editing' || state.mode !== 'edit') return;
    const rich = target.kind === 'rich';
    const theme = target.property.textTheme;
    if (rich && theme === undefined) return;
    const stored = state.model?.get(target.blockId)?.props[target.key];
    const present = stored !== undefined && stored !== null;
    if (
      rich &&
      theme !== undefined &&
      present &&
      !isRichTextDocumentInTheme(stored, theme)
    ) {
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
    const shells = rich
      ? createRendererShells(renderers, target.element.ownerDocument)
      : null;
    let editor: Editor;
    try {
      editor = new Editor({
        // ProseMirror's place option: mount on the field, no wrapper. TipTap
        // types the option as an element.
        element: { mount: target.element } as unknown as Element,
        injectCSS: false,
        // A plain field's paste rule lives in its own plugin.
        editorProps: rich
          ? {
              // Defence in depth beside the locked schema: pasted styling
              // never reaches the editor, and the author is told when
              // formatting was dropped. The paste transaction follows this
              // call synchronously, so the message is raised once it has run.
              transformPastedHTML: (html) => {
                if (pasteLostFormatting(html)) {
                  queueMicrotask(() => {
                    store.showMessage('text.paste.stripped');
                  });
                }
                return cleanPastedHtml(html);
              },
            }
          : {},
        extensions:
          rich && theme !== undefined && shells !== null
            ? buildTextExtensions(theme, {
                onEscape: () => {
                  void exit('escape');
                },
                onFocusToolbar: () => {
                  toolbarFocus?.();
                },
                onStyleReset: () => {
                  announce(formatString('text.announce.styleReset'));
                },
                onSlash: (next) => {
                  slashState = next;
                  notify();
                },
                onInserted: (inserted) => {
                  announce(
                    formatString('text.announce.inserted', {
                      item: inserted.label,
                    }),
                  );
                },
                shells,
              })
            : buildPlainExtensions({
                ...(target.maxLength === undefined
                  ? {}
                  : { maxLength: target.maxLength }),
                onEnter: () => {
                  void exit('done');
                },
                onEscape: () => {
                  void exit('escape');
                },
              }),
        content: rich
          ? present
            ? (stored as object)
            : EMPTY_DOCUMENT
          : plainDocument(typeof stored === 'string' ? stored : ''),
      });
    } catch {
      shells?.dispose();
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
      live: { timer: null, value: undefined },
      initial: JSON.stringify(editor.getJSON()),
      touched: false,
    };
    current = session;
    // The toolbar follows every transaction, selection moves included.
    editor.on('transaction', notify);
    // Registered after the first transaction, so a node the editor adds by
    // itself on mount is not a change.
    editor.on('update', () => {
      session.touched = true;
      void changeProperties(
        target.blockId,
        { [target.key]: savedValue(editor, target.kind) },
        target.key,
        false,
      );
      if (target.kind === 'plain') {
        // The panel follows the typing, at most once per delay.
        session.live.value = plainTextOf(editor.getJSON());
        session.live.timer ??= setTimeout(() => {
          session.live.timer = null;
          store.setLiveValue(target.blockId, target.key, session.live.value);
        }, LIVE_VALUE_DELAY_MS);
      }
    });
    store.setTextField({
      blockId: target.blockId,
      key: target.key,
      kind: target.kind,
      unsupported: false,
    });
    announce(
      formatString(
        rich ? 'text.announce.editingRich' : 'text.announce.editingPlain',
        { label: target.property.label },
      ),
    );
    notify();
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
    editor: () => current?.editor ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    slash: () => slashState,
    focusField() {
      current?.editor.view.focus();
    },
    focusToolbar() {
      toolbarFocus?.();
    },
    setToolbarFocus(focus) {
      toolbarFocus = focus;
    },
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
