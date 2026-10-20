/**
 * Follows the rich text fields of one block in the framed document: where each
 * one is (in the frame's own coordinates, a ghost box where it takes up no
 * room), whether it is empty and how big its block is. The placeholder chip,
 * the field boundary and the unsupported-formatting notice are drawn from it.
 *
 * It measures once per animation frame while there is something to follow and
 * stops when there is not, so a page with no selected text block costs
 * nothing. It only reads the framed site; nothing is added to it.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { documentBox } from '../chrome-host/coordinates.js';
import { sameBox, type Box } from './geometry.js';
import { GHOST_SIZE } from './boxes.js';

/** What to follow: the selected block and which of its fields are text, rich or plain. */
export type FieldsWanted = {
  readonly blockId: string;
  /** Every text field's key. */
  readonly keys: readonly string[];
  /** The keys among them that are short text (plain). */
  readonly plain?: readonly string[];
};

export type FieldBox = {
  readonly key: string;
  /** Rich text, or one plain line of short text. */
  readonly kind: 'rich' | 'plain';
  /** The field's box; a ghost box when the field takes up no room. */
  readonly box: Box;
  /** The box of the block that holds the field. */
  readonly block: Box;
  /** The field shows no text and nothing else (no divider, button or image). */
  readonly empty: boolean;
};

export type FieldTracker = {
  /** Starts measuring again, after what is wanted changed. */
  readonly refresh: () => void;
  readonly dispose: () => void;
};

export type FieldTrackerOptions = {
  readonly read: () => FieldsWanted | null;
  readonly onChange: (fields: readonly FieldBox[]) => void;
};

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;
const FIELD_SELECTOR = `[${EDIT_ATTRIBUTE.field}]`;

/** True when the field holds no text and no element that stands for content. */
export function isEmptyFieldElement(field: Element): boolean {
  if ((field.textContent ?? '').trim() !== '') return false;
  return field.querySelector('hr, a, img, [data-cta-row]') === null;
}

function sameFields(a: readonly FieldBox[], b: readonly FieldBox[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, at) => {
      const other = b[at];
      return (
        other !== undefined &&
        item.key === other.key &&
        item.kind === other.kind &&
        item.empty === other.empty &&
        sameBox(item.box, other.box) &&
        sameBox(item.block, other.block)
      );
    })
  );
}

function measure(element: Element, view: Window): Box | null {
  if (view.getComputedStyle(element).display === 'contents') return null;
  const rect = element.getBoundingClientRect();
  return documentBox(
    {
      left: rect.left,
      top: rect.top,
      width: rect.width > 0 ? rect.width : GHOST_SIZE,
      height: rect.height > 0 ? rect.height : GHOST_SIZE,
    },
    view,
  );
}

export function createFieldTracker(
  frame: HTMLIFrameElement,
  options: FieldTrackerOptions,
): FieldTracker {
  const topWindow = frame.ownerDocument.defaultView;
  let animationFrame = 0;
  let disposed = false;
  let last: readonly FieldBox[] = [];

  function emit(next: readonly FieldBox[]): void {
    if (sameFields(last, next)) return;
    last = next;
    options.onChange(next);
  }

  function step(): void {
    animationFrame = 0;
    if (disposed) return;
    const wanted = options.read();
    const doc = frame.contentDocument;
    const view = doc?.defaultView ?? null;
    if (wanted === null || wanted.keys.length === 0) {
      emit([]);
      return;
    }
    if (doc !== null && view !== null && doc.URL !== 'about:blank') {
      const block = Array.from(doc.querySelectorAll(BLOCK_SELECTOR)).find(
        (element) =>
          element.getAttribute(EDIT_ATTRIBUTE.block) === wanted.blockId,
      );
      const blockBox = block === undefined ? null : measure(block, view);
      const found: FieldBox[] = [];
      if (block !== undefined && blockBox !== null) {
        // The block's own element can be the field (a heading's root is its text).
        const candidates = [
          ...(block.matches(FIELD_SELECTOR) ? [block] : []),
          ...block.querySelectorAll(FIELD_SELECTOR),
        ];
        for (const field of candidates) {
          const key = field.getAttribute(EDIT_ATTRIBUTE.field);
          // A field of a nested block is that block's, not this one's.
          if (
            key === null ||
            !wanted.keys.includes(key) ||
            field.closest(BLOCK_SELECTOR) !== block ||
            found.some((item) => item.key === key)
          ) {
            continue;
          }
          const box = measure(field, view);
          if (box === null) continue;
          found.push({
            key,
            kind: wanted.plain?.includes(key) === true ? 'plain' : 'rich',
            box,
            block: blockBox,
            empty: isEmptyFieldElement(field),
          });
        }
      }
      emit(found);
    } else {
      emit([]);
    }
    schedule();
  }

  function schedule(): void {
    if (disposed || animationFrame !== 0 || topWindow === null) return;
    animationFrame = topWindow.requestAnimationFrame(step);
  }

  schedule();

  return {
    refresh: schedule,
    dispose() {
      disposed = true;
      if (animationFrame !== 0) topWindow?.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    },
  };
}
