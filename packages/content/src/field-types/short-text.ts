/**
 * The `short_text` field type: single-line text, no `\r`/`\n`, an optional
 * min/max length and an optional whole-value `pattern` (T-03-12: guarded at
 * define time by `isSafePattern`, never compiled per-request against an
 * unvalidated expression).
 *
 * Exports a plain `FieldTypeDefinition` object; `registry.ts` is the one
 * place that calls `registerFieldType`, so this module only ever imports
 * the *type* of `FieldTypeDefinition` back (`import type`, erased at
 * compile time, never a runtime value) -- no circular import.
 */
import { z } from 'zod';
import { isSafePattern } from './pattern-safety.js';
import type { FieldTypeDefinition } from './registry.js';

export const SHORT_TEXT_MAX_LENGTH = 1000;

const shortTextOptionsSchema = z
  .strictObject({
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).max(SHORT_TEXT_MAX_LENGTH).optional(),
    pattern: z.string().optional(),
  })
  .refine(
    (options) =>
      options.minLength === undefined ||
      options.maxLength === undefined ||
      options.minLength <= options.maxLength,
    { message: 'minLength must be less than or equal to maxLength' },
  )
  .refine(
    (options) =>
      options.pattern === undefined || isSafePattern(options.pattern),
    { message: 'pattern is not a safe regular expression', path: ['pattern'] },
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
  if (options.pattern !== undefined) {
    // Compiled once per `buildValueSchema` call (per field, not per value):
    // the pattern already passed `isSafePattern` when the field was
    // defined, so this is a bounded-cost, whole-value match (`^(?:...)$`).
    const wholeValuePattern = new RegExp(`^(?:${options.pattern})$`, 'u');
    schema = schema.regex(
      wholeValuePattern,
      'does not match the configured pattern',
    );
  }
  return schema;
}

function isEmptyShortTextValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const shortTextFieldType = {
  fieldType: 'short_text',
  optionsSchema: shortTextOptionsSchema,
  buildValueSchema: buildShortTextValueSchema,
  isEmptyValue: isEmptyShortTextValue,
  widgets: ['text-input'] as const,
  defaultWidget: 'text-input',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<ShortTextOptions>;
