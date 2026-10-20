/**
 * The base of the rich text lock. The editable text schema IS the lock: a node
 * or mark that is not in it cannot be typed, pasted or toggled, whatever the
 * toolbar shows. This module names every StarterKit extension explicitly, so a
 * TipTap upgrade that adds one cannot widen the schema unnoticed (the schema
 * contract test fails instead).
 *
 * `buildTextExtensions(theme)` derives the extension set of one property from
 * its effective theme: a mark, node or heading level the theme does not name
 * is switched off, so it is not in the schema and cannot be typed, pasted or
 * deserialised. Never add an extension the theme does not name; each one is a
 * decision about what an editor may write.
 *
 * `document` and `text` are always on and StarterKit accepts no configuration
 * for them, so they carry no key. `gapcursor` is likewise typed as `false`
 * only.
 */
import {
  Extension,
  mergeAttributes,
  Node,
  wrappingInputRule,
  type Extensions,
} from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { MarkViewConstructor, NodeViewConstructor } from '@tiptap/pm/view';
import StarterKit, { type StarterKitOptions } from '@tiptap/starter-kit';
import {
  DEFAULT_TEXT_THEME,
  type TextTheme,
} from '@plakboek/content/rich-text';
import { resetStyle } from './commands.js';
import { insertItems, type InsertItem } from './insert-items.js';
import { ThemedLink } from './link.js';
import type { RendererShells } from './shells.js';
import { slashExtension, type SlashState } from './slash.js';
import { unlockExtensions } from './unlock.js';

const OPTIONS: Partial<StarterKitOptions> = {
  // Marks: bold, italic, underline, strike.
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  // Blocks.
  paragraph: {},
  // No level 1: the page owns it.
  heading: { levels: [2, 3, 4] },
  blockquote: {},
  bulletList: {},
  orderedList: {},
  listItem: {},
  listKeymap: {},
  hardBreak: {},
  horizontalRule: {},
  // An empty paragraph after a trailing divider or button keeps a caret
  // target; renderers drop a trailing empty paragraph. Nothing is added after
  // a node that already holds the caret (text, lists, quotes), so mounting the
  // editor never adds a line the visitor page does not have.
  trailingNode: {
    notAfter: [
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'blockquote',
    ],
  },
  // The field's own history while it is active; after exit the session stack
  // takes over.
  undoRedo: {},
  // Off: no code, no stock link (the themed link mark replaces it), and no
  // cursor helpers, which need CSS the editor never adds to the site document.
  code: false,
  codeBlock: false,
  link: false,
  dropcursor: false,
  gapcursor: false,
};

export const LOCKED_STARTER_KIT_OPTIONS: Readonly<Partial<StarterKitOptions>> =
  Object.freeze(OPTIONS);

const ORDERED_LIST_START_MAX = 1_000_000;

/**
 * The numbered list with `start` as its only attribute. The stock extension
 * also reads a `type` (letters, roman numerals) from pasted markup, which the
 * stored document does not allow, so the node is declared here instead.
 */
const OrderedList = Node.create({
  name: 'orderedList',
  group: 'block list',
  content: 'listItem+',

  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute('start');
          const start = raw === null ? 1 : Number.parseInt(raw, 10);
          return Number.isInteger(start) &&
            start >= 1 &&
            start <= ORDERED_LIST_START_MAX
            ? start
            : 1;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'ol' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { start, ...rest } = HTMLAttributes as Record<string, unknown>;
    return ['ol', mergeAttributes(start === 1 ? {} : { start }, rest), 0];
  },

  addCommands() {
    return {
      toggleOrderedList:
        () =>
        ({ commands }) =>
          commands.toggleList(this.name, 'listItem'),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-7': () => this.editor.commands.toggleOrderedList(),
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^(\d+)\.\s$/,
        type: this.type,
        getAttributes: (match) => ({ start: Number(match[1]) }),
        joinPredicate: (match, node) =>
          node.childCount + (node.attrs.start as number) === Number(match[1]),
      }),
    ];
  },
});

export type TextExtensionHooks = {
  /** Escape was pressed inside the field. */
  readonly onEscape?: () => void;
  /** Alt+F10 was pressed inside the field: focus goes to the toolbar. */
  readonly onFocusToolbar?: () => void;
  /** Reset style ran from the keyboard (Mod-Backslash) and changed something. */
  readonly onStyleReset?: () => void;
  /**
   * The link popover was asked for: Mod-K, or a click on a link in the field.
   * Without it the field has no link key and a click on a link does nothing.
   */
  readonly onLink?: () => void;
  /**
   * The '/' menu changed (opened, filtered, moved, closed with null). Without
   * it the field has no '/' menu at all.
   */
  readonly onSlash?: (state: SlashState | null) => void;
  /** An item was inserted from the '/' menu. */
  readonly onInserted?: (item: InsertItem) => void;
  /**
   * Node and mark views derived from the host's renderers, so the field keeps
   * the host's own markup while it is edited. Without them the editor uses its
   * semantic defaults.
   */
  readonly shells?: RendererShells;
};

const SHELL_NODES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'horizontalRule',
] as const;

const SHELL_MARKS = ['bold', 'italic', 'underline', 'strike'] as const;

/**
 * Hands the editor view the shells as plugin props. TipTap builds the view's
 * own `nodeViews` and `markViews` from the extensions and would replace the
 * editor props of the same name, whereas plugin props are merged beside them.
 * A view constructor that finds no shell returns nothing, which makes
 * ProseMirror use the node's own default.
 */
const RendererShellViews = Extension.create<TextExtensionHooks>({
  name: 'rendererShellViews',

  addOptions() {
    return {};
  },

  addProseMirrorPlugins() {
    const { shells } = this.options;
    if (shells === undefined) return [];
    // ProseMirror accepts a missing view and falls back; its types do not say so.
    const nodeViews: Record<string, NodeViewConstructor> = {};
    for (const name of SHELL_NODES) {
      nodeViews[name] = ((node) =>
        shells.nodeView(name, node.attrs)) as NodeViewConstructor;
    }
    const markViews: Record<string, MarkViewConstructor> = {};
    for (const name of SHELL_MARKS) {
      markViews[name] = ((mark) =>
        shells.markView(name, mark.attrs)) as MarkViewConstructor;
    }
    return [new Plugin({ props: { nodeViews, markViews } })];
  },
});

/**
 * Escape ends the field session. The key is consumed here so that the shell's
 * own Escape (climb the selection) does not also run. Alt+F10 hands the
 * keyboard to the toolbar.
 */
const TextFieldKeymap = Extension.create<TextExtensionHooks>({
  name: 'textFieldKeymap',

  addOptions() {
    return {};
  },

  addKeyboardShortcuts() {
    return {
      Escape: () => {
        const handler = this.options.onEscape;
        if (handler === undefined) return false;
        handler();
        return true;
      },
      'Alt-F10': () => {
        const handler = this.options.onFocusToolbar;
        if (handler === undefined) return false;
        handler();
        return true;
      },
      // Link: opens the link popover for the selection or the link at the
      // caret. A field whose theme has no link leaves the key alone.
      'Mod-k': () => {
        const handler = this.options.onLink;
        if (
          handler === undefined ||
          this.editor.schema.marks['link'] === undefined
        ) {
          return false;
        }
        handler();
        return true;
      },
      // Reset style: strips colour, size and alignment from the selection in
      // one step. Without custom style in the schema or the selection the key
      // is left alone.
      'Mod-\\': () => {
        const { view } = this.editor;
        const done = resetStyle(view.state, (tr) => {
          view.dispatch(tr);
        });
        if (done) this.options.onStyleReset?.();
        return done;
      },
    };
  },
});

/** The StarterKit options of a theme: everything it does not name is off. */
export function starterKitOptionsFor(
  theme: TextTheme,
): Partial<StarterKitOptions> {
  const mark = (
    name: TextTheme['marks'][number],
  ): Record<string, never> | false => (theme.marks.includes(name) ? {} : false);
  const node = (
    name: TextTheme['nodes'][number],
  ): Record<string, never> | false => (theme.nodes.includes(name) ? {} : false);
  const lists =
    theme.nodes.includes('bulletList') || theme.nodes.includes('orderedList');
  return {
    ...LOCKED_STARTER_KIT_OPTIONS,
    bold: mark('bold'),
    italic: mark('italic'),
    underline: mark('underline'),
    strike: mark('strike'),
    heading:
      theme.headingLevels.length === 0
        ? false
        : { levels: [...theme.headingLevels] },
    blockquote: node('blockquote'),
    bulletList: node('bulletList'),
    // Declared below with `start` as its only attribute.
    orderedList: false,
    listItem: lists ? {} : false,
    listKeymap: lists ? {} : false,
    hardBreak: node('hardBreak'),
    horizontalRule: node('horizontalRule'),
  };
}

/** The '/' menu of a field: present when something is insertable and the session listens. */
function slashExtensions(
  theme: TextTheme,
  hooks: TextExtensionHooks,
): Extensions {
  const { onSlash, onInserted } = hooks;
  const items = insertItems(theme, 'slash');
  if (onSlash === undefined || items.length === 0) return [];
  return [
    slashExtension({
      items,
      publish: onSlash,
      ...(onInserted === undefined ? {} : { onInserted }),
    }),
  ];
}

/**
 * The extension set of one rich_text property: the locked base narrowed by the
 * property's effective theme. The button extension joins it in a later plan;
 * until then a theme that names it simply has no such extension yet, and the
 * server still validates every write.
 */
export function buildTextExtensions(
  theme: TextTheme,
  hooks: TextExtensionHooks = {},
): Extensions {
  return [
    StarterKit.configure(starterKitOptionsFor(theme)),
    ...(theme.nodes.includes('orderedList') ? [OrderedList] : []),
    // Colour, size and alignment, only when the theme declares them.
    ...unlockExtensions(theme),
    // Links, only when the theme names the mark.
    ...(theme.marks.includes('link')
      ? [ThemedLink.configure({ onOpen: hooks.onLink ?? null })]
      : []),
    TextFieldKeymap.configure(hooks),
    ...slashExtensions(theme, hooks),
    ...(hooks.shells === undefined
      ? []
      : [RendererShellViews.configure({ shells: hooks.shells })]),
  ];
}

/** The locked base extension list: the schema of the default theme. */
export function buildLockedExtensions(): Extensions {
  return buildTextExtensions(DEFAULT_TEXT_THEME);
}
