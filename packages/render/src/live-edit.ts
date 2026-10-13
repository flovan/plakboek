/**
 * The live edit proxy (D-18, D-29): what a block receives as `edit` when the
 * editor renders a working tree. It sits behind the same `EditProxy` type as
 * `NOOP_EDIT`, so a block is authored once: spreading `{...edit}` on its root
 * element adds the identity attributes the overlay binds to, and
 * `{...edit.field('title')}` marks an editable property on a child.
 *
 * `EDIT_ATTRIBUTE` is pure constants, safe for any bundle (the editor reads
 * the same names the renderer writes); `createLiveEdit` is server-side.
 */
import type { EditAttributes, EditProxy } from './edit-proxy.js';

/** The attribute names that are the edit-mode contract between the renderer
 * and the overlay. `unavailable` marks the placeholder for a block that
 * renders nothing; its value is the reason (`unknown`, `degraded` or
 * `failed`). */
export const EDIT_ATTRIBUTE = Object.freeze({
  block: 'data-pk-block',
  type: 'data-pk-type',
  kind: 'data-pk-kind',
  label: 'data-pk-label',
  field: 'data-pk-field',
  unavailable: 'data-pk-unavailable',
  /** Set on a column that holds no blocks, in a live edit render only. */
  empty: 'data-pk-empty',
  /** Set by the editor on a block element whose text is being edited in
   * place; a fragment patcher must not replace such an element. */
  inlineEditing: 'data-pk-inline-editing',
} as const);

export type LiveEditInput = {
  /** The block's id. */
  readonly id: string;
  /** The block's type key. */
  readonly blockType: string;
  /** Whether the overlay treats it as a section, a column or a plain block. */
  readonly kind: 'section' | 'column' | 'block';
  /** What the overlay's chip shows. */
  readonly label: string;
};

/**
 * One block's live proxy. The own enumerable keys are exactly block, type,
 * kind and label; `field` is non-enumerable, so it never spreads onto an
 * element (05 D-15). Frozen, like `NOOP_EDIT`.
 */
export function createLiveEdit(input: LiveEditInput): EditProxy {
  const attributes: EditAttributes = {
    [EDIT_ATTRIBUTE.block]: input.id,
    [EDIT_ATTRIBUTE.type]: input.blockType,
    [EDIT_ATTRIBUTE.kind]: input.kind,
    [EDIT_ATTRIBUTE.label]: input.label,
  };
  return Object.freeze(
    Object.defineProperty(attributes, 'field', {
      value: (property: string): EditAttributes =>
        Object.freeze({ [EDIT_ATTRIBUTE.field]: property }),
      enumerable: false,
      writable: false,
      configurable: false,
    }) as EditProxy,
  );
}

/** Whether a proxy is a live one, as opposed to the visitor's `NOOP_EDIT`. */
export function isLiveEdit(edit: EditProxy): boolean {
  return Object.hasOwn(edit, EDIT_ATTRIBUTE.block);
}
