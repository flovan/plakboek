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
