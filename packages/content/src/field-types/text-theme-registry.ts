/**
 * The installation's global text theme, and the effective theme of one
 * `rich_text` property.
 *
 * Block properties and content-type fields both validate rich text against
 * the theme registered here, read at validation time, so one registration
 * binds every writer (the editor API today, the MCP server later). A
 * property can only take things away from it through its `narrow` option
 * (D-06); it never widens it.
 *
 * Like the block registry, the last registration wins, so a dev reload that
 * runs the host's setup again replaces the theme instead of failing.
 */
import { z } from 'zod';
import {
  DEFAULT_TEXT_THEME,
  narrowTextTheme,
  textThemeNarrowingSchema,
  type TextTheme,
} from '../rich-text/index.js';

/** The options of a `rich_text` property: only a narrowing of the theme. */
export const richTextOptionsSchema = z.strictObject({
  narrow: textThemeNarrowingSchema.optional(),
});

export type RichTextOptions = z.infer<typeof richTextOptionsSchema>;

let currentTheme: TextTheme = DEFAULT_TEXT_THEME;

/**
 * Sets the installation's text theme. Takes only an already resolved, frozen
 * theme (from `resolveTextTheme`), so an unchecked object can never become
 * the rule every write is held to.
 */
export function registerTextTheme(theme: TextTheme): void {
  currentTheme = theme;
}

/** The registered global theme, or the lean default when none was set. */
export function getTextTheme(): TextTheme {
  return currentTheme;
}

/**
 * The theme one `rich_text` property is held to: the global theme narrowed
 * by the property's `narrow` option. Options that do not parse fall back to
 * the global theme; an options problem is reported where options are
 * validated, never from inside a value check.
 */
export function effectiveTextTheme(options: unknown): TextTheme {
  const parsed = richTextOptionsSchema.safeParse(options);
  if (!parsed.success || parsed.data.narrow === undefined) {
    return currentTheme;
  }
  return narrowTextTheme(currentTheme, parsed.data.narrow);
}
