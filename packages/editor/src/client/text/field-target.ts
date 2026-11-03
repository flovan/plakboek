/**
 * Which element a click landed on is an editable text field, and of which block
 * property. Frame nodes belong to the frame's realm, so everything here is read
 * by shape (`closest`, `getAttribute`, `tagName`), never with `instanceof`.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import type { CatalogueEntry, CatalogueProperty } from '../../api-types.js';
import { GHOST_SIZE } from '../overlay/boxes.js';
import type { TreeModel } from '../session/tree-model.js';

export type FieldTarget = {
  readonly blockId: string;
  /** The property key the field is marked with. */
  readonly key: string;
  /**
   * A `rich_text` property is typed as formatted text, a `short_text` one as
   * one plain line, and a `link` one is edited in the Button popover: the
   * field is the block's button, so nothing is typed into it.
   */
  readonly kind: 'rich' | 'plain' | 'button';
  readonly element: Element;
  readonly property: CatalogueProperty;
  /** The `maxLength` of a plain field's property, when it has one. */
  readonly maxLength?: number;
  /** A button field's sibling short text property that holds its label, when the link options name one. */
  readonly labelKey?: string;
  /** A button field's sibling select property that holds its style, when the link options name one. */
  readonly variantKey?: string;
};

const FIELD_SELECTOR = `[${EDIT_ATTRIBUTE.field}]`;
const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;

/** Elements whose own behaviour a caret and typing would fight. */
const CONTROL_TAGS = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'OPTION',
]);

type ElementLike = {
  readonly nodeType: number;
  readonly tagName: string;
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
};

function isElementLike(value: unknown): value is ElementLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'nodeType') === 1 &&
    typeof Reflect.get(value, 'closest') === 'function' &&
    typeof Reflect.get(value, 'getAttribute') === 'function'
  );
}

/** The element a node stands for: itself, or the parent of a text node. */
function elementOf(start: unknown): ElementLike | null {
  if (isElementLike(start)) return start;
  if (typeof start !== 'object' || start === null) return null;
  const parent: unknown = Reflect.get(start, 'parentElement');
  return isElementLike(parent) ? parent : null;
}

/**
 * The editable field under `start` (the element a click landed on), or null.
 * It is a field only when its owning block is in the model, the property is a
 * `rich_text`, `short_text` or `link` one with no placement constraint, and
 * the element is not a control.
 */
export function findEditableField(
  start: unknown,
  model: TreeModel,
  catalogue: readonly CatalogueEntry[],
): FieldTarget | null {
  const element = elementOf(start);
  if (element === null) return null;
  const field = element.closest(FIELD_SELECTOR);
  if (field === null) return null;
  if (CONTROL_TAGS.has(field.tagName.toUpperCase())) return null;
  const key = field.getAttribute(EDIT_ATTRIBUTE.field);
  if (key === null || key === '') return null;
  const owner = field.closest(BLOCK_SELECTOR);
  const blockId = owner?.getAttribute(EDIT_ATTRIBUTE.block) ?? null;
  if (blockId === null || blockId === '') return null;
  const node = model.get(blockId);
  if (node === undefined) return null;
  const property = catalogue
    .find((entry) => entry.key === node.type)
    ?.properties.find((item) => item.key === key);
  if (property === undefined || property.constraint !== 'none') return null;
  if (property.fieldType === 'rich_text') {
    return {
      blockId,
      key,
      kind: 'rich',
      element: field as unknown as Element,
      property,
    };
  }
  if (property.fieldType === 'link') {
    const siblings = siblingsOf(catalogue, node.type);
    const labelKey = siblingKey(
      property.options,
      'labelProperty',
      siblings,
      'short_text',
    );
    const variantKey = siblingKey(
      property.options,
      'variantProperty',
      siblings,
      'select',
    );
    return {
      blockId,
      key,
      kind: 'button',
      element: field as unknown as Element,
      property,
      ...(labelKey === undefined ? {} : { labelKey }),
      ...(variantKey === undefined ? {} : { variantKey }),
    };
  }
  if (property.fieldType !== 'short_text') return null;
  const maxLength = maxLengthOf(property.options);
  return {
    blockId,
    key,
    kind: 'plain',
    element: field as unknown as Element,
    property,
    ...(maxLength === undefined ? {} : { maxLength }),
  };
}

/**
 * The field a block marks for one of its properties, resolved the way a click
 * on it would be, or null when the block never marks that property or the
 * property is not editable on the page. Only the block's own fields count (the
 * block's root included), never a nested block's.
 */
export function findFieldForProperty(
  frameDocument: {
    querySelectorAll(selector: string): ArrayLike<unknown>;
  },
  blockId: string,
  key: string,
  model: TreeModel,
  catalogue: readonly CatalogueEntry[],
): FieldTarget | null {
  for (const candidate of Array.from(
    frameDocument.querySelectorAll(FIELD_SELECTOR),
  )) {
    if (!isElementLike(candidate)) continue;
    if (candidate.getAttribute(EDIT_ATTRIBUTE.field) !== key) continue;
    const owner = candidate.closest(BLOCK_SELECTOR);
    if (owner?.getAttribute(EDIT_ATTRIBUTE.block) !== blockId) continue;
    return findEditableField(candidate, model, catalogue);
  }
  return null;
}

/** Whether the point is inside the box an element is drawn from where it takes up no room: its rect, each zero dimension widened. */
function holdsPoint(rect: DOMRect, x: number, y: number): boolean {
  const width = rect.width > 0 ? rect.width : GHOST_SIZE;
  const height = rect.height > 0 ? rect.height : GHOST_SIZE;
  return (
    x >= rect.left &&
    x < rect.left + width &&
    y >= rect.top &&
    y < rect.top + height
  );
}

/**
 * The block's own empty text field under a point, for a field that renders at
 * no size and so is never what `elementFromPoint` returns. It counts where the
 * point is inside the ghost box the field's outline is drawn from: its
 * top-left corner, each zero dimension widened to the ghost size. Only a
 * rich or plain text field qualifies (a button field is edited in its
 * popover), only the block's own fields count (the root included, never a
 * nested block's), and a field with no box at all (`display: contents` or no
 * client rects) is never hit. A sized element painted over the spot keeps the
 * click, as it does for a ghost block: the field is only hit where the
 * element under the point is the field, one inside it or one that holds it.
 */
export function findZeroSizeFieldAt(
  frameDocument: Pick<
    Document,
    'querySelectorAll' | 'defaultView' | 'elementFromPoint'
  >,
  blockId: string,
  x: number,
  y: number,
  model: TreeModel,
  catalogue: readonly CatalogueEntry[],
): FieldTarget | null {
  const under = frameDocument.elementFromPoint(x, y);
  for (const candidate of Array.from(
    frameDocument.querySelectorAll(FIELD_SELECTOR),
  )) {
    if (!isElementLike(candidate)) continue;
    if (
      candidate.closest(BLOCK_SELECTOR)?.getAttribute(EDIT_ATTRIBUTE.block) !==
      blockId
    ) {
      continue;
    }
    const geometry = candidate as unknown as Element;
    const rect = geometry.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) continue;
    if (geometry.getClientRects().length === 0) continue;
    if (
      frameDocument.defaultView?.getComputedStyle(geometry).display ===
      'contents'
    ) {
      continue;
    }
    if (!holdsPoint(rect, x, y)) continue;
    if (
      under !== null &&
      !under.contains(geometry) &&
      !geometry.contains(under)
    ) {
      continue;
    }
    const target = findEditableField(candidate, model, catalogue);
    if (target !== null && target.kind !== 'button') return target;
  }
  return null;
}

/** The `maxLength` option of a short text property, when it is a usable one. */
function maxLengthOf(options: unknown): number | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const value: unknown = Reflect.get(options, 'maxLength');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

function siblingsOf(
  catalogue: readonly CatalogueEntry[],
  type: string,
): readonly CatalogueProperty[] {
  return catalogue.find((entry) => entry.key === type)?.properties ?? [];
}

/**
 * The key a link property's options name under `option`, only when it is a
 * property of the same block of the expected field type that the editor may
 * write (not fixed). Anything else is ignored, so a popover never writes a
 * property the block does not declare.
 */
function siblingKey(
  options: unknown,
  option: 'labelProperty' | 'variantProperty',
  siblings: readonly CatalogueProperty[],
  fieldType: 'short_text' | 'select',
): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const named: unknown = Reflect.get(options, option);
  if (typeof named !== 'string') return undefined;
  const sibling = siblings.find((item) => item.key === named);
  return sibling !== undefined &&
    sibling.fieldType === fieldType &&
    sibling.constraint !== 'fixed'
    ? named
    : undefined;
}
