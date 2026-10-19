/**
 * `<RichText value />`: renders a stored rich-text document to React elements
 * through the environment's renderer map. It adds no wrapper element: the
 * host's own field element (the one carrying `edit.field()`) is the root the
 * editor mounts on, and the document's top-level nodes are its children.
 *
 * The walk only ever builds React elements and passes text as children, so
 * nothing stored can become markup. Whatever it does not understand it keeps
 * as text and skips the rest, and it never throws on a stored shape.
 */
import { Fragment, createElement, type Key, type ReactNode } from 'react';
import {
  isAllowedHref,
  isCustomColorValue,
  isCustomSizeValue,
  isEmptyRichTextDocument,
  TEXT_ALIGNS,
  TOKEN_PATTERN,
  type TextAlign,
} from '@plakboek/content/rich-text';
import { renderCta } from './cta.js';
import { useTextEnvironment, type TextEnvironment } from './environment.js';
import { resolveTarget } from './target.js';

type Json = Readonly<Record<string, unknown>>;

/** Deeper than the validator allows; a hostile document stops here. */
const MAX_DEPTH = 48;

/** The most nodes read when collecting the text of an unknown node. */
const MAX_TEXT_NODES = 10_000;

/** A type name as it may appear in a report: bounded, never a document. */
const NAME_MAX_LENGTH = 64;

const ORDERED_LIST_START_MAX = 1_000_000;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Json[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [];
}

function attrsOf(node: Json): Json {
  return isRecord(node.attrs) ? node.attrs : {};
}

function nameOf(node: Json): string {
  return typeof node.type === 'string'
    ? node.type.slice(0, NAME_MAX_LENGTH)
    : 'unknown';
}

function alignOf(node: Json): TextAlign | null {
  const align = attrsOf(node).textAlign;
  return (TEXT_ALIGNS as readonly unknown[]).includes(align)
    ? (align as TextAlign)
    : null;
}

type StyleValue = {
  readonly token: string | null;
  readonly value: string | null;
};

/**
 * A colour or size mark's value: a token that matches the token pattern or a
 * literal that passes its strict check, never both. Anything else is `null`
 * and the mark is dropped, so nothing unchecked reaches a style attribute.
 */
function styleValueOf(
  attrs: Json,
  isLiteral: (value: string) => boolean,
): StyleValue | null {
  const { token, value } = attrs;
  if (token !== undefined && token !== null) {
    return typeof token === 'string' && TOKEN_PATTERN.test(token)
      ? { token, value: null }
      : null;
  }
  return typeof value === 'string' && isLiteral(value)
    ? { token: null, value }
    : null;
}

function applyMark(
  mark: Json,
  children: ReactNode,
  environment: TextEnvironment,
): ReactNode {
  const { renderers } = environment;
  switch (mark.type) {
    case 'bold':
      return createElement(renderers.bold, { children });
    case 'italic':
      return createElement(renderers.italic, { children });
    case 'underline':
      return createElement(renderers.underline, { children });
    case 'strike':
      return createElement(renderers.strike, { children });
    case 'link': {
      const resolved = resolveTarget(environment, mark.attrs);
      // A target the policy refuses (or a page that is gone) keeps the text.
      if (resolved === null || !isAllowedHref(resolved.href)) return children;
      return createElement(renderers.link, {
        href: resolved.href,
        target: resolved.target,
        children,
      });
    }
    case 'textColor': {
      const style = styleValueOf(attrsOf(mark), isCustomColorValue);
      return style === null
        ? children
        : createElement(renderers.textColor, { ...style, children });
    }
    case 'textSize': {
      const style = styleValueOf(attrsOf(mark), isCustomSizeValue);
      return style === null
        ? children
        : createElement(renderers.textSize, { ...style, children });
    }
    default:
      environment.report({ kind: 'mark', name: nameOf(mark) });
      return children;
  }
}

function renderText(
  node: Json,
  key: Key,
  environment: TextEnvironment,
): ReactNode {
  if (typeof node.text !== 'string' || node.text.length === 0) return null;
  const marks = records(node.marks);
  let rendered: ReactNode = node.text;
  // The first stored mark is the outermost, so wrap from the last inwards.
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    if (mark !== undefined) rendered = applyMark(mark, rendered, environment);
  }
  return createElement(Fragment, { key }, rendered);
}

/** The text of a node and everything below it, in document order. */
function textOf(node: Json): string {
  let out = '';
  const stack: unknown[] = [node];
  for (let read = 0; stack.length > 0 && read < MAX_TEXT_NODES; read += 1) {
    const current = stack.pop();
    if (!isRecord(current)) continue;
    if (typeof current.text === 'string') out += current.text;
    const { content } = current;
    if (Array.isArray(content)) {
      for (let index = content.length - 1; index >= 0; index -= 1) {
        stack.push(content[index]);
      }
    }
  }
  return out;
}

function renderInline(
  content: unknown,
  environment: TextEnvironment,
  depth: number,
): ReactNode[] {
  return records(content).map((node, index) =>
    renderNode(node, index, environment, depth + 1),
  );
}

function ctaInput(node: Json): {
  readonly label: unknown;
  readonly link: unknown;
  readonly variant: unknown;
} {
  const attrs = attrsOf(node);
  return {
    label: attrs.label,
    link: { href: attrs.href, pageId: attrs.pageId, target: attrs.target },
    variant: attrs.variant,
  };
}

function renderNode(
  node: Json,
  key: Key,
  environment: TextEnvironment,
  depth: number,
): ReactNode {
  if (depth > MAX_DEPTH) return null;
  const { renderers } = environment;
  switch (node.type) {
    case 'text':
      return renderText(node, key, environment);
    case 'paragraph':
      return createElement(renderers.paragraph, {
        key,
        textAlign: alignOf(node),
        children: renderInline(node.content, environment, depth),
      });
    case 'heading': {
      const { level } = attrsOf(node);
      const known = level === 2 || level === 3 || level === 4 ? level : null;
      // Level 1 belongs to the page title: anything outside 2-4 is an h2.
      if (known === null) environment.report({ kind: 'node', name: 'heading' });
      return createElement(renderers.heading, {
        key,
        level: known ?? 2,
        textAlign: alignOf(node),
        children: renderInline(node.content, environment, depth),
      });
    }
    case 'bulletList':
      return createElement(renderers.bulletList, {
        key,
        children: renderBlocks(node.content, environment, false, depth),
      });
    case 'orderedList': {
      const { start } = attrsOf(node);
      return createElement(renderers.orderedList, {
        key,
        start:
          typeof start === 'number' &&
          Number.isInteger(start) &&
          start >= 1 &&
          start <= ORDERED_LIST_START_MAX
            ? start
            : 1,
        children: renderBlocks(node.content, environment, false, depth),
      });
    }
    case 'listItem':
      return createElement(renderers.listItem, {
        key,
        children: renderBlocks(node.content, environment, false, depth),
      });
    case 'blockquote':
      return createElement(renderers.blockquote, {
        key,
        children: renderBlocks(node.content, environment, false, depth),
      });
    case 'horizontalRule':
      return createElement(renderers.horizontalRule, { key });
    case 'hardBreak':
      return createElement(renderers.hardBreak, { key });
    case 'cta':
      // A CTA reached outside a block list (inline) renders alone, not in a row.
      return renderCta(environment, ctaInput(node), key);
    default: {
      environment.report({ kind: 'node', name: nameOf(node) });
      const words = textOf(node);
      return words.length === 0
        ? null
        : createElement(Fragment, { key }, words);
    }
  }
}

/** The editor keeps one empty paragraph at the end of the document. */
function isTrailingArtefact(node: Json | undefined): boolean {
  return (
    node !== undefined &&
    node.type === 'paragraph' &&
    isEmptyRichTextDocument({ type: 'doc', content: [node] })
  );
}

/**
 * Block-level children. A run of adjacent CTAs becomes one `ctaRow`; any other
 * node closes the row. A CTA that renders nothing (unfinished, for a visitor)
 * leaves no gap in the run and no empty row.
 */
function renderBlocks(
  content: unknown,
  environment: TextEnvironment,
  top: boolean,
  depth: number,
): ReactNode[] {
  const nodes = records(content);
  const end =
    top && isTrailingArtefact(nodes[nodes.length - 1])
      ? nodes.length - 1
      : nodes.length;
  const out: ReactNode[] = [];
  let index = 0;
  while (index < end) {
    const node = nodes[index];
    if (node === undefined) {
      index += 1;
      continue;
    }
    if (node.type === 'cta') {
      const rowKey = index;
      const row: ReactNode[] = [];
      while (index < end && nodes[index]?.type === 'cta') {
        const current = nodes[index];
        const rendered =
          current === undefined
            ? null
            : renderCta(environment, ctaInput(current), index);
        if (rendered !== null) row.push(rendered);
        index += 1;
      }
      if (row.length > 0) {
        out.push(
          createElement(environment.renderers.ctaRow, {
            key: rowKey,
            children: row,
          }),
        );
      }
      continue;
    }
    const rendered = renderNode(node, index, environment, depth + 1);
    if (rendered !== null) out.push(rendered);
    index += 1;
  }
  return out;
}

export type RichTextProps = {
  /** A stored rich-text document; anything else renders nothing. */
  readonly value: unknown;
};

export function RichText({ value }: RichTextProps): ReactNode {
  const environment = useTextEnvironment();
  if (!isRecord(value) || value.type !== 'doc') return null;
  if (isEmptyRichTextDocument(value)) return null;
  return renderBlocks(value.content, environment, true, 0);
}
