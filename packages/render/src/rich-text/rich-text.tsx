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
  isEmptyRichTextDocument,
  TEXT_ALIGNS,
} from '@plakboek/content/rich-text';
import type { TextAlign } from '@plakboek/content/rich-text';
import { useTextEnvironment, type TextEnvironment } from './environment.js';

type Json = Readonly<Record<string, unknown>>;

/** Deeper than the validator allows; a hostile document stops here. */
const MAX_DEPTH = 48;

/** A type name as it may appear in a report: bounded, never a document. */
const NAME_MAX_LENGTH = 64;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Json[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [];
}

function nameOf(node: Json): string {
  return typeof node.type === 'string'
    ? node.type.slice(0, NAME_MAX_LENGTH)
    : 'unknown';
}

function alignOf(node: Json): TextAlign | null {
  const align = isRecord(node.attrs) ? node.attrs.textAlign : null;
  return (TEXT_ALIGNS as readonly unknown[]).includes(align)
    ? (align as TextAlign)
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

function renderInline(
  content: unknown,
  environment: TextEnvironment,
  depth: number,
): ReactNode[] {
  return records(content).map((node, index) =>
    renderNode(node, index, environment, depth + 1),
  );
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
      const level = isRecord(node.attrs) ? node.attrs.level : undefined;
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
    default:
      return null;
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
  for (let index = 0; index < end; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const rendered = renderNode(node, index, environment, depth + 1);
    if (rendered !== null) out.push(rendered);
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
