/**
 * The `file` field type (D-41): an opaque media asset id, validated for
 * shape only, identical in shape to `image` but presented with its own
 * widget. Phase 12 adds the media table, existence checks and usage
 * tracking (MEDIA-08); no placeholder media table ships now.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import { ASSET_ID_PATTERN } from './image.js';
import type { FieldTypeDefinition } from './registry.js';

const fileOptionsSchema = z.strictObject({});

type FileOptions = z.infer<typeof fileOptionsSchema>;

function buildFileValueSchema(_options: FileOptions): z.ZodType {
  return z.string().regex(ASSET_ID_PATTERN, 'must be a valid asset id');
}

function isEmptyFileValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const fileFieldType = {
  fieldType: 'file',
  optionsSchema: fileOptionsSchema,
  buildValueSchema: buildFileValueSchema,
  isEmptyValue: isEmptyFileValue,
  widgets: ['file-picker'] as const,
  defaultWidget: 'file-picker',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<FileOptions>;
