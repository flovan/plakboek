/**
 * The `date_time` field type (D-36): `instant` mode (default) stores a UTC
 * instant, normalised from any valid offset to `...Z`; `date` mode stores a
 * plain `YYYY-MM-DD` with no timezone, so the calendar date never shifts.
 * `min`/`max` are supplied in the same format as `mode` and compare
 * inclusively.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

const INSTANT_FORMAT_SCHEMA = z.iso.datetime({ offset: true });
const DATE_FORMAT_SCHEMA = z.iso.date();

const dateTimeOptionsSchema = z
  .strictObject({
    mode: z.enum(['instant', 'date']).default('instant'),
    min: z.string().optional(),
    max: z.string().optional(),
  })
  .superRefine((options, ctx) => {
    const boundsFormat =
      options.mode === 'instant' ? INSTANT_FORMAT_SCHEMA : DATE_FORMAT_SCHEMA;
    for (const key of ['min', 'max'] as const) {
      const value = options[key];
      if (value !== undefined && !boundsFormat.safeParse(value).success) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be a valid ${options.mode} value`,
        });
      }
    }
    const minValid =
      options.min !== undefined && boundsFormat.safeParse(options.min).success;
    const maxValid =
      options.max !== undefined && boundsFormat.safeParse(options.max).success;
    if (minValid && maxValid) {
      // Non-null assertions would be needed here without these locals;
      // both are narrowed non-undefined by minValid/maxValid above.
      const min = options.min ?? '';
      const max = options.max ?? '';
      const minOrdinal =
        options.mode === 'instant' ? new Date(min).getTime() : min;
      const maxOrdinal =
        options.mode === 'instant' ? new Date(max).getTime() : max;
      if (minOrdinal > maxOrdinal) {
        ctx.addIssue({
          code: 'custom',
          path: ['min'],
          message: 'min must be less than or equal to max',
        });
      }
    }
  });

type DateTimeOptions = z.infer<typeof dateTimeOptionsSchema>;

function buildDateTimeValueSchema(options: DateTimeOptions): z.ZodType {
  if (options.mode === 'date') {
    let schema: z.ZodType<string> = DATE_FORMAT_SCHEMA;
    if (options.min !== undefined) {
      const min = options.min;
      schema = schema.refine((value) => value >= min, {
        message: `must be on or after ${min}`,
      });
    }
    if (options.max !== undefined) {
      const max = options.max;
      schema = schema.refine((value) => value <= max, {
        message: `must be on or before ${max}`,
      });
    }
    return schema;
  }

  let instantSchema: z.ZodType<string> = INSTANT_FORMAT_SCHEMA;
  if (options.min !== undefined) {
    const minTime = new Date(options.min).getTime();
    instantSchema = instantSchema.refine(
      (value) => new Date(value).getTime() >= minTime,
      { message: `must be on or after ${options.min}` },
    );
  }
  if (options.max !== undefined) {
    const maxTime = new Date(options.max).getTime();
    instantSchema = instantSchema.refine(
      (value) => new Date(value).getTime() <= maxTime,
      { message: `must be on or before ${options.max}` },
    );
  }
  return instantSchema.transform((value) => new Date(value).toISOString());
}

function isEmptyDateTimeValue(value: unknown): boolean {
  return value === undefined || value === null;
}

export const dateTimeFieldType = {
  fieldType: 'date_time',
  optionsSchema: dateTimeOptionsSchema,
  buildValueSchema: buildDateTimeValueSchema,
  isEmptyValue: isEmptyDateTimeValue,
  widgets: ['datetime-picker', 'date-picker'] as const,
  defaultWidget: 'datetime-picker',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<DateTimeOptions>;
