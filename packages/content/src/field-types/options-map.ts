/**
 * Compile-time projection of the sixteen field types' own option (and
 * widget) types into two keyed maps (D-02): `defineContentTypes` (`seed.ts`)
 * is typed against these, so a field seed declaring `fieldType: 'number'`
 * with `options: { maxLength: 5 }` -- `short_text`'s option, not
 * `number`'s -- is a compile error, not a runtime-only check.
 *
 * Both maps derive from `registry.ts`'s single `FIELD_TYPE_DEFINITIONS`
 * record, with zero field-type keys restated in this file: `OptionsOf<D>`
 * and `WidgetOf<D>` extract each definition's own types through `infer`, so
 * a change to a field type's options shape (e.g. `short-text.ts`'s
 * `ShortTextOptions`) is picked up here automatically, with no matching
 * edit required in this file.
 *
 * `FieldTypeWidgetMap[K]` now resolves to the literal widget union field
 * type `K` declares, not plain `string`: `registry.ts`'s definitions are
 * checked with `satisfies`, which keeps each definition's own literal
 * `widgets` tuple instead of widening it to `FieldTypeDefinition`'s
 * declared `readonly [string, ...string[]]`. The widget check
 * `defineContentTypes` used to only perform at runtime therefore moved to
 * compile time. `addField` and `updateField` still check widgets at
 * runtime, because their own input types keep `widget` as a plain string.
 */
import type {
  FIELD_TYPE_DEFINITIONS,
  FieldType,
  FieldTypeDefinition,
} from './registry.js';

type Defs = typeof FIELD_TYPE_DEFINITIONS;

/** Extracts a `FieldTypeDefinition<O>`'s own `O` from the definition's
 * declared type. */
type OptionsOf<D> = D extends FieldTypeDefinition<infer O> ? O : never;

/** Extracts a `FieldTypeDefinition`'s `widgets` element type. Resolves to
 * the literal widget union `D` itself declares. See this module's header
 * comment. */
type WidgetOf<D> =
  D extends FieldTypeDefinition<unknown> ? D['widgets'][number] : never;

/** One entry per field type (FIELD-02), each projected from
 * `FIELD_TYPE_DEFINITIONS` -- never restated by hand. */
export type FieldTypeOptionsMap = {
  [K in FieldType]: OptionsOf<Defs[K]>;
};

/** One entry per field type, projected the same mechanical way as
 * `FieldTypeOptionsMap`. See this module's header comment for why every
 * entry is now a literal widget union rather than plain `string`. */
export type FieldTypeWidgetMap = {
  [K in FieldType]: WidgetOf<Defs[K]>;
};
