/**
 * The field-type validation registry (FIELD-02, FIELD-04, FIELD-06): one
 * record per field type, each with its own options schema and a
 * value-schema builder. Mirrors `@plakboek/permissions`'s catalogue.ts
 * shape (a frozen, keyed source of truth) for the flat `FIELD_TYPES` tuple;
 * the per-type record itself is a new problem shape for this codebase (a
 * zod-backed discriminated registry), not copied from any prior file.
 *
 * `field_type`'s storage type never changes after creation (D-08) and is
 * kept apart from its presentational `widget` (FIELD-04): a widget is only
 * ever one of the type's own declared `widgets`.
 */
import type { z } from 'zod';
import { booleanFieldType } from './boolean.js';
import { dateTimeFieldType } from './date-time.js';
import { FIELD_TYPES, isFieldType, type FieldType } from './field-type-ids.js';
import { fileFieldType } from './file.js';
import { imageFieldType } from './image.js';
import { integerFieldType } from './integer.js';
import { jsonFieldType } from './json.js';
import { longTextFieldType } from './long-text.js';
import { multiSelectFieldType } from './multi-select.js';
import { numberFieldType } from './number.js';
import { referenceFieldType } from './reference.js';
import { repeaterFieldType } from './repeater.js';
import { richTextFieldType } from './rich-text.js';
import { selectFieldType } from './select.js';
import { shortTextFieldType } from './short-text.js';
import { slugFieldFieldType } from './slug-field.js';
import { urlFieldType } from './url.js';

/** The 16 field types (FIELD-02), in the same order as
 * `content_type_fields_field_type_check` in `0002_content_engine`.
 * Declared in `field-type-ids.ts`, re-exported here so every existing
 * import of this module keeps working unchanged. See that module's header
 * comment for why `schema.ts` reads `FIELD_TYPES` from there directly
 * instead of from here. */
export { FIELD_TYPES, isFieldType };
export type { FieldType };

/** One field type's contract: how its per-field `options` are validated,
 * how a submitted value is validated against those options, what an "empty"
 * value looks like (for the D-12 required check), and which widgets it
 * supports. */
export type FieldTypeDefinition<O = unknown> = {
  readonly fieldType: FieldType;
  readonly optionsSchema: z.ZodType<O>;
  buildValueSchema(options: O): z.ZodType;
  isEmptyValue(value: unknown): boolean;
  readonly widgets: readonly [string, ...string[]];
  readonly defaultWidget: string;
  readonly allowedInRepeater: boolean;
};

/** Every field type in `FIELD_TYPES` must have a definition, filed under its
 * own key. Checked with `satisfies`, never an annotation, so a definition
 * keeps its own literal `widgets` and options type instead of being widened
 * to this constraint's shape. */
export type FieldTypeDefinitions = {
  readonly [K in FieldType]: FieldTypeDefinition<unknown> & {
    readonly fieldType: K;
  };
};

// Keyed by plain `string` (not `FieldType`) so lookups never need to widen a
// caller-supplied string into the branded union before the membership check
// below has actually confirmed it belongs to it.
const registry = new Map<string, FieldTypeDefinition<unknown>>();

/**
 * Registers a field type's definition. Called once per type, from the loop
 * below, over `FIELD_TYPE_DEFINITIONS` -- never exported from the package
 * barrel, so a caller outside this package can never register or overwrite
 * a type at runtime.
 */
export function registerFieldType(
  definition: FieldTypeDefinition<unknown>,
): void {
  registry.set(definition.fieldType, definition);
}

/** One definition per field type, keyed by its own `fieldType` and checked
 * by `FieldTypeDefinitions` above. This is the single record every other
 * derived copy (`options-map.ts`'s two maps, this module's own registration
 * loop) reads through, so adding a field type here is the only hand edit a
 * 17th type needs on this side of the drift assertion in
 * `schema-parity.test.ts`.
 *
 * Each field-type module exports a plain `FieldTypeDefinition` object and
 * imports only the type of `FieldTypeDefinition` back from this module,
 * erased at compile time and never a value, so reading them here carries no
 * circular-import risk. `repeater.ts` is the one exception: it needs
 * `getFieldTypeDefinition`/`isFieldType` as real values to resolve its
 * sub-fields, but only calls them from inside its own functions, never at
 * its own module top level. See `repeater.ts`'s header comment. */
export const FIELD_TYPE_DEFINITIONS = {
  short_text: shortTextFieldType,
  long_text: longTextFieldType,
  rich_text: richTextFieldType,
  number: numberFieldType,
  integer: integerFieldType,
  boolean: booleanFieldType,
  date_time: dateTimeFieldType,
  select: selectFieldType,
  multi_select: multiSelectFieldType,
  image: imageFieldType,
  file: fileFieldType,
  reference: referenceFieldType,
  json: jsonFieldType,
  slug: slugFieldFieldType,
  url: urlFieldType,
  repeater: repeaterFieldType,
} satisfies FieldTypeDefinitions;

for (const definition of Object.values(FIELD_TYPE_DEFINITIONS)) {
  registerFieldType(definition);
}

/** Thrown when a `field_type` string has no registered definition -- a
 * value the database CHECK constraint allows but this build's field-type
 * registry does not (yet) implement. */
export class UnknownFieldTypeError extends Error {
  readonly fieldType: string;

  constructor(fieldType: string) {
    super(`@plakboek/content: field type "${fieldType}" is not registered`);
    this.name = 'UnknownFieldTypeError';
    this.fieldType = fieldType;
  }
}

/** Thrown for a collect-then-throw-once set of definition-shaped problems:
 * a field's `options` failing their type's `optionsSchema` (`context` names
 * the field type), or a generated field key coming out empty (`context`
 * names `"field key"`). */
export class FieldDefinitionError extends Error {
  readonly issues: readonly string[];

  constructor(context: string, issues: readonly string[]) {
    super([`@plakboek/content: invalid ${context}:`, ...issues].join('\n'));
    this.name = 'FieldDefinitionError';
    this.issues = issues;
  }
}

export function getFieldTypeDefinition(
  fieldType: string,
): FieldTypeDefinition<unknown> {
  const definition = registry.get(fieldType);
  if (definition === undefined) {
    throw new UnknownFieldTypeError(fieldType);
  }
  return definition;
}

/** Validates `options` against `fieldType`'s `optionsSchema` and returns the
 * parsed, typed result. Throws `FieldDefinitionError` naming every zod
 * issue's message on failure. */
export function parseFieldOptions(
  fieldType: FieldType,
  options: unknown,
): unknown {
  const definition = getFieldTypeDefinition(fieldType);
  const result = definition.optionsSchema.safeParse(options);
  if (!result.success) {
    throw new FieldDefinitionError(
      `options for field type "${fieldType}"`,
      result.error.issues.map((issue) => issue.message),
    );
  }
  return result.data;
}
