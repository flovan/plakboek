/**
 * The base of the rich text lock. The editable text schema IS the lock: a node
 * or mark that is not in it cannot be typed, pasted or toggled, whatever the
 * toolbar shows. This module names every StarterKit extension explicitly, so a
 * TipTap upgrade that adds one cannot widen the schema unnoticed (the schema
 * contract test fails instead).
 *
 * Later plans extend this list into `buildTextExtensions(theme, ...)`. Never
 * add an extension here by default; each one is a decision about what an
 * editor may write.
 *
 * `document` and `text` are always on and StarterKit accepts no configuration
 * for them, so they carry no key. `gapcursor` is likewise typed as `false`
 * only.
 */
import type { Extensions } from '@tiptap/core';
import StarterKit, { type StarterKitOptions } from '@tiptap/starter-kit';

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

/** The locked base extension list. */
export function buildLockedExtensions(): Extensions {
  return [StarterKit.configure(LOCKED_STARTER_KIT_OPTIONS)];
}
