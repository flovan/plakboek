/**
 * The shape of a theme token name: a lowercase identifier a palette entry,
 * a size entry or a CTA variant is addressed by. Stored documents carry the
 * token, never the CSS behind it, so this pattern is also what keeps a
 * stored value from smuggling anything into a stylesheet.
 */
export const TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const CUSTOM_SIZE_MIN = 8;
export const CUSTOM_SIZE_MAX = 200;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SIZE_INPUT = /^\s*(\d{1,4})\s*(?:px)?\s*$/i;
const STORED_SIZE = /^[1-9]\d{0,2}px$/;

/** True for a 3, 4, 6 or 8 digit hex colour written exactly as stored. */
export function isCustomColorValue(value: string): boolean {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** A typed colour literal, trimmed and otherwise as typed; null if it is not a hex colour. */
export function parseCustomColor(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return isCustomColorValue(trimmed) ? trimmed : null;
}

function isSizeInRange(size: number): boolean {
  return (
    Number.isInteger(size) && size >= CUSTOM_SIZE_MIN && size <= CUSTOM_SIZE_MAX
  );
}

/** True for a stored size literal: whole px between the bounds, no leading zero. */
export function isCustomSizeValue(value: string): boolean {
  if (typeof value !== 'string' || !STORED_SIZE.test(value)) return false;
  return isSizeInRange(Number.parseInt(value, 10));
}

/**
 * A typed size as `${n}px`, for a whole number of px between
 * `CUSTOM_SIZE_MIN` and `CUSTOM_SIZE_MAX` given as a number or as text with
 * an optional `px`; null otherwise.
 */
export function parseCustomSize(input: string | number): string | null {
  if (typeof input === 'number') {
    return isSizeInRange(input) ? `${input}px` : null;
  }
  if (typeof input !== 'string') return null;
  const match = SIZE_INPUT.exec(input);
  if (match === null) return null;
  const size = Number.parseInt(match[1] ?? '', 10);
  return isSizeInRange(size) ? `${size}px` : null;
}
