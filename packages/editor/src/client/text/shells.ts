/**
 * Node and mark views derived from the host's own renderer components.
 *
 * Mounting the editor on a field must not move a single pixel of it, and a
 * click must land on the character that was clicked: both depend on the
 * editor's DOM being the host's markup (its elements, classes and spacing
 * rules), not ProseMirror's semantic defaults. So every node view is a shell
 * made by rendering the host's renderer once with a sentinel child into the
 * frame document, then cloned for each node of that kind.
 *
 * The sentinel's parent becomes the editable content area when the sentinel is
 * its only child (the renderer contract: children inside exactly one element).
 * A renderer that places the children beside other nodes keeps the sentinel as
 * a `display: contents` element, which takes no box of its own. A renderer
 * that does not wrap its children in an element at all, or renders nothing,
 * gets no shell and the editor falls back to its own default for that node.
 *
 * The editor client never imports `react-dom/server`: the shells are rendered
 * with `react-dom/client`, synchronously, into a detached container that is
 * thrown away as soon as its markup has been copied.
 */
import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  isCustomColorValue,
  isCustomSizeValue,
  TEXT_ALIGNS,
  TOKEN_PATTERN,
  type TextAlign,
} from '@plakboek/content/rich-text';
import type { TextRenderers } from '@plakboek/render';
import { linkTargetOf } from './link.js';

export type RendererShell = {
  readonly dom: HTMLElement;
  /** Where the node's content goes; absent for a node without content. */
  readonly contentDOM?: HTMLElement;
};

export type RendererShells = {
  /** A shell for the node, or null when the editor should use its default. */
  nodeView(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
  ): RendererShell | null;
  /** A shell for the mark, or null when the editor should use its default. */
  markView(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
  ): RendererShell | null;
  dispose(): void;
};

/** The attribute that marks the sentinel child inside a rendered template. */
const HOLE = 'data-pk-shell-hole';

type Template = {
  readonly root: HTMLElement;
  /** Child indices from `root` to the content element; empty means `root`. */
  readonly path: readonly number[];
};

function pathFrom(root: Node, node: Node): number[] {
  const path: number[] = [];
  let at: Node | null = node;
  while (at !== null && at !== root) {
    const parent: Node | null = at.parentNode;
    if (parent === null) return [];
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, at));
    at = parent;
  }
  return path;
}

function follow(root: HTMLElement, path: readonly number[]): HTMLElement {
  let at: Node = root;
  for (const index of path) {
    const next: ChildNode | undefined = at.childNodes[index];
    if (next === undefined) return root;
    at = next;
  }
  return at as HTMLElement;
}

/**
 * Renders `render(hole)` once into the frame document and keeps a clone of the
 * result. Returns null when the output has no single element root.
 */
function buildTemplate(
  frameDocument: Document,
  render: (hole: ReactNode) => ReactNode,
  withContent: boolean,
): Template | null {
  const container = frameDocument.createElement('div');
  const root = createRoot(container);
  let rendered: Element | null = null;
  try {
    flushSync(() => {
      root.render(
        render(
          withContent
            ? createElement('span', { [HOLE]: '' })
            : (null as ReactNode),
        ),
      );
    });
    rendered =
      container.childElementCount === 1 ? container.firstElementChild : null;
    const copy =
      rendered === null ? null : (rendered.cloneNode(true) as Element);
    if (copy === null) return null;
    if (!withContent) return { root: copy as HTMLElement, path: [] };
    const hole = copy.querySelector(`[${HOLE}]`);
    // A renderer that returned the children without an element of its own.
    if (hole === null || hole === copy) return null;
    const parent = hole.parentElement;
    if (parent === null) return null;
    if (parent.childNodes.length === 1) {
      // The only child: its parent is the content area and the sentinel goes.
      const path = pathFrom(copy, parent);
      parent.removeChild(hole);
      return { root: copy as HTMLElement, path };
    }
    // Beside other nodes: the sentinel stays, taking no box of its own.
    (hole as HTMLElement).removeAttribute(HOLE);
    (hole as HTMLElement).style.display = 'contents';
    return { root: copy as HTMLElement, path: pathFrom(copy, hole) };
  } catch {
    return null;
  } finally {
    try {
      flushSync(() => {
        root.unmount();
      });
    } catch {
      // The container is thrown away either way.
    }
  }
}

function instantiate(template: Template, withContent: boolean): RendererShell {
  const dom = template.root.cloneNode(true) as HTMLElement;
  return withContent
    ? { dom, contentDOM: follow(dom, template.path) }
    : { dom };
}

/**
 * What a CTA is drawn in: an inline-flex wrapper around the renderer's element,
 * with the row gap as its right margin, so adjacent CTAs sit side by side and
 * wrap like the visitor page's row. The vertical gap and the space above the
 * first one are the host field's own sibling spacing rule.
 */
function ctaWrapper(frameDocument: Document, template: Template): HTMLElement {
  const wrapper = frameDocument.createElement('span');
  wrapper.setAttribute('data-pk-cta-wrap', '');
  wrapper.style.display = 'inline-flex';
  wrapper.style.verticalAlign = 'top';
  wrapper.style.marginRight = '16px';
  wrapper.style.maxWidth = '100%';
  wrapper.append(instantiate(template, false).dom);
  return wrapper;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function alignOf(value: unknown): TextAlign | null {
  return TEXT_ALIGNS.find((align) => align === value) ?? null;
}

/**
 * The token or the literal of a colour or size mark, exactly one of them and
 * only when it is valid; null when the mark holds neither, so a stored value
 * that is not valid never reaches a host renderer.
 */
function styleChoiceOf(
  attrs: Readonly<Record<string, unknown>>,
  isLiteral: (value: string) => boolean,
): { token: string | null; value: string | null } | null {
  const { token, value } = attrs;
  if (typeof token === 'string' && TOKEN_PATTERN.test(token)) {
    return { token, value: null };
  }
  if (typeof value === 'string' && isLiteral(value)) {
    return { token: null, value };
  }
  return null;
}

export function createRendererShells(
  renderers: TextRenderers,
  frameDocument: Document,
): RendererShells {
  const cache = new Map<string, Template | null>();

  function templateFor(
    key: string,
    render: (hole: ReactNode) => ReactNode,
    withContent: boolean,
  ): Template | null {
    if (cache.has(key)) return cache.get(key) ?? null;
    const template = buildTemplate(frameDocument, render, withContent);
    cache.set(key, template);
    return template;
  }

  function shellFor(
    key: string,
    render: (hole: ReactNode) => ReactNode,
    withContent: boolean,
  ): RendererShell | null {
    const template = templateFor(key, render, withContent);
    return template === null ? null : instantiate(template, withContent);
  }

  return {
    nodeView(name, attrs) {
      switch (name) {
        case 'paragraph': {
          const textAlign = alignOf(attrs['textAlign']);
          return shellFor(
            `paragraph:${textAlign ?? ''}`,
            (children) => renderers.paragraph({ children, textAlign }),
            true,
          );
        }
        case 'heading': {
          const raw = numberOf(attrs['level'], 2);
          const level = raw === 3 ? 3 : raw === 4 ? 4 : 2;
          const textAlign = alignOf(attrs['textAlign']);
          return shellFor(
            `heading:${level}:${textAlign ?? ''}`,
            (children) => renderers.heading({ level, textAlign, children }),
            true,
          );
        }
        case 'bulletList':
          return shellFor(
            'bulletList',
            (children) => renderers.bulletList({ children }),
            true,
          );
        case 'orderedList': {
          const start = numberOf(attrs['start'], 1);
          return shellFor(
            `orderedList:${start}`,
            (children) => renderers.orderedList({ start, children }),
            true,
          );
        }
        case 'listItem':
          return shellFor(
            'listItem',
            (children) => renderers.listItem({ children }),
            true,
          );
        case 'blockquote':
          return shellFor(
            'blockquote',
            (children) => renderers.blockquote({ children }),
            true,
          );
        case 'horizontalRule':
          return shellFor(
            'horizontalRule',
            () => renderers.horizontalRule({}),
            false,
          );
        case 'hardBreak':
          return shellFor('hardBreak', () => renderers.hardBreak({}), false);
        case 'cta': {
          // One render per node: the label and variant differ, and a label is
          // free text, so a cache keyed by it would only grow.
          const label =
            typeof attrs['label'] === 'string' ? attrs['label'] : '';
          const variant =
            typeof attrs['variant'] === 'string' ? attrs['variant'] : '';
          const template = buildTemplate(
            frameDocument,
            () => renderers.cta({ label, href: null, target: null, variant }),
            false,
          );
          return template === null
            ? null
            : { dom: ctaWrapper(frameDocument, template) };
        }
        default:
          return null;
      }
    },
    markView(name, attrs) {
      switch (name) {
        case 'bold':
          return shellFor(
            'bold',
            (children) => renderers.bold({ children }),
            true,
          );
        case 'italic':
          return shellFor(
            'italic',
            (children) => renderers.italic({ children }),
            true,
          );
        case 'underline':
          return shellFor(
            'underline',
            (children) => renderers.underline({ children }),
            true,
          );
        case 'strike':
          return shellFor(
            'strike',
            (children) => renderers.strike({ children }),
            true,
          );
        case 'link': {
          const target = linkTargetOf(attrs);
          if (target === null) return null;
          // A page link has no address of its own while it is edited.
          const href = target.pageId === null ? (target.href ?? '#') : '#';
          const shell = shellFor(
            `link:${target.pageId === null ? 'href' : 'page'}:${target.target ?? ''}:${href}`,
            (children) =>
              renderers.link({ href, target: target.target, children }),
            true,
          );
          // The click that opens the popover and the frame-link cancel both
          // look for the nearest anchor: a renderer without one keeps the
          // editor's own.
          const anchor = shell?.contentDOM?.closest('a') ?? null;
          return anchor === null ? null : shell;
        }
        case 'textColor':
        case 'textSize': {
          const choice = styleChoiceOf(
            attrs,
            name === 'textColor' ? isCustomColorValue : isCustomSizeValue,
          );
          if (choice === null) return null;
          const { token, value } = choice;
          return shellFor(
            `${name}:${token === null ? 'value' : 'token'}:${token ?? value}`,
            (children) =>
              name === 'textColor'
                ? renderers.textColor({ token, value, children })
                : renderers.textSize({ token, value, children }),
            true,
          );
        }
        default:
          return null;
      }
    },
    dispose() {
      cache.clear();
    },
  };
}
