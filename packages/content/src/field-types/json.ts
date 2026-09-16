/**
 * The `json` field type: any JSON-encodable value, size-capped -- no
 * user-authored schema constraint (RESEARCH.md open question 2's v1 scope).
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

export const JSON_FIELD_MAX_BYTES = 65536;

const jsonFieldOptionsSchema = z.strictObject({});

type JsonFieldOptions = z.infer<typeof jsonFieldOptionsSchema>;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function buildJsonFieldValueSchema(_options: JsonFieldOptions): z.ZodType {
  return z
    .json()
    .refine(
      (value) => utf8ByteLength(JSON.stringify(value)) <= JSON_FIELD_MAX_BYTES,
      { message: `must be at most ${JSON_FIELD_MAX_BYTES} UTF-8 bytes` },
    );
}

function isEmptyJsonFieldValue(value: unknown): boolean {
  return value === undefined;
}

export const jsonFieldType: FieldTypeDefinition<JsonFieldOptions> = {
  fieldType: 'json',
  optionsSchema: jsonFieldOptionsSchema,
  buildValueSchema: buildJsonFieldValueSchema,
  isEmptyValue: isEmptyJsonFieldValue,
  widgets: ['json-editor'],
  defaultWidget: 'json-editor',
  allowedInRepeater: true,
};
