/**
 * Slug normalisation (TYPE-03): hand-rolled NFKD diacritic strip, no
 * dependency. Handles the diacritics 03-CONTEXT names (é, ë, ï) by Unicode
 * decomposition; Dutch "ij" needs no special case -- it is already two
 * plain ASCII letters. Plan 03-04 adds entry slug uniqueness on top of this
 * normaliser.
 */
export const SLUG_MAX_LENGTH = 200;

const COMBINING_MARKS_PATTERN = /\p{M}+/gu;
const NON_SLUG_CHARACTER_RUN_PATTERN = /[^a-z0-9]+/g;
const LEADING_OR_TRAILING_HYPHENS_PATTERN = /^-+|-+$/g;

/**
 * NFKD-normalises, strips combining marks, lowercases, collapses every run
 * of non `[a-z0-9]` characters to a single hyphen, trims leading/trailing
 * hyphens, and truncates to `SLUG_MAX_LENGTH` (trimming a trailing hyphen
 * left by the cut). Returns `''` when nothing survives.
 */
export function normalizeSlug(input: string): string {
  const decomposed = input
    .normalize('NFKD')
    .replace(COMBINING_MARKS_PATTERN, '')
    .toLowerCase()
    .replace(NON_SLUG_CHARACTER_RUN_PATTERN, '-')
    .replace(LEADING_OR_TRAILING_HYPHENS_PATTERN, '');

  const truncated = decomposed.slice(0, SLUG_MAX_LENGTH);
  return truncated.replace(LEADING_OR_TRAILING_HYPHENS_PATTERN, '');
}
