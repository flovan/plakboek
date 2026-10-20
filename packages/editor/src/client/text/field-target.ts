/**
 * Which element a click landed on is an editable text field, and of which block
 * property. Frame nodes belong to the frame's realm, so everything here is read
 * by shape (`closest`, `getAttribute`, `tagName`), never with `instanceof`.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import type { CatalogueEntry, CatalogueProperty } from '../../api-types.js';
import type { TreeModel } from '../session/tree-model.js';

export type FieldTarget = {
  readonly blockId: string;
  /** The property key the field is marked with. */
  readonly key: string;
  /** A `rich_text` property is typed as formatted text, a `short_text` one as one plain line. */
  readonly kind: 'rich' | 'plain';
  readonly element: Element;
  readonly property: CatalogueProperty;
  /** The `maxLength` of a plain field's property, when it has one. */
  readonly maxLength?: number;
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
 * `rich_text` or `short_text` one with no placement constraint, and the
 * element is not a control.
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

/** The `maxLength` option of a short text property, when it is a usable one. */
function maxLengthOf(options: unknown): number | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const value: unknown = Reflect.get(options, 'maxLength');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}
