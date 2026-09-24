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
// A relative value must start with exactly one "/" and hold no backslash
// anywhere. The WHATWG URL parser (implemented identically by every major
// browser and by Node's own URL) normalises a backslash to a forward slash
// inside a special-scheme URL, so "/\evil.com" resolves against a new host
// exactly like "//evil.com" does, even though it does not start with two
// slashes. Rejecting any backslash, not only one in the second position,
// is defense in depth. A path has no legitimate use for one.
const SINGLE_SLASH_RELATIVE_PATTERN = /^\/(?![/\\])[^\\]*$/;

/**
 * An origin no real site can hold, used only to resolve a candidate relative
 * value and see where it actually lands.
 */
const RELATIVE_PROBE_ORIGIN = 'https://relative.invalid';

/**
 * Whether `value` is genuinely site-relative, decided by resolving it the way
 * a browser will rather than by pattern alone.
 *
 * The pattern above is a cheap pre-filter, and on its own it is not enough.
 * The WHATWG URL parser strips ASCII TAB, LF and CR from its input BEFORE
 * parsing, so "/\t/evil.com" survives any character rule that inspects the
 * string as written and then reconstitutes itself as "//evil.com", landing on
 * a different origin. Backslash normalisation was the same class of bypass.
 *
 * Asking the parser where the value lands closes the whole class at once,
 * including whatever normalisation a future parser adds, because the question
 * is no longer "does this look relative" but "does this stay on our origin".
 */
function staysOnOrigin(value: string): boolean {
  let resolved: URL;
  try {
    resolved = new URL(value, RELATIVE_PROBE_ORIGIN);
  } catch {
    return false;
  }
  return resolved.origin === RELATIVE_PROBE_ORIGIN;
}

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
            )
            .refine(staysOnOrigin, {
              message: 'must resolve within the same origin',
            }),
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
