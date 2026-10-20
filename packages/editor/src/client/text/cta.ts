/**
 * The call-to-action node of a text flow: a block-level atom with a label, a
 * link target and a variant of the theme, standing on its own line between
 * paragraphs. Adjacent CTAs read as one row on the page because their node
 * views flow side by side; the stored document is just the nodes in order.
 *
 * Nothing the node holds is trusted. A target is kept only when it passes the
 * shared href policy or is a page id, a variant only when the theme lists it,
 * and a label is plain text capped at 200 UTF-16 code units, the same cap the
 * server checks. The commands are plain ProseMirror functions over
 * `EditorState`, with no DOM, so they are proven in Node.
 */
import { Node } from '@tiptap/core';
import type { Node as PMNode, NodeType } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import {
  isAllowedHref,
  PAGE_ID_PATTERN,
  type LinkTarget,
  type TextTheme,
} from '@plakboek/content/rich-text';
import { STRINGS } from '../../chrome/strings.js';

/** The longest label, in UTF-16 code units: the stored document's own cap. */
export const CTA_LABEL_MAX_LENGTH = 200;

/** Set on the transaction that inserts a CTA, so the editor can open its popover. */
export const CTA_INSERTED = 'plakboekCtaInserted';

export type CtaAttributes = {
  readonly label: string;
  readonly href: string | null;
  readonly pageId: string | null;
  readonly target: '_blank' | null;
  readonly variant: string;
};

type CtaOptions = {
  /** The variants the theme lists; the first is the default of a new CTA. */
  variants: readonly string[];
  /** A click on a CTA: the field opens its Button popover. */
  onOpen: (() => void) | null;
};

declare module '@tiptap/core' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- an interface is what merges into the editor's command map
  interface Commands<ReturnType> {
    cta: {
      /** Puts a CTA on its own line at the selection and selects it. */
      insertCta: () => ReturnType;
      /** Changes the attributes of the selected CTA. */
      updateCta: (attributes: Partial<CtaAttributes>) => ReturnType;
    };
  }
}

/** The label cut to its cap without splitting a surrogate pair. */
export function capLabel(label: string): string {
  if (label.length <= CTA_LABEL_MAX_LENGTH) return label;
  const cut = label.slice(0, CTA_LABEL_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The attributes of a CTA node as a stored target; null when it holds neither
 * a page id nor an address the policy allows. A page id wins, as it does in
 * the renderer.
 */
export function ctaTargetOf(attrs: unknown): LinkTarget | null {
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

/** The theme's variant when it lists it, else its first. */
function variantIn(
  variants: readonly string[],
  value: string | null,
): string | null {
  if (value !== null && variants.includes(value)) return value;
  return variants[0] ?? null;
}

const SELECT_KEY = new PluginKey('ctaClick');

export const CtaNode = Node.create<CtaOptions>({
  name: 'cta',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  // Before the field's own keymap, which would otherwise take Mod-K.
  priority: 200,

  addOptions() {
    return { variants: [], onOpen: null };
  },

  addAttributes() {
    const first = this.options.variants[0] ?? '';
    // Filled from the element by the node's `parseHTML` below, never from a
    // plain attribute of the same name (a null here leaves that result alone),
    // and written by `renderHTML`.
    return {
      label: { default: '', rendered: false, parseHTML: () => null },
      href: { default: null, rendered: false, parseHTML: () => null },
      pageId: { default: null, rendered: false, parseHTML: () => null },
      target: { default: null, rendered: false, parseHTML: () => null },
      variant: { default: first, rendered: false, parseHTML: () => null },
    };
  },

  parseHTML() {
    const { variants } = this.options;
    return [
      {
        tag: '[data-pk-cta]',
        getAttrs: (node) => {
          const element = node as HTMLElement;
          const variant = variantIn(
            variants,
            element.getAttribute('data-variant'),
          );
          if (variant === null) return false;
          const target = ctaTargetOf({
            href: element.getAttribute('data-href'),
            pageId: element.getAttribute('data-page-id'),
            target: element.getAttribute('data-target'),
          });
          return {
            label: capLabel(element.getAttribute('data-label') ?? ''),
            href: target?.href ?? null,
            pageId: target?.pageId ?? null,
            target: target?.target ?? null,
            variant,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const written: Record<string, string> = { 'data-pk-cta': '' };
    const attrs: unknown = node.attrs;
    const label = isRecord(attrs) ? attrs['label'] : '';
    if (typeof label === 'string') written['data-label'] = capLabel(label);
    const target = ctaTargetOf(attrs);
    if (target !== null) {
      if (target.pageId !== null) written['data-page-id'] = target.pageId;
      else if (target.href !== null) written['data-href'] = target.href;
      if (target.target === '_blank') written['data-target'] = '_blank';
    }
    const variant = isRecord(attrs) ? attrs['variant'] : null;
    if (typeof variant === 'string') written['data-variant'] = variant;
    return ['div', written];
  },

  addCommands() {
    return {
      insertCta:
        () =>
        ({ tr }) =>
          placeCta(tr, this.type, {
            label: STRINGS['text.cta.defaultLabel'],
            variant: this.options.variants[0] ?? '',
          }) !== null,
      updateCta:
        (attributes) =>
        ({ tr }) =>
          changeCta(tr, attributes, this.options.variants),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Enter on a selected CTA starts a paragraph below it.
      Enter: () => {
        const { state, view } = this.editor;
        const tr = paragraphAfterCta(state);
        if (tr === null) return false;
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      // The keyboard's way to the Button popover of a selected CTA.
      'Mod-k': () => {
        if (selectedCta(this.editor.state) === null) return false;
        const { onOpen } = this.options;
        if (onOpen === null) return false;
        onOpen();
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const { onOpen } = this.options;
    return [
      new Plugin({
        key: SELECT_KEY,
        props: {
          // A click selects the CTA and opens its popover, once.
          handleClickOn(view, _pos, node, nodePos, event) {
            if (node.type.name !== 'cta' || event.button !== 0) return false;
            const { state } = view;
            view.dispatch(
              state.tr.setSelection(NodeSelection.create(state.doc, nodePos)),
            );
            onOpen?.();
            return true;
          },
        },
      }),
    ];
  },
});

/** The CTA extension for a theme: its variants fix the default and the allowed set. */
export function createCtaNode(
  theme: TextTheme,
  hooks: { readonly onOpen?: (() => void) | undefined } = {},
): Node<CtaOptions> {
  return CtaNode.configure({
    variants: theme.ctaVariants.map((entry) => entry.value),
    onOpen: hooks.onOpen ?? null,
  });
}

function ctaType(state: EditorState): NodeType | undefined {
  return state.schema.nodes['cta'];
}

/** The selected CTA and where it sits; null when the selection is anything else. */
export function selectedCta(
  state: EditorState,
): { readonly node: PMNode; readonly pos: number } | null {
  const { selection } = state;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === 'cta'
  ) {
    return { node: selection.node, pos: selection.from };
  }
  return null;
}

/**
 * Puts a CTA on its own line: in place of an empty paragraph, else after the
 * top-level block the selection is in. The CTA is selected, and a paragraph is
 * kept after a trailing one so the caret has somewhere to go. Returns where
 * the CTA now is, or null when there is no CTA type.
 */
function placeCta(
  tr: Transaction,
  type: NodeType,
  attrs: Partial<CtaAttributes>,
): number | null {
  const { selection } = tr;
  const node = type.createAndFill(attrs);
  if (node === null) return null;
  const { $from } = selection;
  let pos: number;
  if (
    !(selection instanceof NodeSelection) &&
    $from.depth === 1 &&
    $from.parent.isTextblock &&
    $from.parent.content.size === 0
  ) {
    pos = $from.before(1);
    tr.replaceWith(pos, $from.after(1), node);
  } else {
    pos = $from.depth >= 1 ? $from.after(1) : selection.to;
    tr.insert(pos, node);
  }
  const last = tr.doc.lastChild;
  if (last !== null && last.type === type) {
    const paragraph = tr.doc.type.schema.nodes['paragraph']?.create();
    if (paragraph !== undefined) tr.insert(tr.doc.content.size, paragraph);
  }
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  tr.setMeta(CTA_INSERTED, pos);
  return pos;
}

/** Inserts a CTA at the selection; false when the schema has none. */
export function insertCta(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  attrs: Partial<CtaAttributes> = {},
): boolean {
  const type = ctaType(state);
  if (type === undefined) return false;
  const tr = state.tr;
  const at = placeCta(tr, type, attrs);
  if (at === null) return false;
  dispatch?.(tr);
  return true;
}

/**
 * Applies the attributes to the selected CTA on `tr`. A variant the theme does
 * not list and a target the policy refuses are not applied (the old value
 * stays); a label over the cap is cut. An empty `variants` list accepts any.
 */
function changeCta(
  tr: Transaction,
  attributes: Partial<CtaAttributes>,
  variants: readonly string[],
): boolean {
  const { selection } = tr;
  if (
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== 'cta'
  ) {
    return false;
  }
  const next: Record<string, unknown> = { ...selection.node.attrs };
  if (attributes.label !== undefined)
    next['label'] = capLabel(attributes.label);
  if (
    attributes.variant !== undefined &&
    (variants.length === 0 || variants.includes(attributes.variant))
  ) {
    next['variant'] = attributes.variant;
  }
  if (
    attributes.href !== undefined ||
    attributes.pageId !== undefined ||
    attributes.target !== undefined
  ) {
    // A target is applied whole, and only when it is one the policy allows.
    const target = ctaTargetOf({
      href: attributes.href ?? null,
      pageId: attributes.pageId ?? null,
      target: attributes.target ?? null,
    });
    if (target !== null) {
      next['href'] = target.href;
      next['pageId'] = target.pageId;
      next['target'] = target.target;
    }
  }
  const pos = selection.from;
  tr.setNodeMarkup(pos, undefined, next);
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  return true;
}

/** Changes the selected CTA; false (nothing dispatched) when none is selected. */
export function updateCta(
  attributes: Partial<CtaAttributes>,
  variants: readonly string[],
): (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean {
  return (state, dispatch) => {
    if (selectedCta(state) === null) return false;
    const tr = state.tr;
    if (!changeCta(tr, attributes, variants)) return false;
    dispatch?.(tr);
    return true;
  };
}

/** A transaction that starts a paragraph below the selected CTA and puts the caret in it. */
export function paragraphAfterCta(state: EditorState): Transaction | null {
  const selected = selectedCta(state);
  const paragraph = state.schema.nodes['paragraph'];
  if (selected === null || paragraph === undefined) return null;
  const at = selected.pos + selected.node.nodeSize;
  const tr = state.tr.insert(at, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, at + 1));
}

/**
 * A transaction that moves the caret to the line below the selected CTA, for
 * Done: the paragraph after it, which a trailing CTA always has.
 */
export function caretAfterCta(state: EditorState): Transaction | null {
  const selected = selectedCta(state);
  if (selected === null) return null;
  const at = selected.pos + selected.node.nodeSize;
  return state.tr.setSelection(Selection.near(state.doc.resolve(at), 1));
}

/** A transaction that removes the selected CTA. */
export function removeCta(state: EditorState): Transaction | null {
  const selected = selectedCta(state);
  if (selected === null) return null;
  return state.tr.delete(selected.pos, selected.pos + selected.node.nodeSize);
}
