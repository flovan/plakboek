/**
 * The `multi_select` field type (D-35): the same value/label choices as
 * `select`, stored as an ordered array of distinct choice values with an
 * optional inclusive `minItems`/`maxItems`.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import { choiceSchema } from './select.js';
import type { FieldTypeDefinition } from './registry.js';

const multiSelectOptionsSchema = z
  .strictObject({
    choices: z.array(choiceSchema).min(1),
    minItems: z.int().min(0).optional(),
    maxItems: z.int().min(1).optional(),
  })
  .refine(
    (options) =>
      new Set(options.choices.map((choice) => choice.value)).size ===
      options.choices.length,
    { message: 'choice values must be distinct', path: ['choices'] },
  )
  .refine(
    (options) =>
      options.minItems === undefined ||
      options.maxItems === undefined ||
      options.minItems <= options.maxItems,
    { message: 'minItems must be less than or equal to maxItems' },
  )
  .refine(
    // A minItems above the number of choices can never be satisfied, because
    // values must be distinct and drawn from the choices, so the field would
    // reject every possible input (D-WR-03).
    (options) =>
      options.minItems === undefined ||
      options.minItems <= options.choices.length,
    {
      message: 'minItems must not exceed the number of choices',
      path: ['minItems'],
    },
  );

type MultiSelectOptions = z.infer<typeof multiSelectOptionsSchema>;

function buildMultiSelectValueSchema(options: MultiSelectOptions): z.ZodType {
  const values = new Set(options.choices.map((choice) => choice.value));
  let schema = z.array(
    z.string().refine((value) => values.has(value), {
      message: 'must be one of the configured choices',
    }),
  );
  if (options.minItems !== undefined) {
    schema = schema.min(options.minItems);
  }
  if (options.maxItems !== undefined) {
    schema = schema.max(options.maxItems);
  }
  return schema.refine((items) => new Set(items).size === items.length, {
    message: 'values must be distinct',
  });
}

function isEmptyMultiSelectValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

export const multiSelectFieldType = {
  fieldType: 'multi_select',
  optionsSchema: multiSelectOptionsSchema,
  buildValueSchema: buildMultiSelectValueSchema,
  isEmptyValue: isEmptyMultiSelectValue,
  widgets: ['checkbox-group', 'multi-dropdown'] as const,
  defaultWidget: 'checkbox-group',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<MultiSelectOptions>;
