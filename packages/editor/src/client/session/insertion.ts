/**
 * Adding to the page, decided apart from the DOM: which gaps between siblings
 * take a new item, which types may go into a gap (the same placement rule the
 * engine enforces), how the picker and the palette group and search them,
 * where a palette row lands relative to the selection, and the node a new item
 * starts as. The insert points, the picker, the empty prompts, the toolbar and
 * the keyboard all read these, so they cannot disagree.
 */
import type {
  CatalogueEntry,
  EditNode,
  EditPosition,
} from '../../api-types.js';
import { STRINGS } from '../../chrome/strings.js';
import { buildUndoEntry, type UndoEntry } from './inverse.js';
import { canPlace, legalTypesAt, type LegalityContext } from './legality.js';
import type { Intent } from './save-queue.js';
import type { Selection } from './scope.js';
import type { TreeModel } from './tree-model.js';

/** A gap in one sibling list: the parent, the neighbours on each side and what a new item there is called. */
export type InsertSlot = {
  readonly parentId: string | null;
  readonly previousId: string | null;
  readonly nextId: string | null;
  /** `section` at the page root, `item` under a block, else `block`. */
  readonly level: 'section' | 'block' | 'item';
};

/** A group of types under one category label, in the order the list shows them. */
export type PickerGroup = {
  readonly category: string;
  readonly entries: readonly CatalogueEntry[];
};

function levelOf(
  ctx: LegalityContext,
  parentId: string | null,
): InsertSlot['level'] {
  if (parentId === null) return 'section';
  return ctx.model.get(parentId)?.kind === 'block' ? 'item' : 'block';
}

/** The identity of a slot, for telling two slots apart and finding one again. */
export function slotKey(slot: InsertSlot): string {
  return `${slot.parentId ?? 'page'}:${slot.previousId ?? ''}:${slot.nextId ?? ''}`;
}

/** Where a new item goes for a slot, as the edit request names it. */
export function slotPosition(slot: InsertSlot): EditPosition {
  return {
    parentId: slot.parentId,
    previousId: slot.previousId,
    nextId: slot.nextId,
  };
}

/**
 * The gaps of the children of one container: above the first, between each
 * pair and below the last. A container with no children has the one gap that
 * holds everything. A section's children are columns, whose gaps belong to the
 * column tools, so a section has none here.
 */
export function insertSlots(
  ctx: LegalityContext,
  scopeParentId: string | null,
): readonly InsertSlot[] {
  if (scopeParentId !== null) {
    const parent = ctx.model.get(scopeParentId);
    if (parent === undefined) return [];
    if (parent.kind === 'section' && ctx.columnsEnabled) return [];
  }
  const level = levelOf(ctx, scopeParentId);
  const children = ctx.model.childrenOf(scopeParentId);
  if (children.length === 0) {
    return [{ parentId: scopeParentId, previousId: null, nextId: null, level }];
  }
  const slots: InsertSlot[] = [];
  for (let at = 0; at <= children.length; at += 1) {
    slots.push({
      parentId: scopeParentId,
      previousId: children[at - 1]?.id ?? null,
      nextId: children[at]?.id ?? null,
      level,
    });
  }
  return slots;
}

/**
 * The gap right after an item, or after the last section when nothing is
 * given. A column has no such gap here: columns are added by the column tools.
 */
export function slotAfter(
  ctx: LegalityContext,
  id: string | null,
): InsertSlot | null {
  if (id === null) {
    const last = ctx.model.roots().at(-1);
    return {
      parentId: null,
      previousId: last?.id ?? null,
      nextId: null,
      level: 'section',
    };
  }
  const node = ctx.model.get(id);
  if (node === undefined || node.kind === 'column') return null;
  const siblings = ctx.model.childrenOf(node.parentId);
  const at = siblings.findIndex((sibling) => sibling.id === id);
  if (at === -1) return null;
  return {
    parentId: node.parentId,
    previousId: id,
    nextId: siblings[at + 1]?.id ?? null,
    level: levelOf(ctx, node.parentId),
  };
}

function categoryOf(entry: CatalogueEntry): string {
  const category = entry.editor.category?.trim() ?? '';
  return category === '' ? STRINGS['picker.other'] : category;
}

function matches(entry: CatalogueEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [entry.editor.label, entry.editor.description ?? '', entry.key].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

/**
 * Groups types by editor category. Categories come in the order the catalogue
 * first shows them and "Other", the home of the uncategorised, comes last;
 * `entries` inside a group keep the catalogue's order. Empty groups are left
 * out. `query` filters by label, description and key, ignoring case.
 */
export function groupEntries(
  ctx: LegalityContext,
  keys: readonly string[],
  query: string,
): readonly PickerGroup[] {
  const wanted = new Set(keys);
  const other = STRINGS['picker.other'];
  const order: string[] = [];
  const byCategory = new Map<string, CatalogueEntry[]>();
  for (const entry of ctx.catalogue.values()) {
    const category = categoryOf(entry);
    if (!order.includes(category)) order.push(category);
    if (entry.kind === 'column' || !wanted.has(entry.key)) continue;
    if (!matches(entry, query)) continue;
    const list = byCategory.get(category);
    if (list === undefined) byCategory.set(category, [entry]);
    else list.push(entry);
  }
  const ordered = [
    ...order.filter((category) => category !== other),
    ...order.filter((category) => category === other),
  ];
  const groups: PickerGroup[] = [];
  for (const category of ordered) {
    const found = byCategory.get(category);
    if (found !== undefined) groups.push({ category, entries: found });
  }
  return groups;
}

/** The types that may go into a gap, grouped and filtered for the picker. */
export function pickerGroups(
  ctx: LegalityContext,
  slot: InsertSlot,
  query: string,
): readonly PickerGroup[] {
  return groupEntries(ctx, legalTypesAt(ctx, slot.parentId), query);
}

/** Every type but the column, grouped and filtered, for the palette. */
export function paletteGroups(
  ctx: LegalityContext,
  query: string,
): readonly PickerGroup[] {
  return groupEntries(ctx, [...ctx.catalogue.keys()], query);
}

/** The one type a section gap offers, when it offers exactly one: the picker is skipped. */
export function soleSectionType(
  ctx: LegalityContext,
  slot: InsertSlot,
): CatalogueEntry | null {
  if (slot.level !== 'section') return null;
  const legal = legalTypesAt(ctx, slot.parentId)
    .map((key) => ctx.catalogue.get(key))
    .filter(
      (entry): entry is CatalogueEntry =>
        entry !== undefined && entry.kind !== 'column',
    );
  return legal.length === 1 ? (legal[0] ?? null) : null;
}

/**
 * Where a palette row of `type` lands: right after the selection, at the
 * nearest level (the selection's own, then each container above it) where the
 * type is legal. With nothing selected a section type goes to the end of the
 * page and nothing else has a place. Null when there is none.
 */
export function insertionTarget(
  ctx: LegalityContext,
  selection: Selection,
  type: string,
): EditPosition | null {
  const entry = ctx.catalogue.get(type);
  if (entry === undefined || entry.kind === 'column') return null;
  const { selectedId } = selection;

  if (selectedId === null || ctx.model.get(selectedId) === undefined) {
    if (entry.kind !== 'section' || !canPlace(ctx, type, null)) return null;
    return {
      parentId: null,
      previousId: ctx.model.roots().at(-1)?.id ?? null,
      nextId: null,
    };
  }

  let current = ctx.model.get(selectedId);
  while (current !== undefined) {
    const parentId = current.parentId;
    if (canPlace(ctx, type, parentId)) {
      const siblings = ctx.model.childrenOf(parentId);
      const at = siblings.findIndex((sibling) => sibling.id === current?.id);
      return {
        parentId,
        previousId: current.id,
        nextId: siblings[at + 1]?.id ?? null,
      };
    }
    current = parentId === null ? undefined : ctx.model.get(parentId);
  }
  return null;
}

/** The node a new item starts as: each property's default, and no children, so the server adds the starter ones. */
export function defaultNode(entry: CatalogueEntry, id: string): EditNode {
  const props: Record<string, unknown> = {};
  for (const property of entry.properties) {
    if (property.defaultValue !== undefined) {
      props[property.key] = property.defaultValue;
    }
  }
  return {
    id,
    type: entry.key,
    ...(Object.keys(props).length === 0 ? {} : { props }),
  };
}

/** The insert of a new item at a position, with its undo entry. */
export function insertActionFor(
  model: TreeModel,
  entry: CatalogueEntry,
  position: EditPosition,
  newId: string,
): { readonly intent: Intent; readonly entry: UndoEntry } {
  const intent: Intent = {
    kind: 'insert',
    position,
    node: defaultNode(entry, newId),
  };
  return {
    intent,
    entry: buildUndoEntry(intent, model, { kind: 'added', itemId: newId }),
  };
}
