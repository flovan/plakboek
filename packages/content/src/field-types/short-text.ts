/**
 * The `short_text` field type: single-line text, no `\r`/`\n`, an optional
 * min/max length. Plan 03-03 adds the `pattern` option.
 *
 * Exports a plain `FieldTypeDefinition` object; `registry.ts` is the one
 * place that calls `registerFieldType`, so this module only ever imports
 * the *type* of `FieldTypeDefinition` back (`import type`, erased at
 * compile time, never a runtime value) -- no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

export const SHORT_TEXT_MAX_LENGTH = 1000;

const shortTextOptionsSchema = z
  .strictObject({
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).max(SHORT_TEXT_MAX_LENGTH).optional(),
  })
  .refine(
    (options) =>
      options.minLength === undefined ||
      options.maxLength === undefined ||
      options.minLength <= options.maxLength,
    { message: 'minLength must be less than or equal to maxLength' },
  );

type ShortTextOptions = z.infer<typeof shortTextOptionsSchema>;

const NO_LINE_BREAKS_PATTERN = /^[^\r\n]*$/;

function buildShortTextValueSchema(options: ShortTextOptions): z.ZodType {
  let schema = z
    .string()
    .regex(NO_LINE_BREAKS_PATTERN, 'must not contain a line break')
    .max(options.maxLength ?? SHORT_TEXT_MAX_LENGTH);
  if (options.minLength !== undefined) {
    schema = schema.min(options.minLength);
  }
  return schema;
}

function isEmptyShortTextValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const shortTextFieldType: FieldTypeDefinition<ShortTextOptions> = {
  fieldType: 'short_text',
  optionsSchema: shortTextOptionsSchema,
  buildValueSchema: buildShortTextValueSchema,
  isEmptyValue: isEmptyShortTextValue,
  widgets: ['text-input'],
  defaultWidget: 'text-input',
  allowedInRepeater: true,
};
