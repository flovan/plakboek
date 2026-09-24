/**
 * D-46: an SEO-enabled content type gets one fixed core SEO set per locale
 * -- title, description, image, canonical override, noindex, nofollow and a
 * sitemap include flag -- stored in the entry's `seo` column. There is no
 * per-type selection: the property list is the one frozen tuple exported
 * below, never assembled from a type's own field definitions. Phase 16 owns
 * editing this shape, the sitemap and JSON-LD built from it; this module
 * only defines, defaults and validates the shape itself.
 */
import { z } from 'zod';
import { ASSET_ID_PATTERN } from './field-types/image.js';

/** Reuses this phase's short-text label cap for consistency across
 * editor-facing title fields. */
export const SEO_TITLE_MAX_LENGTH = 200;

/** Above the ~160 characters search engines typically render -- truncation
 * is a Phase 16 presentation concern the engine should warn about, not
 * reject content an editor deliberately wrote. */
export const SEO_DESCRIPTION_MAX_LENGTH = 320;

/** Matches the `url` field type's own absolute-URL length cap
 * (`URL_MAX_LENGTH`). */
export const SEO_CANONICAL_MAX_LENGTH = 2048;

/** The closed D-46 property set, in stored/validated order. This is the
 * only place the set is defined -- no caller option ever selects a subset,
 * which is D-46's "no per-type selection". */
export const ENTRY_SEO_PROPERTIES = Object.freeze([
  'title',
  'description',
  'imageAssetId',
  'canonicalUrl',
  'noindex',
  'nofollow',
  'sitemapInclude',
] as const);

export type EntrySeoProperty = (typeof ENTRY_SEO_PROPERTIES)[number];

const ENTRY_SEO_PROPERTY_SET: ReadonlySet<string> = new Set(
  ENTRY_SEO_PROPERTIES,
);

/** The closed, per-locale SEO shape stored in `content_entries.seo` /
 * `entry_revisions.seo`. Always complete once returned by
 * `normalizeEntrySeo`/`validateEntrySeo` -- readers never branch on
 * absence. */
export type EntrySeo = Readonly<{
  title: string | null;
  description: string | null;
  imageAssetId: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  nofollow: boolean;
  sitemapInclude: boolean;
}>;

/** The documented defaults: four nulls, both robots flags false,
 * `sitemapInclude` true -- opting a type into SEO is itself the opt-in
 * (TYPE-09), so hiding one entry from the sitemap is the deliberate
 * exception, not the default. */
export const EMPTY_ENTRY_SEO: EntrySeo = Object.freeze({
  title: null,
  description: null,
  imageAssetId: null,
  canonicalUrl: null,
  noindex: false,
  nofollow: false,
  sitemapInclude: true,
});

const TEXT_PROPERTIES = Object.freeze([
  'title',
  'description',
  'imageAssetId',
  'canonicalUrl',
] as const);
type TextProperty = (typeof TEXT_PROPERTIES)[number];

const FLAG_PROPERTIES = Object.freeze([
  'noindex',
  'nofollow',
  'sitemapInclude',
] as const);
type FlagProperty = (typeof FLAG_PROPERTIES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trims a stored/submitted string and collapses an empty result to
 * `null`, so "cleared" and "never set" are one state (D-46). */
function collapseBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeTextProperty(
  source: Record<string, unknown>,
  key: TextProperty,
): string | null {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return EMPTY_ENTRY_SEO[key];
  }
  if (typeof raw !== 'string') {
    return EMPTY_ENTRY_SEO[key];
  }
  return collapseBlank(raw);
}

function normalizeFlagProperty(
  source: Record<string, unknown>,
  key: FlagProperty,
): boolean {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return EMPTY_ENTRY_SEO[key];
  }
  return typeof raw === 'boolean' ? raw : EMPTY_ENTRY_SEO[key];
}

/**
 * Turns a `null`, `undefined` or partial stored value into a complete
 * `EntrySeo`, filling only the absent properties from `EMPTY_ENTRY_SEO` and
 * leaving present ones alone. Never throws -- use it for reads of a column
 * that may predate a save (a row that has never been saved keeps SQL
 * `NULL`). Applying it to its own output returns an equal value.
 */
export function normalizeEntrySeo(value: unknown): EntrySeo {
  const source = isPlainObject(value) ? value : {};
  return Object.freeze({
    title: normalizeTextProperty(source, 'title'),
    description: normalizeTextProperty(source, 'description'),
    imageAssetId: normalizeTextProperty(source, 'imageAssetId'),
    canonicalUrl: normalizeTextProperty(source, 'canonicalUrl'),
    noindex: normalizeFlagProperty(source, 'noindex'),
    nofollow: normalizeFlagProperty(source, 'nofollow'),
    sitemapInclude: normalizeFlagProperty(source, 'sitemapInclude'),
  });
}

export type EntrySeoIssueCode =
  | 'INVALID_SEO_VALUE'
  | 'SEO_NOT_ENABLED'
  | 'UNKNOWN_PROPERTY'
  | 'INVALID_TITLE'
  | 'TITLE_TOO_LONG'
  | 'INVALID_DESCRIPTION'
  | 'DESCRIPTION_TOO_LONG'
  | 'INVALID_IMAGE_ASSET_ID'
  | 'INVALID_CANONICAL_URL'
  | 'INVALID_FLAG';

/** Never carries the submitted value -- only the property and issue code
 * (T-02-06-style redaction discipline, matching `FieldValidationIssue`). */
export type EntrySeoIssue = Readonly<{
  code: EntrySeoIssueCode;
  property: string | null;
  message: string;
}>;

/** Thrown by `validateEntrySeo` with every problem found, collected before
 * throwing once -- mirrors `FieldValidationError` and `RoleConfigError`. */
export class EntrySeoValidationError extends Error {
  readonly issues: readonly EntrySeoIssue[];

  constructor(issues: readonly EntrySeoIssue[]) {
    super(
      [
        '@plakboek/content: entry SEO failed validation',
        ...issues.map(
          (issue) => `- ${issue.property ?? '(value)'} (${issue.code})`,
        ),
      ].join('\n'),
    );
    this.name = 'EntrySeoValidationError';
    this.issues = issues;
  }
}

/** Mirrors the `url` field type's absolute-http(s)-only rule (T-03-55):
 * any other scheme, and any protocol-relative or path-only value, is
 * rejected -- `z.url()` requires a full absolute URL, so `//evil.example`
 * and `/about` never parse. */
const CANONICAL_PROTOCOL_PATTERN = /^https?$/;
const canonicalUrlSchema = z.url({ protocol: CANONICAL_PROTOCOL_PATTERN });

function isAbsoluteHttpUrl(value: string): boolean {
  return canonicalUrlSchema.safeParse(value).success;
}

function validateLengthLimitedText(
  source: Record<string, unknown>,
  key: 'title' | 'description',
  maxLength: number,
  invalidCode: EntrySeoIssueCode,
  tooLongCode: EntrySeoIssueCode,
  issues: EntrySeoIssue[],
): string | null {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    issues.push({
      code: invalidCode,
      property: key,
      message: `"${key}" must be a string`,
    });
    return null;
  }
  const collapsed = collapseBlank(raw);
  if (collapsed === null) {
    return null;
  }
  // Unicode code points, not UTF-16 units, so an astral title of exactly
  // the limit still passes (TYPE-09 encoding edge).
  if (Array.from(collapsed).length > maxLength) {
    issues.push({
      code: tooLongCode,
      property: key,
      message: `"${key}" must be at most ${maxLength} code points`,
    });
    return null;
  }
  return collapsed;
}

function validateImageAssetId(
  source: Record<string, unknown>,
  issues: EntrySeoIssue[],
): string | null {
  const raw = source.imageAssetId;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === 'string' && ASSET_ID_PATTERN.test(raw)) {
    return raw;
  }
  issues.push({
    code: 'INVALID_IMAGE_ASSET_ID',
    property: 'imageAssetId',
    message: '"imageAssetId" must be a valid opaque asset id',
  });
  return null;
}

function validateCanonicalUrl(
  source: Record<string, unknown>,
  issues: EntrySeoIssue[],
): string | null {
  const raw = source.canonicalUrl;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    issues.push({
      code: 'INVALID_CANONICAL_URL',
      property: 'canonicalUrl',
      message: '"canonicalUrl" must be a string',
    });
    return null;
  }
  const collapsed = collapseBlank(raw);
  if (collapsed === null) {
    return null;
  }
  if (collapsed.length > SEO_CANONICAL_MAX_LENGTH) {
    issues.push({
      code: 'INVALID_CANONICAL_URL',
      property: 'canonicalUrl',
      message: `"canonicalUrl" must be at most ${SEO_CANONICAL_MAX_LENGTH} characters`,
    });
    return null;
  }
  if (!isAbsoluteHttpUrl(collapsed)) {
    issues.push({
      code: 'INVALID_CANONICAL_URL',
      property: 'canonicalUrl',
      message: '"canonicalUrl" must be an absolute http or https URL',
    });
    return null;
  }
  return collapsed;
}

function validateFlag(
  source: Record<string, unknown>,
  key: FlagProperty,
  issues: EntrySeoIssue[],
): boolean {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return EMPTY_ENTRY_SEO[key];
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  issues.push({
    code: 'INVALID_FLAG',
    property: key,
    message: `"${key}" must be a boolean`,
  });
  return EMPTY_ENTRY_SEO[key];
}

function isEmptyEntrySeo(value: EntrySeo): boolean {
  return ENTRY_SEO_PROPERTIES.every(
    (key) => value[key] === EMPTY_ENTRY_SEO[key],
  );
}

/**
 * Validates and normalizes a submitted `seo` value against D-46's fixed
 * set. Collects every problem before throwing once as
 * `EntrySeoValidationError`; on success returns a frozen `EntrySeo` with
 * all seven properties present.
 *
 * When `options.seoEnabled` is `false`, only a value that normalizes equal
 * to `EMPTY_ENTRY_SEO` is accepted -- a content type that never opted into
 * SEO cannot accumulate SEO values (TYPE-09).
 */
export function validateEntrySeo(
  value: unknown,
  options: { seoEnabled: boolean },
): EntrySeo {
  if (value !== null && value !== undefined && !isPlainObject(value)) {
    throw new EntrySeoValidationError([
      {
        code: 'INVALID_SEO_VALUE',
        property: null,
        message: 'entry seo must be a plain object, null or undefined',
      },
    ]);
  }

  const issues: EntrySeoIssue[] = [];
  const source: Record<string, unknown> = isPlainObject(value) ? value : {};

  const title = validateLengthLimitedText(
    source,
    'title',
    SEO_TITLE_MAX_LENGTH,
    'INVALID_TITLE',
    'TITLE_TOO_LONG',
    issues,
  );
  const description = validateLengthLimitedText(
    source,
    'description',
    SEO_DESCRIPTION_MAX_LENGTH,
    'INVALID_DESCRIPTION',
    'DESCRIPTION_TOO_LONG',
    issues,
  );
  const imageAssetId = validateImageAssetId(source, issues);
  const canonicalUrl = validateCanonicalUrl(source, issues);
  const noindex = validateFlag(source, 'noindex', issues);
  const nofollow = validateFlag(source, 'nofollow', issues);
  const sitemapInclude = validateFlag(source, 'sitemapInclude', issues);

  for (const key of Object.keys(source)) {
    if (!ENTRY_SEO_PROPERTY_SET.has(key)) {
      issues.push({
        code: 'UNKNOWN_PROPERTY',
        property: key,
        message: `"${key}" is not a recognized SEO property`,
      });
    }
  }

  const result: EntrySeo = Object.freeze({
    title,
    description,
    imageAssetId,
    canonicalUrl,
    noindex,
    nofollow,
    sitemapInclude,
  });

  if (!options.seoEnabled && !isEmptyEntrySeo(result)) {
    issues.push({
      code: 'SEO_NOT_ENABLED',
      property: null,
      message: 'content type does not have SEO enabled',
    });
  }

  if (issues.length > 0) {
    throw new EntrySeoValidationError(issues);
  }

  return result;
}
