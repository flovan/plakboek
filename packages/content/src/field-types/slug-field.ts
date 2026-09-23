/**
 * The `slug` field type (FIELD-02, D-37): short text constrained to slug
 * format, for secondary identifiers such as anchors. This has no
 * uniqueness or routing meaning -- only the system slug on
 * `content_entries.slug` routes and must be unique.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../slug.js';
import type { FieldTypeDefinition } from './registry.js';

const SLUG_VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugFieldOptionsSchema = z.strictObject({
  maxLength: z.int().min(1).max(SLUG_MAX_LENGTH).optional(),
});

type SlugFieldOptions = z.infer<typeof slugFieldOptionsSchema>;

function buildSlugFieldValueSchema(options: SlugFieldOptions): z.ZodType {
  return z
    .string()
    .max(options.maxLength ?? SLUG_MAX_LENGTH)
    .regex(SLUG_VALUE_PATTERN, 'must be lowercase, hyphenated slug text');
}

function isEmptySlugFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const slugFieldFieldType = {
  fieldType: 'slug',
  optionsSchema: slugFieldOptionsSchema,
  buildValueSchema: buildSlugFieldValueSchema,
  isEmptyValue: isEmptySlugFieldValue,
  widgets: ['slug-input'] as const,
  defaultWidget: 'slug-input',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<SlugFieldOptions>;
