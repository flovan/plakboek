/**
 * The `reference` field type (D-38, D-39): lists one or more allowed
 * content type keys and is single or multiple, with optional inclusive
 * `minItems`/`maxItems` on `multiple`. The stored value is the target's
 * translation group, not a locale row, so a reference can resolve per
 * reader locale (Phase 17) without pinning one language. Existence and
 * allowed-type checks against stored entries run on save in plan 03-15;
 * this module validates shape only.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import { TYPE_KEY_PATTERN } from '../content-types.js';
import type { FieldTypeDefinition } from './registry.js';

const referenceOptionsSchema = z
  .strictObject({
    allowedTypeKeys: z
      .array(
        z.string().regex(TYPE_KEY_PATTERN, 'must be a valid content type key'),
      )
      .min(1),
    cardinality: z.enum(['single', 'multiple']),
    minItems: z.int().min(0).optional(),
    maxItems: z.int().min(1).optional(),
  })
  .refine(
    (options) =>
      new Set(options.allowedTypeKeys).size === options.allowedTypeKeys.length,
    { message: 'allowedTypeKeys must be distinct', path: ['allowedTypeKeys'] },
  )
  .refine(
    (options) =>
      options.cardinality === 'multiple' ||
      (options.minItems === undefined && options.maxItems === undefined),
    {
      message:
        'minItems and maxItems are only allowed when cardinality is "multiple"',
    },
  )
  .refine(
    (options) =>
      options.minItems === undefined ||
      options.maxItems === undefined ||
      options.minItems <= options.maxItems,
    { message: 'minItems must be less than or equal to maxItems' },
  );

type ReferenceOptions = z.infer<typeof referenceOptionsSchema>;

function buildReferenceValueSchema(options: ReferenceOptions): z.ZodType {
  if (options.cardinality === 'single') {
    return z.uuid();
  }
  let schema = z.array(z.uuid());
  if (options.minItems !== undefined) {
    schema = schema.min(options.minItems);
  }
  if (options.maxItems !== undefined) {
    schema = schema.max(options.maxItems);
  }
  return schema.refine((items) => new Set(items).size === items.length, {
    message: 'reference values must be distinct',
  });
}

function isEmptyReferenceValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

export const referenceFieldType = {
  fieldType: 'reference',
  optionsSchema: referenceOptionsSchema,
  buildValueSchema: buildReferenceValueSchema,
  isEmptyValue: isEmptyReferenceValue,
  widgets: ['entry-picker'] as const,
  defaultWidget: 'entry-picker',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<ReferenceOptions>;
