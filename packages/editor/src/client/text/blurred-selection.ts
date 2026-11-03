/**
 * Draws the selection of a field that has lost the keyboard to its own
 * toolbar. The toolbar and its popovers live in the chrome host inside the
 * same frame document, so with focus on one of their controls the field's
 * view has no focus. prosemirror-view then leaves the native selection to the
 * browser after a command rewrote the text, and the browser paints whatever
 * its DOM-mutation rules left behind, often on other words.
 *
 * While the view is blurred this extension therefore draws the editor
 * selection itself, as an inline decoration styled with the platform's
 * selection colours, and clears the stale native selection. The native
 * selection is never written back while blurred: doing that moves the focus
 * into the field and takes it from the toolbar. Focus coming back through
 * `view.focus()` lets prosemirror-view write the selection and the decoration
 * goes with the focus flag.
 *
 * The decoration's style is applied through the element's style object, so the
 * frame document gets no stylesheet and no highlight registry. Decorations are
 * view-only and never part of the saved document.
 */
import { Extension } from '@tiptap/core';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** Marks the elements that draw the blurred selection. */
export const SELECTION_ATTRIBUTE = 'data-pk-selection';

const SELECTION_STYLE = 'background-color: Highlight; color: HighlightText';

const FOCUS_KEY = new PluginKey<boolean>('blurredSelection');

/**
 * The decoration set that shows the selection of an unfocused field: one
 * inline decoration over the selected text, nothing for a focused field, a
 * caret or a node selection.
 */
export function blurredSelectionDecorations(
  state: EditorState,
  focused: boolean,
): DecorationSet {
  const { selection } = state;
  if (focused || !(selection instanceof TextSelection) || selection.empty) {
    return DecorationSet.empty;
  }
  return DecorationSet.create(state.doc, [
    Decoration.inline(selection.from, selection.to, {
      [SELECTION_ATTRIBUTE]: '',
      style: SELECTION_STYLE,
    }),
  ]);
}

export const BlurredSelection = Extension.create({
  name: 'blurredSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: FOCUS_KEY,
        state: {
          // Treated as focused until the view says otherwise: a field is
          // mounted and focused in one step.
          init: () => true,
          apply: (tr, focused) => {
            const meta = tr.getMeta(FOCUS_KEY) as boolean | undefined;
            return meta ?? focused;
          },
        },
        props: {
          decorations: (state) =>
            blurredSelectionDecorations(
              state,
              FOCUS_KEY.getState(state) ?? true,
            ),
          handleDOMEvents: {
            focus: (view) => {
              if (FOCUS_KEY.getState(view.state) === false) {
                view.dispatch(view.state.tr.setMeta(FOCUS_KEY, true));
              }
              return false;
            },
            blur: (view) => {
              if (FOCUS_KEY.getState(view.state) !== false) {
                view.dispatch(view.state.tr.setMeta(FOCUS_KEY, false));
              }
              // Once the focus has settled: a view that is still without it
              // must not leave its native selection painted.
              const frameWindow = view.dom.ownerDocument.defaultView;
              frameWindow?.setTimeout(() => {
                if (view.isDestroyed || view.hasFocus()) return;
                const selection = view.dom.ownerDocument.getSelection();
                const anchor = selection?.anchorNode;
                if (
                  selection !== null &&
                  selection !== undefined &&
                  anchor !== null &&
                  anchor !== undefined &&
                  view.dom.contains(anchor)
                ) {
                  selection.removeAllRanges();
                }
              }, 0);
              return false;
            },
          },
        },
        view: (view) => {
          // The flag starts right for a field that is mounted unfocused.
          queueMicrotask(() => {
            if (
              !view.isDestroyed &&
              !view.hasFocus() &&
              FOCUS_KEY.getState(view.state) !== false
            ) {
              view.dispatch(view.state.tr.setMeta(FOCUS_KEY, false));
            }
          });
          return {};
        },
      }),
    ];
  },
});
