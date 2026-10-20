/**
 * The '/' trigger of a rich text field. Typing `/` at the start of an empty
 * paragraph or after a space opens the insert menu; what is typed after it
 * filters the items. The menu itself is drawn by the editor's own chrome (it
 * never takes focus: the field keeps the caret), so this plugin only decides
 * when the menu is open, what it lists and what Enter does, and publishes that
 * as a plain `SlashState`.
 *
 * It is built on the suggestion plugin without its `mount` helper, which
 * attaches to the top document and does not know the framed document's realm.
 * Escape closes the menu and leaves the typed text; a space ends the match.
 */
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import type { Box } from '../overlay/geometry.js';
import { filterInsertItems, type InsertItem } from './insert-items.js';

export type SlashState = {
  /** What follows the `/`, the filter. */
  readonly query: string;
  /** The items whose label matches, in menu order; empty shows the no-match line. */
  readonly items: readonly InsertItem[];
  /** The row Enter would insert. */
  readonly activeIndex: number;
  /** The typed `/query` in the framed document's coordinates (they scroll with the page). */
  readonly rect: Box;
  /** Inserts the item and removes the typed `/query`. */
  readonly choose: (item: InsertItem) => void;
  /** Makes a row the active one (the pointer moved over it). */
  readonly activate: (index: number) => void;
};

export type SlashOptions = {
  /** Every item the theme allows for the '/' menu. */
  readonly items: readonly InsertItem[];
  /** Receives the menu's state on every change, and null when it closes. */
  readonly publish: (state: SlashState | null) => void;
  /** An item was inserted from the menu. */
  readonly onInserted?: (item: InsertItem) => void;
};

const SLASH_KEY = new PluginKey('slashMenu');

/** The `/query` text's box: the suggestion's own rect, else the caret's, in document coordinates. */
function documentRect(props: SuggestionProps<InsertItem, InsertItem>): Box {
  const { view } = props.editor;
  const window = view.dom.ownerDocument.defaultView;
  const scrollX = window?.scrollX ?? 0;
  const scrollY = window?.scrollY ?? 0;
  const rect = props.clientRect?.() ?? null;
  if (rect !== null) {
    return {
      left: rect.left + scrollX,
      top: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
    };
  }
  const caret = view.coordsAtPos(props.range.from);
  return {
    left: caret.left + scrollX,
    top: caret.top + scrollY,
    width: Math.max(0, caret.right - caret.left),
    height: caret.bottom - caret.top,
  };
}

export const SlashExtension = Extension.create<SlashOptions>({
  name: 'slashMenu',
  // Before the field's own keymap: Escape closes the menu, it does not end the session.
  priority: 200,

  addOptions() {
    return {
      items: [],
      publish: () => undefined,
    };
  },

  addProseMirrorPlugins() {
    const { items: all, publish, onInserted } = this.options;
    return [
      Suggestion<InsertItem, InsertItem>({
        editor: this.editor,
        pluginKey: SLASH_KEY,
        char: '/',
        // Only an empty paragraph's first character, or a character that
        // follows a space: a slash inside a word or a web address is text.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if (!$from.parent.isTextblock) return false;
          if ($from.parentOffset === 0) {
            return (
              $from.parent.type.name === 'paragraph' &&
              $from.parent.textContent ===
                state.doc.textBetween(range.from, range.to)
            );
          }
          return (
            $from.parent.textBetween(
              $from.parentOffset - 1,
              $from.parentOffset,
            ) === ' '
          );
        },
        items: () => [],
        command: ({ editor, range, props }) => {
          props.run(editor.chain().deleteRange(range)).run();
          onInserted?.(props);
        },
        render: () => {
          let latest: SuggestionProps<InsertItem, InsertItem> | null = null;
          let active = 0;
          let shownQuery = '';

          const matches = (): readonly InsertItem[] =>
            filterInsertItems(all, latest?.query ?? '');

          const send = (): void => {
            const props = latest;
            if (props === null) return;
            const items = matches();
            active = Math.max(0, Math.min(active, items.length - 1));
            publish({
              query: props.query,
              items,
              activeIndex: active,
              rect: documentRect(props),
              choose: (chosen) => {
                props.command(chosen);
              },
              activate: (index) => {
                active = index;
                send();
              },
            });
          };

          return {
            onStart: (props) => {
              latest = props;
              active = 0;
              shownQuery = props.query;
              send();
            },
            onUpdate: (props) => {
              latest = props;
              // A new filter starts at the first row.
              if (props.query !== shownQuery) active = 0;
              shownQuery = props.query;
              send();
            },
            onExit: () => {
              latest = null;
              publish(null);
            },
            onKeyDown: ({ event }) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return false;
              const items = matches();
              if (items.length === 0) return false;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                active =
                  (active +
                    (event.key === 'ArrowDown' ? 1 : -1) +
                    items.length) %
                  items.length;
                send();
                return true;
              }
              if (event.key === 'Enter') {
                const chosen = items[active];
                if (chosen === undefined || latest === null) return false;
                latest.command(chosen);
                return true;
              }
              return false;
            },
          };
        },
      }),
    ];
  },
});

/** The '/' menu extension for the items a theme allows; absent when it allows none. */
export function slashExtension(options: SlashOptions): Extension {
  return SlashExtension.configure(options);
}
