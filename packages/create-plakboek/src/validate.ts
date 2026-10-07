import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

// Same rule as LOCALE_PATTERN in packages/content/src/config.ts. Duplicated on
// purpose: this package has no runtime dependencies, and the starter's own
// config validation is the second line of defence if the two ever drift.
const LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

const SITE_NAME_MAX = 200;
const SITE_NAME_MESSAGE = 'Enter a site name of 1 to 200 characters.';
const FALLBACK_PACKAGE_NAME = 'plakboek-site';
const FALLBACK_SITE_NAME = 'My Plakboek Site';

function fail<T>(message: string): Result<T> {
  return { ok: false, message };
}

/**
 * A directory is usable when it does not exist or is an empty directory.
 * `label` is how the directory is named in the message (what the developer
 * typed), while `dir` is the path that is checked on disk.
 */
export function validateDirectory(
  dir: string,
  label: string = dir,
): Result<string> {
  const refusal = fail<string>(
    `"${label}" is not empty. Choose another directory or empty this one.`,
  );
  if (!existsSync(dir)) return { ok: true, value: dir };
  try {
    if (!statSync(dir).isDirectory()) return refusal;
    if (readdirSync(dir).length > 0) return refusal;
  } catch {
    return refusal;
  }
  return { ok: true, value: dir };
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** 1 to 200 characters after trimming, no control characters. */
export function validateSiteName(name: string): Result<string> {
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > SITE_NAME_MAX || hasControlCharacter(trimmed)) {
    return fail(SITE_NAME_MESSAGE);
  }
  return { ok: true, value: trimmed };
}

export function validateLocale(value: string): Result<string> {
  if (!LOCALE_PATTERN.test(value)) {
    return fail(
      `"${value}" is not a valid locale. Use a language tag such as en or nl.`,
    );
  }
  return { ok: true, value };
}

/**
 * Parse a comma-separated list of additional locales. Blank entries are
 * skipped, duplicates and the default locale are dropped, and the first
 * invalid value is named in the error.
 */
export function parseLocaleList(
  input: string,
  defaultLocale: string,
): Result<string[]> {
  const locales: string[] = [];
  for (const raw of input.split(',')) {
    const value = raw.trim();
    if (value === '') continue;
    const checked = validateLocale(value);
    if (!checked.ok) return checked;
    if (value !== defaultLocale && !locales.includes(value)) {
      locales.push(value);
    }
  }
  return { ok: true, value: locales };
}

/** The last path segment, ignoring trailing separators. */
function lastSegment(dir: string): string {
  return basename(dir);
}

/** An npm-valid package name derived from the directory name. */
export function packageNameFromDir(dir: string): string {
  const name = lastSegment(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[-._~]+/, '')
    .replace(/[-._~]+$/, '')
    .slice(0, 214);
  return name === '' ? FALLBACK_PACKAGE_NAME : name;
}

/** The Title Case of the directory name, the site name prompt default. */
export function defaultSiteName(dir: string): string {
  const words = lastSegment(dir)
    .split(/[-_.\s]+/)
    .filter((word) => word !== '');
  if (words.length === 0) return FALLBACK_SITE_NAME;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
