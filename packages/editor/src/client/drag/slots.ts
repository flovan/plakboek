/**
 * Where a dragged item can land, decided from the page model and the boxes the
 * framed site draws, with no DOM of its own. Every candidate slot goes through
 * the same placement rule the engine enforces (`canPlace`, with the moved item
 * named so its own subtree is never a destination), so a line is only drawn
 * where the write would be accepted.
 *
 * A slot is a gap between the children of one container. Its position is
 * given in model order (the neighbours on each side), so the drop is a move
 * exactly as the toolbar's buttons produce one. The
 * boxes only decide which gap the pointer is nearest to and where the line is
 * drawn; an item the site renders at no size keeps its place in the order and
 * is skipped for geometry.
 */
import type { EditPosition, ModelNode } from '../../api-types.js';
import { formatString, STRINGS } from '../../chrome/strings.js';
import { siblingAxis, type Box, type Point } from '../overlay/geometry.js';
import { canPlace, type LegalityContext } from '../session/legality.js';
import { labelOf, type TreeModel } from '../session/tree-model.js';
import type { DragScene } from './scene.js';

/** What is being dragged: an item already on the page. New items come only from the page's add controls. */
export type DragSubject = { readonly kind: 'move'; readonly id: string };

/** The line drawn at a slot: its thickness. */
export const LINE_THICKNESS = 2;

/** A slot the pointer resolved to. `axis` is the direction the line runs: horizontal between stacked items, vertical between items side by side. */
export type DropSlot = {
  readonly position: EditPosition;
  readonly line: Box;
  readonly axis: 'horizontal' | 'vertical';
};

/** A slot the keyboard can step to; `line` is null where the site draws nothing to point at. */
export type KeyboardSlot = {
  readonly position: EditPosition;
  readonly line: Box | null;
  readonly axis: 'horizontal' | 'vertical' | null;
  /** The zero-based place the item would have among its new siblings, and how many siblings there would be. */
  readonly index: number;
  readonly total: number;
  readonly parentId: string | null;
  readonly parentLabel: string;
};

function typeOf(ctx: LegalityContext, subject: DragSubject): string | null {
  return ctx.model.get(subject.id)?.type ?? null;
}

function placeOptions(subject: DragSubject): { movingId?: string } {
  return { movingId: subject.id };
}

/** The children of a container the subject could sit among: the item being moved is not one of them. */
function siblingsFor(
  ctx: LegalityContext,
  parentId: string | null,
  subject: DragSubject,
): readonly ModelNode[] {
  return ctx.model
    .childrenOf(parentId)
    .filter((child) => child.id !== subject.id);
}

function positionAt(
  parentId: string | null,
  siblings: readonly ModelNode[],
  index: number,
): EditPosition {
  return {
    parentId,
    previousId: siblings[index - 1]?.id ?? null,
    nextId: siblings[index]?.id ?? null,
  };
}

/** Whether two positions name the same gap. */
export function samePosition(a: EditPosition, b: EditPosition): boolean {
  return (
    a.parentId === b.parentId &&
    a.previousId === b.previousId &&
    a.nextId === b.nextId
  );
}

/** The position an item holds now, as a move to it would name it: the neighbours it has today. */
export function currentPosition(
  model: TreeModel,
  id: string,
): EditPosition | null {
  const node = model.get(id);
  if (node === undefined) return null;
  const siblings = model.childrenOf(node.parentId);
  const at = siblings.findIndex((sibling) => sibling.id === id);
  if (at === -1) return null;
  return {
    parentId: node.parentId,
    previousId: siblings[at - 1]?.id ?? null,
    nextId: siblings[at + 1]?.id ?? null,
  };
}

/** Which way the children of a container run in the site: side by side or stacked. */
function runOf(
  ctx: LegalityContext,
  scene: DragScene,
  parentId: string | null,
): 'horizontal' | 'vertical' {
  const children = ctx.model.childrenOf(parentId);
  const boxes = children
    .map((child) => scene.rects.get(child.id))
    .filter((box): box is Box => box !== undefined);
  if (boxes.length >= 2) return siblingAxis(boxes);
  // Columns share a section's width unless the site stacks them, which two boxes would have shown.
  return children[0]?.kind === 'column' ? 'horizontal' : 'vertical';
}

function union(boxes: readonly Box[]): Box | null {
  const first = boxes[0];
  if (first === undefined) return null;
  let left = first.left;
  let top = first.top;
  let right = first.left + first.width;
  let bottom = first.top + first.height;
  for (const box of boxes) {
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

type Line = { readonly line: Box; readonly axis: 'horizontal' | 'vertical' };

/**
 * The line across the gap at `index` among `siblings`. It runs the width (or
 * height) of the container, between the nearest siblings the site draws on
 * each side. A container the site draws nothing in gets one across its middle.
 */
function lineAt(
  ctx: LegalityContext,
  scene: DragScene,
  parentId: string | null,
  siblings: readonly ModelNode[],
  index: number,
): Line | null {
  const boxOf = (node: ModelNode | undefined): Box | null =>
    node === undefined ? null : (scene.rects.get(node.id) ?? null);
  let previous: Box | null = null;
  for (let at = index - 1; at >= 0 && previous === null; at -= 1) {
    previous = boxOf(siblings[at]);
  }
  let next: Box | null = null;
  for (let at = index; at < siblings.length && next === null; at += 1) {
    next = boxOf(siblings[at]);
  }
  const own = parentId === null ? null : (scene.rects.get(parentId) ?? null);
  const extent =
    own ??
    union(
      ctx.model
        .childrenOf(parentId)
        .map((child) => scene.rects.get(child.id))
        .filter((box): box is Box => box !== undefined),
    );
  if (extent === null) return null;

  if (previous === null && next === null) {
    return {
      line: {
        left: extent.left,
        top: extent.top + extent.height / 2 - LINE_THICKNESS / 2,
        width: extent.width,
        height: LINE_THICKNESS,
      },
      axis: 'horizontal',
    };
  }
  if (runOf(ctx, scene, parentId) === 'vertical') {
    const y =
      previous !== null && next !== null
        ? (previous.top + previous.height + next.top) / 2
        : previous !== null
          ? previous.top + previous.height
          : (next?.top ?? 0);
    return {
      line: {
        left: extent.left,
        top: y - LINE_THICKNESS / 2,
        width: extent.width,
        height: LINE_THICKNESS,
      },
      axis: 'horizontal',
    };
  }
  const x =
    previous !== null && next !== null
      ? (previous.left + previous.width + next.left) / 2
      : previous !== null
        ? previous.left + previous.width
        : (next?.left ?? 0);
  return {
    line: {
      left: x - LINE_THICKNESS / 2,
      top: extent.top,
      width: LINE_THICKNESS,
      height: extent.height,
    },
    axis: 'vertical',
  };
}

/** The slot of `parentId` nearest to the pointer, by the middles of the siblings the site draws. */
function slotIn(
  ctx: LegalityContext,
  scene: DragScene,
  subject: DragSubject,
  parentId: string | null,
  point: Point,
): DropSlot | null {
  const siblings = siblingsFor(ctx, parentId, subject);
  const vertical = runOf(ctx, scene, parentId) === 'vertical';
  const coordinate = vertical ? point.y : point.x;
  let index = siblings.length;
  for (let at = 0; at < siblings.length; at += 1) {
    const box = scene.rects.get(siblings[at]?.id ?? '');
    if (box === undefined) continue;
    const middle = vertical
      ? box.top + box.height / 2
      : box.left + box.width / 2;
    if (coordinate < middle) {
      index = at;
      break;
    }
  }
  const drawn = lineAt(ctx, scene, parentId, siblings, index);
  if (drawn === null) return null;
  return { position: positionAt(parentId, siblings, index), ...drawn };
}

/** How far a point is from a box: nothing when it is inside. */
function distance(point: Point, box: Box): number {
  const dx = Math.max(box.left - point.x, 0, point.x - (box.left + box.width));
  const dy = Math.max(box.top - point.y, 0, point.y - (box.top + box.height));
  return Math.hypot(dx, dy);
}

/** The column of a section the pointer is nearest to, for a pointer over the section's own padding. */
function nearestColumn(
  ctx: LegalityContext,
  scene: DragScene,
  sectionId: string,
  point: Point,
): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const column of ctx.model.childrenOf(sectionId)) {
    const box = scene.rects.get(column.id);
    if (box === undefined) continue;
    const away = distance(point, box);
    if (away < bestDistance) {
      best = column.id;
      bestDistance = away;
    }
  }
  return best;
}

/**
 * The slot the pointer is at, or null where nothing may land. `chain` holds
 * the ids of the blocks under the pointer, innermost first. The deepest
 * container whose children may legally include the subject wins; a container
 * that refuses it (a heading, a section asked to hold a section, a nesting
 * cap) is passed over for the next one out, up to the page itself. `point` is
 * in the frame's coordinates, like the boxes.
 */
export function resolveDropSlot(
  ctx: LegalityContext,
  scene: DragScene,
  subject: DragSubject,
  point: Point,
  chain: readonly string[],
): DropSlot | null {
  const type = typeOf(ctx, subject);
  if (type === null) return null;
  const kind = ctx.catalogue.get(type)?.kind;
  const options = placeOptions(subject);
  const containers: readonly (string | null)[] = [...chain, null];
  for (const id of containers) {
    let container = id;
    // A plain block belongs in a column: over a section's padding the nearest column takes it.
    if (
      container !== null &&
      kind === 'block' &&
      ctx.columnsEnabled &&
      ctx.model.get(container)?.kind === 'section'
    ) {
      container = nearestColumn(ctx, scene, container, point) ?? container;
    }
    if (!canPlace(ctx, type, container, options)) continue;
    const slot = slotIn(ctx, scene, subject, container, point);
    if (slot !== null) return slot;
  }
  return null;
}

/**
 * Every slot the subject may land in, in document order: the page's own gaps,
 * then those of each container in turn. Each carries where the item would end
 * up and what holds it, for the announcement, and the line to draw where the
 * site shows something to point at.
 */
export function keyboardSlots(
  ctx: LegalityContext,
  scene: DragScene,
  subject: DragSubject,
): readonly KeyboardSlot[] {
  const type = typeOf(ctx, subject);
  if (type === null) return [];
  const options = placeOptions(subject);
  const containers: readonly (string | null)[] = [
    null,
    ...ctx.model.documentOrder().map((node) => node.id),
  ];
  const slots: KeyboardSlot[] = [];
  for (const parentId of containers) {
    if (!canPlace(ctx, type, parentId, options)) continue;
    const siblings = siblingsFor(ctx, parentId, subject);
    const parentLabel = labelTextOf(ctx, parentId);
    for (let index = 0; index <= siblings.length; index += 1) {
      const drawn = lineAt(ctx, scene, parentId, siblings, index);
      slots.push({
        position: positionAt(parentId, siblings, index),
        line: drawn?.line ?? null,
        axis: drawn?.axis ?? null,
        index,
        total: siblings.length + 1,
        parentId,
        parentLabel,
      });
    }
  }
  return slots;
}

/** What the chrome calls an item: the page for none, a numbered column, or the block's label. */
export function labelTextOf(ctx: LegalityContext, id: string | null): string {
  if (id === null) return STRINGS['label.page'];
  const label = labelOf(ctx.model, ctx.catalogue, id);
  return label.kind === 'column'
    ? formatString('label.column', { n: String(label.n) })
    : label.text;
}
