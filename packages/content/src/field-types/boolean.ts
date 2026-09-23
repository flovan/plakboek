/**
 * The `boolean` field type: a plain true/false, no options. `false` is a
 * real, non-empty value -- a required boolean field holding `false` is not
 * treated as missing.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

const booleanOptionsSchema = z.strictObject({});

type BooleanOptions = z.infer<typeof booleanOptionsSchema>;

function buildBooleanValueSchema(_options: BooleanOptions): z.ZodType {
  return z.boolean();
}

function isEmptyBooleanValue(value: unknown): boolean {
  return value === undefined || value === null;
}

export const booleanFieldType = {
  fieldType: 'boolean',
  optionsSchema: booleanOptionsSchema,
  buildValueSchema: buildBooleanValueSchema,
  isEmptyValue: isEmptyBooleanValue,
  widgets: ['checkbox', 'switch'] as const,
  defaultWidget: 'checkbox',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<BooleanOptions>;
