/**
 * The `url` field type (T-03-14): absolute `http`/`https` URLs only by
 * default; `allowRelative: true` also accepts a path starting with a single
 * `/` (never a protocol-relative `//...`, which a browser would resolve
 * against whatever scheme the current page happens to use). Any other
 * scheme, such as `javascript:`, is always rejected.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';

export const URL_MAX_LENGTH = 2048;

const urlOptionsSchema = z.strictObject({
  allowRelative: z.boolean().optional(),
});

type UrlOptions = z.infer<typeof urlOptionsSchema>;

const HTTPS_PROTOCOL_PATTERN = /^https?$/;
const SINGLE_SLASH_RELATIVE_PATTERN = /^\/(?!\/)/;

function buildUrlValueSchema(options: UrlOptions): z.ZodType {
  const absolute = z.url({ protocol: HTTPS_PROTOCOL_PATTERN });
  const base =
    options.allowRelative === true
      ? z.union([
          absolute,
          z
            .string()
            .regex(
              SINGLE_SLASH_RELATIVE_PATTERN,
              'must start with a single "/"',
            ),
        ])
      : absolute;
  return base.refine((value) => value.length <= URL_MAX_LENGTH, {
    message: `must be at most ${URL_MAX_LENGTH} characters`,
  });
}

function isEmptyUrlValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export const urlFieldType = {
  fieldType: 'url',
  optionsSchema: urlOptionsSchema,
  buildValueSchema: buildUrlValueSchema,
  isEmptyValue: isEmptyUrlValue,
  widgets: ['url-input'] as const,
  defaultWidget: 'url-input',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<UrlOptions>;
