/**
 * Compile-time projection of the sixteen field types' own option (and
 * widget) types into two keyed maps (D-02): `defineContentTypes` (`seed.ts`)
 * is typed against these, so a field seed declaring `fieldType: 'number'`
 * with `options: { maxLength: 5 }` -- `short_text`'s option, not
 * `number`'s -- is a compile error, not a runtime-only check.
 *
 * Each entry is derived from its own field-type module's exported
 * `FieldTypeDefinition<O>` constant (never restated by hand): `OptionsOf<D>`
 * extracts the definition's own `O` via the same `infer` trick a discriminated
 * generic type normally uses, so a change to a field type's options shape
 * (e.g. `short-text.ts`'s `ShortTextOptions`) is picked up here automatically,
 * with no matching edit required in this file.
 *
 * `widgets` is declared as a fixed, non-generic
 * `readonly [string, ...string[]]` on `FieldTypeDefinition<O>` itself (see
 * `registry.ts`) -- it does not vary with `O`. Because every field-type
 * module gives its exported constant an explicit `FieldTypeDefinition<...>`
 * type annotation (never lets it infer), TypeScript uses that annotation as
 * the constant's declared type and discards the object literal's more
 * specific tuple-of-string-literals type in the process -- this is
 * unconditional, ordinary "explicit annotation wins" behaviour, confirmed
 * live against this package's own field-type modules (see 03-13-SUMMARY.md).
 * `FieldTypeWidgetMap` is still built the same mechanical, per-definition
 * way as `FieldTypeOptionsMap` (so it stays automatically in sync with the
 * registry), but every entry resolves to plain `string` rather than a
 * literal widget union -- `defineContentTypes`'s widget check is therefore
 * enforced at runtime (`seed.ts`'s `INVALID_WIDGET` issue), the same way
 * `addField`/`updateField` already enforce it, not at compile time.
 */
import { booleanFieldType } from './boolean.js';
import { dateTimeFieldType } from './date-time.js';
import { fileFieldType } from './file.js';
import { imageFieldType } from './image.js';
import { integerFieldType } from './integer.js';
import { jsonFieldType } from './json.js';
import { longTextFieldType } from './long-text.js';
import { multiSelectFieldType } from './multi-select.js';
import { numberFieldType } from './number.js';
import { referenceFieldType } from './reference.js';
import { repeaterFieldType } from './repeater.js';
import type { FieldTypeDefinition } from './registry.js';
import { richTextFieldType } from './rich-text.js';
import { selectFieldType } from './select.js';
import { shortTextFieldType } from './short-text.js';
import { slugFieldFieldType } from './slug-field.js';
import { urlFieldType } from './url.js';

/** Extracts a `FieldTypeDefinition<O>`'s own `O` from the definition's
 * declared type. */
type OptionsOf<D> = D extends FieldTypeDefinition<infer O> ? O : never;

/** Extracts a `FieldTypeDefinition`'s `widgets` element type. See this
 * module's header comment for why this resolves to plain `string` today. */
type WidgetOf<D> =
  D extends FieldTypeDefinition<unknown> ? D['widgets'][number] : never;

/** One entry per field type (FIELD-02), each projected from that type's own
 * exported `FieldTypeDefinition` constant -- never restated by hand. */
export type FieldTypeOptionsMap = {
  short_text: OptionsOf<typeof shortTextFieldType>;
  long_text: OptionsOf<typeof longTextFieldType>;
  rich_text: OptionsOf<typeof richTextFieldType>;
  number: OptionsOf<typeof numberFieldType>;
  integer: OptionsOf<typeof integerFieldType>;
  boolean: OptionsOf<typeof booleanFieldType>;
  date_time: OptionsOf<typeof dateTimeFieldType>;
  select: OptionsOf<typeof selectFieldType>;
  multi_select: OptionsOf<typeof multiSelectFieldType>;
  image: OptionsOf<typeof imageFieldType>;
  file: OptionsOf<typeof fileFieldType>;
  reference: OptionsOf<typeof referenceFieldType>;
  json: OptionsOf<typeof jsonFieldType>;
  slug: OptionsOf<typeof slugFieldFieldType>;
  url: OptionsOf<typeof urlFieldType>;
  repeater: OptionsOf<typeof repeaterFieldType>;
};

/** One entry per field type, projected the same mechanical way as
 * `FieldTypeOptionsMap`. See this module's header comment for why every
 * entry is `string` rather than a literal widget union. */
export type FieldTypeWidgetMap = {
  short_text: WidgetOf<typeof shortTextFieldType>;
  long_text: WidgetOf<typeof longTextFieldType>;
  rich_text: WidgetOf<typeof richTextFieldType>;
  number: WidgetOf<typeof numberFieldType>;
  integer: WidgetOf<typeof integerFieldType>;
  boolean: WidgetOf<typeof booleanFieldType>;
  date_time: WidgetOf<typeof dateTimeFieldType>;
  select: WidgetOf<typeof selectFieldType>;
  multi_select: WidgetOf<typeof multiSelectFieldType>;
  image: WidgetOf<typeof imageFieldType>;
  file: WidgetOf<typeof fileFieldType>;
  reference: WidgetOf<typeof referenceFieldType>;
  json: WidgetOf<typeof jsonFieldType>;
  slug: WidgetOf<typeof slugFieldFieldType>;
  url: WidgetOf<typeof urlFieldType>;
  repeater: WidgetOf<typeof repeaterFieldType>;
};
