/**
 * The `integer` field type: a safe-integer value (`z.int()` rejects
 * non-integers and anything outside `Number.MAX_SAFE_INTEGER`, pinned in
 * `tests/unit/zod-contract.test.ts`), an optional inclusive `min`/`max`.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

const integerOptionsSchema = z
  .strictObject({
    min: z.int().optional(),
    max: z.int().optional(),
  })
  .refine(
    (options) =>
      options.min === undefined ||
      options.max === undefined ||
      options.min <= options.max,
    { message: 'min must be less than or equal to max' },
  );

type IntegerOptions = z.infer<typeof integerOptionsSchema>;

function buildIntegerValueSchema(options: IntegerOptions): z.ZodType {
  let schema = z.int();
  if (options.min !== undefined) {
    schema = schema.min(options.min);
  }
  if (options.max !== undefined) {
    schema = schema.max(options.max);
  }
  return schema;
}

function isEmptyIntegerValue(value: unknown): boolean {
  return value === undefined || value === null;
}

export const integerFieldType: FieldTypeDefinition<IntegerOptions> = {
  fieldType: 'integer',
  optionsSchema: integerOptionsSchema,
  buildValueSchema: buildIntegerValueSchema,
  isEmptyValue: isEmptyIntegerValue,
  widgets: ['number-input', 'slider'],
  defaultWidget: 'number-input',
  allowedInRepeater: true,
};
