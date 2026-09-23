/**
 * The declared list of field types (FIELD-02), kept in its own leaf module
 * with no import of any field-type definition. `registry.ts` re-exports
 * these three names, so every existing import path keeps working
 * unchanged.
 *
 * `schema.ts` reads `FIELD_TYPES` from here directly rather than from
 * `registry.ts`, because `registry.ts` imports every field-type module,
 * one of which (`reference.ts`) imports `content-types.ts`, which imports
 * `schema.ts` through `impact-reports.ts`. If `schema.ts` read `FIELD_TYPES`
 * from `registry.ts` instead, that chain would loop back into `registry.ts`
 * while it is still mid-evaluation, reading `FIELD_TYPES` before its own
 * declaration has run. Reading it from this dependency-free module instead
 * closes no cycle at all.
 */
export const FIELD_TYPES = Object.freeze([
  'short_text',
  'long_text',
  'rich_text',
  'number',
  'integer',
  'boolean',
  'date_time',
  'select',
  'multi_select',
  'image',
  'file',
  'reference',
  'json',
  'slug',
  'url',
  'repeater',
] as const);

export type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPE_SET.has(value);
}
