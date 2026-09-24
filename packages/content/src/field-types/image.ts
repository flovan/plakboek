/**
 * The `image` field type (D-41): an opaque media asset id, validated for
 * shape only. Phase 12 adds the media table, existence checks and usage
 * tracking (MEDIA-08); no placeholder media table ships now.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

export const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const imageOptionsSchema = z.strictObject({});

type ImageOptions = z.infer<typeof imageOptionsSchema>;

function buildImageValueSchema(_options: ImageOptions): z.ZodType {
  return z.string().regex(ASSET_ID_PATTERN, 'must be a valid asset id');
}

function isEmptyImageValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const imageFieldType = {
  fieldType: 'image',
  optionsSchema: imageOptionsSchema,
  buildValueSchema: buildImageValueSchema,
  isEmptyValue: isEmptyImageValue,
  widgets: ['image-picker'] as const,
  defaultWidget: 'image-picker',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<ImageOptions>;
