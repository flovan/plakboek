/**
 * The themed link mark and the commands that work on it.
 *
 * The stored attributes of a link are exactly `href`, `pageId` and `target`,
 * with exactly one of `href` and `pageId` set (D-18): an internal link keeps
 * the page's id, so a renamed page keeps its links, and an address is stored
 * only when it passes the shared href policy. The stock link extension is the
 * base, but nothing of its own attributes (`rel`, `class`, `title`), its
 * autolinking, its click-through or its paste handling is kept: a link is made
 * only by the popover, and a pasted or typed target that fails the policy is
 * never a link.
 *
 * The commands are plain ProseMirror functions over `EditorState`, with no
 * DOM, so they are proven in Node.
 */
import { getMarkRange } from '@tiptap/core';
import { Link, type LinkOptions } from '@tiptap/extension-link';
import type { MarkType } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import {
  isAllowedHref,
  PAGE_ID_PATTERN,
  type LinkTarget,
} from '@plakboek/content/rich-text';

type ThemedLinkOptions = LinkOptions & {
  /** A click on a link in the field: the field opens its link popover. */
  onOpen: (() => void) | null;
};

/** What the editor shows of a page link, which has no address of its own yet. */
const PAGE_LINK_PLACEHOLDER = '#';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The target an element holds, or false when it holds none the policy allows. */
function readTarget(element: HTMLElement): LinkTarget | false {
  const target = element.getAttribute('target') === '_blank' ? '_blank' : null;
  const pageId = element.getAttribute('data-pk-page');
  if (pageId !== null && PAGE_ID_PATTERN.test(pageId)) {
    return { href: null, pageId, target };
  }
  const href = element.getAttribute('href');
  if (href !== null && isAllowedHref(href)) {
    return { href, pageId: null, target };
  }
  return false;
}

/**
 * The attributes of a link mark as a stored target; null when it holds
 * neither a page id nor an address the policy allows. A page id wins when both
 * are present, as it does in the renderer.
 */
export function linkTargetOf(attrs: unknown): LinkTarget | null {
  if (!isRecord(attrs)) return null;
  const { href, pageId } = attrs;
  const target = attrs['target'] === '_blank' ? '_blank' : null;
  if (typeof pageId === 'string' && PAGE_ID_PATTERN.test(pageId)) {
    return { href: null, pageId, target };
  }
  if (typeof href === 'string' && isAllowedHref(href)) {
    return { href, pageId: null, target };
  }
  return null;
}

const CLICK_KEY = new PluginKey('themedLinkClick');

export const ThemedLink = Link.extend<ThemedLinkOptions>({
  addOptions() {
    return {
      // A link is made by the popover only: nothing links on its own.
      autolink: false,
      openOnClick: false,
      linkOnPaste: false,
      markdownLinks: false,
      enableClickSelection: false,
      protocols: [],
      defaultProtocol: 'https',
      HTMLAttributes: {},
      isAllowedUri: (url) => isAllowedHref(url),
      validate: (url) => isAllowedHref(url),
      shouldAutoLink: () => false,
      onOpen: null,
    };
  },

  addAttributes() {
    // Filled from the element by `parseHTML` below, never from a plain
    // attribute of the same name, and written by `renderHTML`.
    return {
      href: { default: null, rendered: false, parseHTML: () => null },
      pageId: { default: null, rendered: false, parseHTML: () => null },
      target: { default: null, rendered: false, parseHTML: () => null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'a',
        getAttrs: (node) => {
          const read = readTarget(node as HTMLElement);
          return read === false ? false : { ...read };
        },
      },
    ];
  },

  renderHTML({ mark }) {
    const target = linkTargetOf(mark.attrs);
    const written: Record<string, string> = {};
    if (target !== null) {
      if (target.pageId !== null) {
        // The visitor page resolves the id to the page's current path. In the
        // field there is no navigation, but an `a` without an address would
        // lose the site's link styling.
        written['href'] = PAGE_LINK_PLACEHOLDER;
        written['data-pk-page'] = target.pageId;
      } else if (target.href !== null) {
        written['href'] = target.href;
      }
      if (target.target === '_blank') {
        written['target'] = '_blank';
        written['rel'] = 'noopener noreferrer';
      }
    }
    return ['a', written, 0];
  },

  // The stock commands take a bare `href`; links are made through
  // `linkTransaction`, which knows both kinds of target.
  addCommands() {
    return {};
  },

  addPasteRules() {
    return [];
  },

  addInputRules() {
    return [];
  },

  addProseMirrorPlugins() {
    const { onOpen } = this.options;
    if (onOpen === null) return [];
    return [
      new Plugin({
        key: CLICK_KEY,
        props: {
          // A click on a link opens the popover and never navigates. The
          // target belongs to the framed document's realm, so it is checked
          // by shape, not with `instanceof`.
          handleClick(view, pos, event) {
            const element = event.target as Partial<Element> | null;
            if (event.button !== 0 || typeof element?.closest !== 'function') {
              return false;
            }
            const anchor = element.closest('a');
            if (anchor === null || !view.dom.contains(anchor)) return false;
            const { state } = view;
            view.dispatch(
              state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))),
            );
            onOpen();
            return true;
          },
          // `handleClick` only cancels ProseMirror's own handling. The click
          // itself must be cancelled too, or the shell's frame-link listener
          // (which skips a default-prevented click) would follow the address.
          handleDOMEvents: {
            click(view, event) {
              const element = event.target as Partial<Element> | null;
              if (typeof element?.closest !== 'function') return false;
              const anchor = element.closest('a');
              if (anchor !== null && view.dom.contains(anchor)) {
                event.preventDefault();
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

/**
 * What a link command applies to.
 *
 * - `edit`: the selection lies in an existing link, whose whole extent is the
 *   range.
 * - `selection`: text is selected; the link covers it.
 * - `caret`: nothing is selected; applying inserts the link's text.
 */
export type LinkContext =
  | {
      readonly kind: 'edit';
      readonly from: number;
      readonly to: number;
      readonly target: LinkTarget;
    }
  | { readonly kind: 'selection'; readonly from: number; readonly to: number }
  | { readonly kind: 'caret'; readonly from: number; readonly to: number };

function linkType(state: EditorState): MarkType | undefined {
  return state.schema.marks['link'];
}

/**
 * Where a link command applies, or null when the schema has no link. A caret
 * at either end of a link counts as in it, so the key and the button edit the
 * link the caret touches.
 */
export function linkContext(state: EditorState): LinkContext | null {
  const type = linkType(state);
  if (type === undefined) return null;
  const { from, to, empty } = state.selection;
  const extent = getMarkRange(state.doc.resolve(from), type);
  if (extent !== undefined && to <= extent.to) {
    const mark = state.doc
      .nodeAt(extent.from)
      ?.marks.find((candidate) => candidate.type === type);
    const target = linkTargetOf(mark?.attrs);
    // A stored link the policy no longer accepts is edited as a new one.
    if (target !== null) {
      return { kind: 'edit', from: extent.from, to: extent.to, target };
    }
  }
  return { kind: empty ? 'caret' : 'selection', from, to };
}

/**
 * Builds the transaction that applies `target` in `context`: over the
 * selection, over an existing link's whole extent, or, at a bare caret, as
 * new text (`title`, else the address) that carries the link. Null when there
 * is nothing to link.
 */
export function linkTransaction(
  state: EditorState,
  context: LinkContext,
  target: LinkTarget,
  title: string | null,
): Transaction | null {
  const type = linkType(state);
  if (type === undefined) return null;
  const mark = type.create({
    href: target.href,
    pageId: target.pageId,
    target: target.target,
  });
  const { tr } = state;
  if (context.kind === 'caret') {
    const text = title !== null && title.trim() !== '' ? title : target.href;
    if (text === null || text === '') return null;
    tr.insertText(text, context.from);
    tr.addMark(context.from, context.from + text.length, mark);
    tr.setSelection(TextSelection.create(tr.doc, context.from + text.length));
    // Typing goes on after the link, not inside it.
    tr.removeStoredMark(type);
    return tr;
  }
  if (context.from === context.to) return null;
  tr.removeMark(context.from, context.to, type);
  tr.addMark(context.from, context.to, mark);
  return tr;
}

/** Builds the transaction that takes the link off an existing link's extent. */
export function unlinkTransaction(
  state: EditorState,
  context: LinkContext,
): Transaction | null {
  const type = linkType(state);
  if (type === undefined || context.kind !== 'edit') return null;
  return state.tr.removeMark(context.from, context.to, type);
}
