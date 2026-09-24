/**
 * The `select` field type (D-35): choices carry a stable `value`, which is
 * what an entry stores, and a `label` translated per content locale.
 * Relabelling or retranslating a choice never touches stored data.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import { LOCALE_PATTERN } from '../config.js';
import type { FieldTypeDefinition } from './registry.js';

export const CHOICE_VALUE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const choiceSchema = z.strictObject({
  value: z.string().regex(CHOICE_VALUE_PATTERN, 'must be a valid choice value'),
  labels: z.record(
    z.string().regex(LOCALE_PATTERN, 'must be a valid locale'),
    z.string().min(1, 'must not be empty'),
  ),
});

const selectOptionsSchema = z
  .strictObject({
    choices: z.array(choiceSchema).min(1),
  })
  .refine(
    (options) =>
      new Set(options.choices.map((choice) => choice.value)).size ===
      options.choices.length,
    { message: 'choice values must be distinct', path: ['choices'] },
  );

type SelectOptions = z.infer<typeof selectOptionsSchema>;

function buildSelectValueSchema(options: SelectOptions): z.ZodType {
  const values = new Set(options.choices.map((choice) => choice.value));
  return z.string().refine((value) => values.has(value), {
    message: 'must be one of the configured choices',
  });
}

function isEmptySelectValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const selectFieldType = {
  fieldType: 'select',
  optionsSchema: selectOptionsSchema,
  buildValueSchema: buildSelectValueSchema,
  isEmptyValue: isEmptySelectValue,
  widgets: ['dropdown', 'radio'] as const,
  defaultWidget: 'dropdown',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<SelectOptions>;
