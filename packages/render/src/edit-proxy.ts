/**
 * The edit proxy a block spreads onto its markup (D-15). A block is authored
 * once: it spreads `{...edit}` on its root element and
 * `{...edit.field('title')}` on an editable child. On a visitor page the
 * proxy is `NOOP_EDIT` and every spread adds nothing; in edit mode (Phase 7)
 * a live proxy supplies the `data-` attributes the editor binds to, behind
 * the identical type.
 */

/** Attributes the editor binds to; always `data-` prefixed. */
export type EditAttributes = Readonly<Record<`data-${string}`, string>>;

/** The proxy a block receives: root attributes, plus per-property ones. */
export type EditProxy = EditAttributes & {
  field(property: string): EditAttributes;
};

const NO_ATTRIBUTES: EditAttributes = Object.freeze({});

/**
 * The visitor-side proxy: no own enumerable keys, so spreading it yields
 * zero attributes, and `field` (non-enumerable, so it never spreads either)
 * returns one shared empty object. It is stateless, so a single instance
 * serves every block and every request at no cost.
 */
export const NOOP_EDIT: EditProxy = Object.freeze(
  Object.defineProperty({}, 'field', {
    value: (): EditAttributes => NO_ATTRIBUTES,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as EditProxy,
);
