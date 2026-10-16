/**
 * The keyboard drag: the accessible parallel to the pointer drag and the move
 * buttons. Lifting an item builds the list of every slot it may land in, in
 * document order, with the slot it holds now selected. The arrow keys step
 * through that list (Up and Down by one, Left and Right across to the next
 * column or by one when the siblings sit side by side), each step is announced
 * and drawn, and a drop moves the item exactly as a pointer drop would.
 *
 * The order of the list comes from the model alone, so it does not change when
 * the frame scrolls to show a slot; only the lines do, and `redraw` reads them
 * again.
 */
import { formatString, STRINGS } from '../../chrome/strings.js';
import type { EditPosition } from '../../api-types.js';
import type { Box } from '../overlay/geometry.js';
import type { LegalityContext } from '../session/legality.js';
import type { DragScene } from './scene.js';
import {
  currentPosition,
  keyboardSlots,
  samePosition,
  type DragSubject,
  type KeyboardSlot,
} from './slots.js';

export type KeyboardDirection = 'up' | 'down' | 'left' | 'right';

export type KeyboardDragOptions = {
  readonly subject: DragSubject;
  /** What the announcements call the item. */
  readonly label: string;
  readonly ctx: () => LegalityContext | null;
  readonly sceneOf: () => DragScene | null;
  readonly announce: (text: string) => void;
  /** The slot to draw a line at, or null once the drag is over. */
  readonly onSlot: (slot: KeyboardSlot | null) => void;
  /** Called with the current line after a step, so the frame can scroll it into view. */
  readonly reveal: (line: Box) => void;
  readonly onDrop: (position: EditPosition) => void;
  /** Always called last, after a drop or a cancel. */
  readonly onEnd: () => void;
};

export type KeyboardDrag = {
  /** Builds the slots and announces the pick-up; false when there is nowhere to go. */
  lift(): boolean;
  step(direction: KeyboardDirection): void;
  drop(): void;
  cancel(): void;
  /** Draws the current slot again, after the frame scrolled. */
  redraw(): void;
  readonly lifted: boolean;
};

function middleOf(slot: KeyboardSlot): number | null {
  return slot.line === null ? null : slot.line.top + slot.line.height / 2;
}

/**
 * The index a step leads to, or the same one when there is nowhere to go.
 * Left and Right in a stack of items jump to the neighbouring column, to the
 * slot nearest the current line, and stay put when there is none.
 */
export function stepIndex(
  ctx: LegalityContext,
  slots: readonly KeyboardSlot[],
  current: number,
  direction: KeyboardDirection,
): number {
  const slot = slots[current];
  if (slot === undefined) return current;
  const clamp = (index: number): number =>
    Math.max(0, Math.min(slots.length - 1, index));
  const byOne = direction === 'up' || direction === 'left' ? -1 : 1;
  if (direction === 'up' || direction === 'down') return clamp(current + byOne);
  if (slot.axis === 'vertical') return clamp(current + byOne);

  // Across: the neighbouring container of the same kind, at the same height.
  const parent = slot.parentId === null ? null : ctx.model.get(slot.parentId);
  if (parent === null || parent === undefined) return current;
  const siblings = ctx.model.childrenOf(parent.parentId);
  const at = siblings.findIndex((sibling) => sibling.id === parent.id);
  for (
    let next = at + byOne;
    next >= 0 && next < siblings.length;
    next += byOne
  ) {
    const container = siblings[next];
    if (container === undefined || container.kind !== parent.kind) continue;
    const candidates = slots
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.parentId === container.id);
    if (candidates.length === 0) continue;
    const here = middleOf(slot);
    if (here === null) {
      const first = candidates[0];
      const sameIndex = candidates.find(
        ({ entry }) => entry.index === slot.index,
      );
      return (sameIndex ?? first)?.index ?? current;
    }
    let best = candidates[0];
    let bestGap = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const there = middleOf(candidate.entry);
      const gap =
        there === null ? Number.POSITIVE_INFINITY : Math.abs(there - here);
      if (gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }
    return best?.index ?? current;
  }
  return current;
}

function placeOf(slot: KeyboardSlot): {
  readonly position: string;
  readonly total: string;
  readonly parent: string;
} {
  return {
    position: String(slot.index + 1),
    total: String(slot.total),
    parent: slot.parentLabel,
  };
}

export function createKeyboardDrag(options: KeyboardDragOptions): KeyboardDrag {
  let slots: readonly KeyboardSlot[] = [];
  let current = 0;
  let lifted = false;

  function refresh(): void {
    const ctx = options.ctx();
    const scene = options.sceneOf();
    if (ctx === null || scene === null) return;
    slots = keyboardSlots(ctx, scene, options.subject);
  }

  function finish(): void {
    lifted = false;
    slots = [];
    options.onSlot(null);
    options.onEnd();
  }

  function show(reveal: boolean): void {
    const slot = slots[current];
    options.onSlot(slot ?? null);
    if (reveal && slot?.line !== null && slot?.line !== undefined) {
      options.reveal(slot.line);
    }
  }

  return {
    get lifted() {
      return lifted;
    },
    lift() {
      const ctx = options.ctx();
      const scene = options.sceneOf();
      if (ctx === null || scene === null) return false;
      slots = keyboardSlots(ctx, scene, options.subject);
      if (slots.length === 0) return false;
      const origin = currentPosition(ctx.model, options.subject.id);
      const start =
        origin === null
          ? -1
          : slots.findIndex((slot) => samePosition(slot.position, origin));
      current = Math.max(0, start);
      lifted = true;
      options.announce(
        formatString('announce.drag.pickedUp', { label: options.label }),
      );
      show(false);
      return true;
    },
    step(direction) {
      const ctx = options.ctx();
      if (!lifted || ctx === null) return;
      const next = stepIndex(ctx, slots, current, direction);
      if (next === current) return;
      current = next;
      const slot = slots[current];
      if (slot !== undefined) {
        options.announce(formatString('announce.drag.position', placeOf(slot)));
      }
      show(true);
    },
    drop() {
      const slot = slots[current];
      if (!lifted || slot === undefined) return;
      options.announce(
        formatString('announce.drag.dropped', {
          label: options.label,
          ...placeOf(slot),
        }),
      );
      const position = slot.position;
      finish();
      options.onDrop(position);
    },
    cancel() {
      if (!lifted) return;
      options.announce(STRINGS['announce.drag.cancelled']);
      finish();
    },
    redraw() {
      if (!lifted) return;
      refresh();
      show(false);
    },
  };
}
