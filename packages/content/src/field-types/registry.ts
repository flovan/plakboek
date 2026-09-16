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
import { shortTextFieldType } from './short-text.js';

/** The 16 field types (FIELD-02), in the same order as
 * `content_type_fields_field_type_check` in `0002_content_engine`. */
export const FIELD_TYPES = Object.freeze([
  'short_text',
  'long_text',
  'rich_text',
  'number',
  'integer',
  'boolean',
  'date_time',
  'select',
  'multi_select',
  'image',
  'file',
  'reference',
  'json',
  'slug',
  'url',
  'repeater',
] as const);

export type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPE_SET.has(value);
}

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

// Keyed by plain `string` (not `FieldType`) so lookups never need to widen a
// caller-supplied string into the branded union before the membership check
// below has actually confirmed it belongs to it.
const registry = new Map<string, FieldTypeDefinition<unknown>>();

/**
 * Registers a field type's definition. Called once per type, from each
 * type's own module (`short-text.ts`, and Plan 03-03's remaining fifteen) --
 * never exported from the package barrel, so a caller outside this package
 * can never register or overwrite a type at runtime.
 */
export function registerFieldType<O>(definition: FieldTypeDefinition<O>): void {
  registry.set(
    definition.fieldType,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every
    // definition is retrieved back through this same erased type by its
    // `fieldType` key; the generic option type is only ever known again at
    // the single call site that registered it (short-text.ts, etc).
    definition as FieldTypeDefinition<unknown>,
  );
}

// short-text.ts exports a plain FieldTypeDefinition object and imports only
// the *type* of FieldTypeDefinition back from this module (`import type`,
// erased at compile time) -- never a value -- so registering it here, after
// `registry` above, carries no circular-import/TDZ risk. Plan 03-03 adds the
// remaining fifteen field types the same way: one import plus one
// `registerFieldType` call, appended here.
registerFieldType(shortTextFieldType);

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
