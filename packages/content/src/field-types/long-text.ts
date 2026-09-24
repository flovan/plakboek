/**
 * The `long_text` field type: multi-line text (newlines allowed, unlike
 * `short_text`), with an optional min/max length.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

export const LONG_TEXT_MAX_LENGTH = 100000;

const longTextOptionsSchema = z
  .strictObject({
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).max(LONG_TEXT_MAX_LENGTH).optional(),
  })
  .refine(
    (options) =>
      options.minLength === undefined ||
      options.maxLength === undefined ||
      options.minLength <= options.maxLength,
    { message: 'minLength must be less than or equal to maxLength' },
  );

type LongTextOptions = z.infer<typeof longTextOptionsSchema>;

function buildLongTextValueSchema(options: LongTextOptions): z.ZodType {
  let schema = z.string().max(options.maxLength ?? LONG_TEXT_MAX_LENGTH);
  if (options.minLength !== undefined) {
    schema = schema.min(options.minLength);
  }
  return schema;
}

function isEmptyLongTextValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const longTextFieldType = {
  fieldType: 'long_text',
  optionsSchema: longTextOptionsSchema,
  buildValueSchema: buildLongTextValueSchema,
  isEmptyValue: isEmptyLongTextValue,
  widgets: ['textarea'] as const,
  defaultWidget: 'textarea',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<LongTextOptions>;
