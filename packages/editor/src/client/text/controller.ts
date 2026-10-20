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
 * A button block (a `link` field) is the other kind of session: no editor is
 * mounted, the Button popover edits the block's properties, and it ends the
 * same ways.
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
import { selectCrumb } from '../session/scope.js';
import {
  selectAndAnnounce,
  textOf,
} from '../session/selection-announcement.js';
import { labelOf } from '../session/tree-model.js';
import { hasPending } from '../session/save-queue.js';
import { beginInlineEdit, endInlineEdit } from '../frame/patch.js';
import { CTA_INSERTED, selectedCta } from './cta.js';
import { buildTextExtensions } from './extensions.js';
import type { SlashState } from './slash.js';
import {
  buildPlainExtensions,
  plainDocument,
  plainTextOf,
} from './plain-field.js';
import { cleanPastedHtml, pasteLostFormatting } from './paste.js';
import { createRendererShells, type RendererShells } from './shells.js';
import {
  findEditableField,
  findFieldForProperty,
  type FieldTarget,
} from './field-target.js';
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
  /**
   * Writes the property's candidate value: previews it, then queues the save.
   * With `persist` the save is queued at once, whatever the preview answers.
   */
  readonly changeProperties: (
    blockId: string,
    values: Readonly<Record<string, unknown>>,
    changedKey: string,
    immediate: boolean,
    persist?: boolean,
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
  /** The framed site's document, for finding a block's field by property; without it no field is found. */
  readonly frameDocument?: () => Document | null;
};

/** The room left above a field the Properties panel scrolls into view. */
export const FIELD_CLEARANCE = 48;

export type TextController = {
  /**
   * Starts a session on the field, ending a running one first. The caret goes
   * to `point` (frame viewport coordinates) when the editor finds a position
   * there, else to the end of the field.
   */
  enter(target: FieldTarget, point?: { x: number; y: number }): void;
  /**
   * The field the block marks for the property and the editor may type in, or
   * null (the block never marks it, it is not editable text, or the page is
   * not showing it).
   */
  fieldFor(blockId: string, key: string): FieldTarget | null;
  /**
   * Selects the block, scrolls the field into view with `FIELD_CLEARANCE` above
   * it when it is outside the frame's viewport, and starts the session with the
   * caret at the end. Returns false, and does nothing, when there is no such
   * field.
   */
  enterField(blockId: string, key: string): boolean;
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
  /**
   * The link popover of the running session: a number that changes each time
   * it is asked for (the toolbar's Link, Mod-K, a click on a link), 0 while it
   * is closed. Changes are announced through `subscribe`.
   */
  linkRequest(): number;
  /** Asks for the link popover; does nothing between sessions. */
  openLink(): void;
  /** Closes the link popover without touching the field. */
  closeLink(): void;
  /**
   * The Button popover of the running session: a number that changes each time
   * it is asked for (a CTA inserted or clicked, Mod-K on a selected CTA), 0
   * while it is closed. It closes by itself once no CTA is selected. Changes
   * are announced through `subscribe`.
   */
  buttonRequest(): number;
  /** Asks for the Button popover; does nothing between sessions. */
  openButton(): void;
  /** Closes the Button popover without touching the field. */
  closeButton(): void;
  /** Puts keyboard focus back in the field with its selection as it was. */
  focusField(): void;
  /**
   * The Button popover of a button block writes one of its three properties
   * (the link, its label or its style) through the normal property preview
   * and save. Only the keys the session's field names are written; anything
   * else, and any call between sessions, does nothing.
   */
  setBlockProperty(key: string, value: unknown, immediate: boolean): void;
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

/** What the Properties panel is shown while the field is typed in: a line of text, or the document. */
function liveValueOf(editor: Editor, kind: FieldTarget['kind']): unknown {
  return kind === 'plain' ? plainTextOf(editor.getJSON()) : editor.getJSON();
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
  /** The button block being edited in its popover: the other kind of session, with no editor. */
  let blockButton: FieldTarget | null = null;
  let pressInside = false;
  /** The field the unsupported-formatting notice is about. */
  let refused: FieldTarget | null = null;
  const listeners = new Set<() => void>();
  let toolbarFocus: (() => void) | null = null;
  let slashState: SlashState | null = null;
  let linkToken = 0;
  let linkCounter = 0;
  let buttonToken = 0;
  let buttonCounter = 0;

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

  /** Ends the button block's session: flushes what was queued for the block and hands back. */
  function exitBlockButton(reason: TextExitReason): void {
    const target = blockButton;
    if (target === null) return;
    blockButton = null;
    buttonToken = 0;
    store.setTextField(null);
    notify();
    if (reason === 'escape' || reason === 'done') {
      focusRegion();
      announce(
        formatString('text.announce.stopped', {
          label: blockLabel(target.blockId),
        }),
      );
    }
    if (reason !== 'reload') ready(target.blockId);
  }

  async function exit(reason: TextExitReason): Promise<void> {
    if (blockButton !== null) {
      exitBlockButton(reason);
      return;
    }
    const session = current;
    if (session === null) {
      // A field the editor refused to mount has no editor to end.
      if (store.getState().textField !== null) store.setTextField(null);
      return;
    }
    current = null;
    slashState = null;
    linkToken = 0;
    buttonToken = 0;
    const { target, editor, block, snapshot, shells } = session;
    const { blockId, key } = target;
    const value = savedValue(editor, target.kind);
    if (session.live.timer !== null) clearTimeout(session.live.timer);
    // The panel shows what was typed from now until the write has landed.
    if (session.touched) {
      store.setLiveValue(blockId, key, liveValueOf(editor, target.kind));
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
      // Queued before it returns, whatever the preview answers: the typed text
      // exists nowhere else once the editor is gone. Not awaited, so a slow
      // preview never holds back the action that follows the session.
      void changeProperties(blockId, { [key]: value }, key, true, true);
    }
    if (reason !== 'reload') ready(blockId);
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

  /** A button block's field: no editor, the Button popover edits its properties. */
  function enterBlockButton(target: FieldTarget): void {
    const state = store.getState();
    if (state.status !== 'editing' || state.mode !== 'edit') return;
    blockButton = target;
    buttonCounter += 1;
    buttonToken = buttonCounter;
    store.setTextField({
      blockId: target.blockId,
      key: target.key,
      kind: 'button',
      unsupported: false,
    });
    announce(
      formatString('text.announce.editingButton', {
        label: target.property.label,
      }),
    );
    notify();
  }

  function fieldFor(blockId: string, key: string): FieldTarget | null {
    const frameDocument = options.frameDocument?.() ?? null;
    const { model, session } = store.getState();
    if (frameDocument === null || model === null || session === null) {
      return null;
    }
    return findFieldForProperty(
      frameDocument,
      blockId,
      key,
      model,
      session.catalogue,
    );
  }

  function enterField(blockId: string, key: string): boolean {
    const state = store.getState();
    if (state.status !== 'editing' || state.mode !== 'edit') return false;
    const target = fieldFor(blockId, key);
    if (target === null || state.model === null) return false;
    if (state.selection.selectedId !== blockId) {
      selectAndAnnounce(store, selectCrumb(state.model, blockId));
    }
    const view = target.element.ownerDocument.defaultView;
    if (view !== null) {
      const box = target.element.getBoundingClientRect();
      const height = target.element.ownerDocument.documentElement.clientHeight;
      if (box.top < FIELD_CLEARANCE || box.bottom > height) {
        view.scrollBy({
          top: box.top - FIELD_CLEARANCE,
          behavior: 'instant',
        });
      }
    }
    enter(target);
    return store.getState().textField !== null;
  }

  function enter(target: FieldTarget, point?: { x: number; y: number }): void {
    if (current !== null || blockButton !== null) void exit('click');
    const state = store.getState();
    if (state.status !== 'editing' || state.mode !== 'edit') return;
    if (target.kind === 'button') {
      enterBlockButton(target);
      return;
    }
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
                onLink: openLink,
                onButton: openButton,
                onSlash: (next) => {
                  slashState = next;
                  notify();
                },
                onInserted: (inserted) => {
                  announce(
                    inserted.announcement ??
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
    // The toolbar follows every transaction, selection moves included. A CTA
    // just inserted asks for its popover; one that is no longer selected
    // takes the popover away.
    editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta(CTA_INSERTED) !== undefined) {
        buttonCounter += 1;
        buttonToken = buttonCounter;
      } else if (buttonToken !== 0 && selectedCta(editor.state) === null) {
        buttonToken = 0;
      }
      notify();
    });
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
      // The panel follows the typing, at most once per delay.
      session.live.value = liveValueOf(editor, target.kind);
      session.live.timer ??= setTimeout(() => {
        session.live.timer = null;
        store.setLiveValue(target.blockId, target.key, session.live.value);
      }, LIVE_VALUE_DELAY_MS);
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

  function openLink(): void {
    if (current === null) return;
    linkCounter += 1;
    linkToken = linkCounter;
    notify();
  }

  function closeLink(): void {
    if (linkToken === 0) return;
    linkToken = 0;
    notify();
  }

  function openButton(): void {
    if (current === null) return;
    buttonCounter += 1;
    buttonToken = buttonCounter;
    notify();
  }

  function closeButton(): void {
    if (buttonToken === 0) return;
    buttonToken = 0;
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
    fieldFor,
    enterField,
    exit,
    active: () => current?.target ?? blockButton,
    editor: () => current?.editor ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    slash: () => slashState,
    linkRequest: () => linkToken,
    openLink,
    closeLink,
    buttonRequest: () => buttonToken,
    openButton,
    closeButton,
    focusField() {
      current?.editor.view.focus();
    },
    setBlockProperty(key, value, immediate) {
      const target = blockButton;
      if (target === null) return;
      const allowed = [target.key, target.labelKey, target.variantKey];
      if (!allowed.includes(key)) return;
      void changeProperties(target.blockId, { [key]: value }, key, immediate);
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
