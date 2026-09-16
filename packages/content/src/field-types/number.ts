/**
 * The `number` field type: any finite double, an optional inclusive
 * `min`/`max`. `z.number()` already rejects `NaN` and `Infinity` (pinned in
 * `tests/unit/zod-contract.test.ts`), so no extra finiteness check is
 * needed here.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

const numberOptionsSchema = z
  .strictObject({
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine(
    (options) =>
      options.min === undefined ||
      options.max === undefined ||
      options.min <= options.max,
    { message: 'min must be less than or equal to max' },
  );

type NumberOptions = z.infer<typeof numberOptionsSchema>;

function buildNumberValueSchema(options: NumberOptions): z.ZodType {
  let schema = z.number();
  if (options.min !== undefined) {
    schema = schema.min(options.min);
  }
  if (options.max !== undefined) {
    schema = schema.max(options.max);
  }
  return schema;
}

function isEmptyNumberValue(value: unknown): boolean {
  return value === undefined || value === null;
}

export const numberFieldType: FieldTypeDefinition<NumberOptions> = {
  fieldType: 'number',
  optionsSchema: numberOptionsSchema,
  buildValueSchema: buildNumberValueSchema,
  isEmptyValue: isEmptyNumberValue,
  widgets: ['number-input', 'slider'],
  defaultWidget: 'number-input',
  allowedInRepeater: true,
};
