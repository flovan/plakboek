/**
 * Which pages a block forest links to. A rich text link, a call to action and
 * a `link` field all hold a page row id, and the renderer is synchronous, so
 * a render resolves every id in one batch before it starts. This module only
 * finds the ids; it never touches the database.
 */
import {
  collectRichTextPageIds,
  PAGE_ID_PATTERN,
} from '@plakboek/content/rich-text';
import type { BlockDefinition } from '@plakboek/pages';

/** The node shape a snapshot block and a live tree node both satisfy. */
type LinkedNode = {
  readonly blockType: string;
  readonly props: unknown;
  readonly children: readonly LinkedNode[];
};

/** A repeater item nests at most this deep; deeper values are ignored. */
const MAX_FIELD_DEPTH = 4;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Note = (candidate: unknown) => void;

function collectFromField(
  fieldType: string,
  options: unknown,
  value: unknown,
  note: Note,
  depth: number,
): void {
  if (fieldType === 'rich_text') {
    for (const id of collectRichTextPageIds(value)) note(id);
    return;
  }
  if (fieldType === 'link') {
    if (isRecord(value)) note(value.pageId);
    return;
  }
  if (fieldType !== 'repeater' || depth >= MAX_FIELD_DEPTH) return;
  if (!Array.isArray(value) || !isRecord(options)) return;
  const fields: unknown = options.fields;
  if (!Array.isArray(fields)) return;
  for (const item of value as readonly unknown[]) {
    if (!isRecord(item)) continue;
    for (const field of fields as readonly unknown[]) {
      if (
        !isRecord(field) ||
        typeof field.key !== 'string' ||
        typeof field.fieldType !== 'string'
      ) {
        continue;
      }
      collectFromField(
        field.fieldType,
        field.options,
        item[field.key],
        note,
        depth + 1,
      );
    }
  }
}

/**
 * Each distinct page id held by the `rich_text`, `link` and `repeater`
 * properties of a block forest, once, in first-seen order. A block type the
 * definitions do not know contributes nothing.
 */
export function collectPageLinkIds(
  blocks: readonly LinkedNode[],
  definitions: ReadonlyMap<string, Pick<BlockDefinition, 'properties'>>,
): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const note: Note = (candidate) => {
    if (
      typeof candidate === 'string' &&
      PAGE_ID_PATTERN.test(candidate) &&
      !seen.has(candidate)
    ) {
      seen.add(candidate);
      found.push(candidate);
    }
  };
  const visit = (node: LinkedNode): void => {
    const definition = definitions.get(node.blockType);
    if (definition !== undefined && isRecord(node.props)) {
      for (const [key, property] of Object.entries(definition.properties)) {
        const value = node.props[key];
        if (value === undefined || value === null) continue;
        collectFromField(property.fieldType, property.options, value, note, 0);
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const block of blocks) visit(block);
  return found;
}
