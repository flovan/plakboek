/**
 * The `repeater` field type (D-34): a fixed list of sub-fields, each any
 * field type except `repeater` -- repeaters don't nest. Nesting is refused
 * by the same generic `allowedInRepeater` check every other disallowed type
 * goes through: `repeaterFieldType.allowedInRepeater` is `false` (enforced
 * package-wide by `field-registry.test.ts`), so a repeater sub-field naming
 * `fieldType: 'repeater'` is rejected without a repeater-specific special
 * case. Sub-field values are validated the same way a content type's own
 * fields are: an empty value is checked against `required`, a present value
 * is validated by the sub-field's own value schema, and issues carry a path
 * of `[itemIndex, subFieldKey, ...]` under the field's own key.
 *
 * `getFieldTypeDefinition`/`isFieldType` are imported as real values from
 * `registry.ts`, which in turn imports this module to register it --
 * `registry.ts` -> `repeater.ts` -> `registry.ts`. This is harmless because
 * this module never calls them at its own top level: `repeaterOptionsSchema`
 * only *stores* the `superRefine`/`transform` callbacks below, it doesn't
 * invoke them, so by the time anything actually calls into the registry
 * (well after both modules have finished loading), every binding is fully
 * initialized.
 */
import { z } from 'zod';
import {
  getFieldTypeDefinition,
  isFieldType,
  type FieldTypeDefinition,
} from './registry.js';

export const REPEATER_MAX_ITEMS = 200;

// Mirrors `FIELD_KEY_PATTERN` in `../fields.js`, duplicated rather than
// imported so this module never depends on `fields.ts` (which itself
// depends on `registry.ts`) -- keeping the registry-to-repeater cycle
// documented above to the two modules it names, not a third.
const SUB_FIELD_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

const repeaterSubFieldSchema = z.strictObject({
  key: z.string().regex(SUB_FIELD_KEY_PATTERN, 'must be a valid field key'),
  label: z.string().min(1),
  fieldType: z.string(),
  required: z.boolean().optional(),
  options: z.unknown().optional(),
  widget: z.string().optional(),
});

type RepeaterSubField = z.infer<typeof repeaterSubFieldSchema>;

const repeaterOptionsSchema = z
  .strictObject({
    fields: z.array(repeaterSubFieldSchema).min(1),
    minItems: z.int().min(0).optional(),
    maxItems: z.int().min(1).max(REPEATER_MAX_ITEMS).optional(),
  })
  .superRefine((options, ctx) => {
    const seenKeys = new Set<string>();
    for (const [index, field] of options.fields.entries()) {
      if (seenKeys.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: `sub-field key "${field.key}" is used more than once`,
        });
      }
      seenKeys.add(field.key);

      if (!isFieldType(field.fieldType)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'fieldType'],
          message: `unknown field type "${field.fieldType}"`,
        });
        continue;
      }
      const definition = getFieldTypeDefinition(field.fieldType);
      if (!definition.allowedInRepeater) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'fieldType'],
          message: `field type "${field.fieldType}" is not allowed inside a repeater`,
        });
        continue;
      }
      const parsedOptions = definition.optionsSchema.safeParse(
        field.options ?? {},
      );
      if (!parsedOptions.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: `invalid options for sub-field "${field.key}": ${parsedOptions.error.issues
            .map((issue) => issue.message)
            .join('; ')}`,
        });
        continue;
      }
      const widget = field.widget ?? definition.defaultWidget;
      if (!definition.widgets.includes(widget)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'widget'],
          message: `widget "${widget}" is not one of "${field.fieldType}"'s widgets`,
        });
      }
    }
    if (
      options.minItems !== undefined &&
      options.maxItems !== undefined &&
      options.minItems > options.maxItems
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minItems'],
        message: 'minItems must be less than or equal to maxItems',
      });
    }
  });

type RepeaterOptions = z.infer<typeof repeaterOptionsSchema>;

type ResolvedSubField = {
  readonly key: string;
  readonly required: boolean;
  readonly definition: FieldTypeDefinition<unknown>;
  readonly options: unknown;
};

function resolveSubFields(
  fields: readonly RepeaterSubField[],
): readonly ResolvedSubField[] {
  const resolved: ResolvedSubField[] = [];
  for (const field of fields) {
    if (!isFieldType(field.fieldType) || field.fieldType === 'repeater') {
      continue;
    }
    const definition = getFieldTypeDefinition(field.fieldType);
    resolved.push({
      key: field.key,
      required: field.required === true,
      definition,
      options: definition.optionsSchema.parse(field.options ?? {}),
    });
  }
  return resolved;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildRepeaterValueSchema(options: RepeaterOptions): z.ZodType {
  const subFields = resolveSubFields(options.fields);
  const knownKeys = new Set(subFields.map((subField) => subField.key));

  let itemsSchema = z.array(z.unknown());
  if (options.minItems !== undefined) {
    itemsSchema = itemsSchema.min(options.minItems);
  }
  if (options.maxItems !== undefined) {
    itemsSchema = itemsSchema.max(options.maxItems);
  }

  return itemsSchema.transform((items, ctx) =>
    items.map((item, itemIndex) => {
      if (!isPlainObject(item)) {
        ctx.addIssue({
          code: 'custom',
          path: [itemIndex],
          message: 'a repeater item must be a plain object',
        });
        return {};
      }

      for (const key of Object.keys(item)) {
        if (!knownKeys.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [itemIndex, key],
            message: `"${key}" does not match any sub-field on this repeater`,
          });
        }
      }

      const result: Record<string, unknown> = {};
      for (const subField of subFields) {
        const value = item[subField.key];
        if (subField.definition.isEmptyValue(value)) {
          if (subField.required) {
            ctx.addIssue({
              code: 'custom',
              path: [itemIndex, subField.key],
              message: `"${subField.key}" is required`,
            });
          }
          continue;
        }
        const parsed = subField.definition
          .buildValueSchema(subField.options)
          .safeParse(value);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              code: 'custom',
              path: [itemIndex, subField.key, ...issue.path],
              message: issue.message,
            });
          }
          continue;
        }
        result[subField.key] = parsed.data;
      }
      return result;
    }),
  );
}

function isEmptyRepeaterValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

export const repeaterFieldType = {
  fieldType: 'repeater',
  optionsSchema: repeaterOptionsSchema,
  buildValueSchema: buildRepeaterValueSchema,
  isEmptyValue: isEmptyRepeaterValue,
  widgets: ['repeater-list'] as const,
  defaultWidget: 'repeater-list',
  allowedInRepeater: false,
} satisfies FieldTypeDefinition<RepeaterOptions>;
