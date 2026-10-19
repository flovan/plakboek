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
import StarterKit, { type StarterKitOptions } from '@tiptap/starter-kit';
import {
  DEFAULT_TEXT_THEME,
  type TextTheme,
} from '@plakboek/content/rich-text';

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
  // target; renderers drop a trailing empty paragraph.
  trailingNode: {},
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
};

/**
 * Escape ends the field session. The key is consumed here so that the shell's
 * own Escape (climb the selection) does not also run.
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

/**
 * The extension set of one rich_text property: the locked base narrowed by the
 * property's effective theme. The link, button and style extensions join it in
 * later plans; until then a theme that names them simply has no such extension
 * yet, and the server still validates every write.
 */
export function buildTextExtensions(
  theme: TextTheme,
  hooks: TextExtensionHooks = {},
): Extensions {
  return [
    StarterKit.configure(starterKitOptionsFor(theme)),
    ...(theme.nodes.includes('orderedList') ? [OrderedList] : []),
    TextFieldKeymap.configure(hooks),
  ];
}

/** The locked base extension list: the schema of the default theme. */
export function buildLockedExtensions(): Extensions {
  return buildTextExtensions(DEFAULT_TEXT_THEME);
}
